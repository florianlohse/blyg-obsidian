import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines, buildRules, commitMessages, scanCommits, scanHistory, scanPrBody, scanPrTitle, scanText, scanTree, withoutMergeOwner } from "../../scripts/public-scan.mjs";

// Invented values: the real private needles are never in a test.
const PUBLIC = "/home/user\nTODO-PRIVATE\nowner-example|docs/ok/\n";
const PRIVATE = "# a comment\nsecret-repo-name\nhidden@example.invalid\n";
const rules = buildRules(PUBLIC, PRIVATE);

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scan-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

describe("public-scan: the same rules for files, a PR body and commit messages", () => {
  it("passes clean content", () => {
    expect(scanTree(tree({ "src/a.ts": "export const a = 1;", "README.md": "hello" }), rules)).toEqual([]);
    expect(scanPrBody("## User-facing note\nnone", rules)).toEqual([]);
    expect(scanCommits(["R1: add a thing"], rules)).toEqual([]);
  });

  it("fails a planted private needle in a file, a PR body and a commit message", () => {
    expect(scanTree(tree({ "docs/x.md": "see the Secret-Repo-Name repo" }), rules)).toHaveLength(1);
    expect(scanPrBody("fixes it, mail hidden@example.invalid", rules)).toHaveLength(1);
    expect(scanCommits(["ok", "move code from secret-repo-name\n\nbody"], rules)).toHaveLength(1);
  });

  it("reports a private needle by number and never spells it", () => {
    const all = [
      ...scanTree(tree({ "a.md": "secret-repo-name and hidden@example.invalid" }), rules),
      ...scanPrBody("secret-repo-name", rules),
      ...scanCommits(["secret-repo-name"], rules),
      ...scanTree(tree({ "secret-repo-name/notes.md": "fine" }), rules),
    ].join("\n");
    expect(all).toContain("private needle #1");
    expect(all).toContain("private needle #2");
    expect(all).not.toContain("secret-repo-name");
    expect(all).not.toContain("hidden@example.invalid");
  });

  it("catches a needle in a path, also under a dot directory, and redacts it", () => {
    const problems = scanTree(tree({ ".hidden/secret-repo-name/a.md": "fine" }), rules);
    expect(problems).toEqual([".hidden/[private needle #1]/a.md: its path contains private needle #1"]);
  });

  it("names a generic needle, honours a path exception for files only", () => {
    expect(scanText("f", "path /home/user/x", rules, "src/a.ts")).toEqual(['f: contains forbidden string "/home/user"']);
    expect(scanTree(tree({ "docs/ok/a.md": "owner-example" }), rules)).toEqual([]);
    expect(scanTree(tree({ "docs/other/a.md": "owner-example" }), rules)).toHaveLength(1);
    expect(scanPrBody("owner-example", rules)).toHaveLength(1);
  });

  it("fails a secret shape in any of the three places", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(scanTree(tree({ "x.txt": token }), rules)).toHaveLength(1);
    expect(scanPrBody(token, rules)).toHaveLength(1);
    expect(scanCommits([token], rules)).toHaveLength(1);
  });

  it("fails closed on links and oversized files, skips binaries and .git", () => {
    const dir = tree({ "big.txt": "x".repeat(2 * 1024 * 1024 + 1), "bin.dat": "secret-repo-name\u0000", ".git/config": "secret-repo-name", "ok.txt": "fine" });
    symlinkSync("ok.txt", join(dir, "link.txt"));
    const problems = scanTree(dir, rules);
    expect(problems.sort()).toEqual(["big.txt: larger than 2097152 bytes, not scanned", "link.txt: is a link"]);
  });

  it("reads the commit messages of a range from git", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-git-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a"), "1");
    git("add", "a");
    git("commit", "-qm", "first");
    writeFileSync(join(dir, "a"), "2");
    git("commit", "-qam", "second: mentions secret-repo-name\n\nmore text");
    expect(commitMessages("HEAD~1..HEAD", dir)).toEqual(["second: mentions secret-repo-name\n\nmore text"]);
    expect(scanCommits(commitMessages("HEAD~1..HEAD", dir), rules)).toHaveLength(1);
  });

  it("the command line refuses to run without needles or without the private ones when required", () => {
    const run = (args: string[], env: Record<string, string>) => {
      try {
        execFileSync("node", ["scripts/public-scan.mjs", ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", stdio: "pipe" });
        return 0;
      } catch (e) { return (e as { status: number }).status; }
    };
    const dir = tree({ "a.txt": "fine" });
    expect(run(["--tree", dir], {})).toBe(0);
    expect(run(["--tree", dir, "--require-private"], {})).toBe(2);
    expect(run(["--tree", dir, "--require-private"], { PRIVATE_NEEDLES: "x-private" })).toBe(0);
    expect(run(["--tree", tree({ "a.txt": "x-private" })], { PRIVATE_NEEDLES: "x-private" })).toBe(1);
    expect(run([], {})).toBe(2);
    expect(run(["--tree", dir, "--needles", "/nonexistent"], {})).toBe(2);
  });
});

// Findings of the rehearsal (2026-11-09), each with the scenario that exposed it.
describe("public-scan: what the rehearsal found", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    try { return { status: 0, out: execFileSync("node", ["scripts/public-scan.mjs", ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", stdio: "pipe" }) }; }
    catch (e) { const x = e as { status: number; stderr: string }; return { status: x.status, out: x.stderr }; }
  };
  function repoWith(steps: { files?: Record<string, string>; remove?: string[]; message: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    for (const st of steps) {
      for (const [p, c] of Object.entries(st.files ?? {})) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
      for (const p of st.remove ?? []) rmSync(join(dir, p));
      git("add", "-A");
      git("commit", "-q", "-m", st.message);
    }
    return dir;
  }

  it("F1: a private line that repeats a generic needle is dropped, so the private list may be the whole old list", () => {
    const r = buildRules("/home/user | a.txt\nTODO-PRIVATE\n", "# comment\n/home/user\nsecret-x\ntodo-private\nsecret-y\nsecret-x\n");
    expect(r.map((x) => [x.needle, !!x.private, x.n])).toEqual([["/home/user", false, undefined], ["todo-private", false, undefined], ["secret-x", true, 1], ["secret-y", true, 2]]);
    expect(scanText("f", "TODO-PRIVATE here", r)).toEqual(['f: contains forbidden string "todo-private"']); // reported once, by name
    const dir = tree({ "a.txt": "fine" });
    expect(cli(["--tree", dir, "--require-private"], { PRIVATE_NEEDLES: "/home/user\nTODO-PRIVATE\n" }).status).toBe(2); // only generic lines: no private needle at all
  });

  it("F4: the owner in GitHub's merge-commit subject is not a hit, the branch name still is", () => {
    expect(withoutMergeOwner("Merge pull request #12 from some-owner/feature-x\n\nbody")).toBe("Merge pull request #12 from feature-x\n\nbody");
    expect(withoutMergeOwner("Fix: from some-owner/x")).toBe("Fix: from some-owner/x"); // only GitHub's own subject shape
    const r = buildRules("", "secret-owner\nsecret-repo-name\n");
    expect(scanCommits(["Merge pull request #3 from secret-owner/feature-y\n\nRelease 1.0.0"], r)).toEqual([]);
    expect(scanCommits(["Merge pull request #3 from secret-owner/secret-repo-name"], r)).toHaveLength(1);
    expect(scanCommits(["Fix: from secret-owner/x"], r)).toHaveLength(1);
  });

  it("F3: the pull request title is scanned, from the command line too", () => {
    expect(scanPrTitle("Move code from secret-repo-name", rules)).toEqual(["pull request title: contains private needle #1"]);
    expect(scanPrTitle("A clean title", rules)).toEqual([]);
    const dir = tree({ "a.txt": "fine" });
    expect(cli(["--tree", dir, "--pr-title-env", "T"], { T: "TODO-PRIVATE in a title" }).status).toBe(1);
    expect(cli(["--tree", dir, "--pr-title-env", "T"], { T: "A clean title" }).status).toBe(0);
  });

  it("F2: a secret added in one commit and removed in the next is caught in the history, though the head is clean", () => {
    const dir = repoWith([{ files: { "README.md": "hi" }, message: "base" }, { files: { "notes.txt": "see secret-repo-name here\nand a clean line" }, message: "add" }, { remove: ["notes.txt"], message: "remove again" }]);
    expect(scanTree(dir, rules)).toEqual([]); // the head is clean: the old guard stopped here
    const problems = scanHistory("HEAD~2..HEAD", rules, dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^notes\.txt \(added in commit [0-9a-f]{7}\): contains private needle #1$/);
    expect(problems.join()).not.toContain("secret-repo-name");
    expect(scanHistory("HEAD~1..HEAD", rules, dir)).toEqual([]); // the removal adds nothing
  });

  it("F2: path exceptions apply, a needle in a path is redacted, and an unchanged line is not blamed on a later commit", () => {
    const dir = repoWith([{ files: { "README.md": "a clean readme" }, message: "base" }, { files: { "docs/ok/a.md": "owner-example", "secret-repo-name/x.md": "fine" }, message: "add" }, { files: { "README.md": "a clean readme\nmore" }, message: "touch" }]);
    const problems = scanHistory("HEAD~2..HEAD", rules, dir);
    expect(problems).toHaveLength(1); // docs/ok/ is allowed for owner-example; README.md only gained a clean line
    expect(problems[0]).toContain("[private needle #1]/x.md"); // the path carries a needle: redacted, and its content is clean
  });

  it("F2: the log parser reads files, ignores deletions, merges and binaries", () => {
    const log = ["@@@aaaaaaa1", "diff --git a/f.txt b/f.txt", "--- a/f.txt", "+++ b/f.txt", "@@ -0,0 +1,2 @@", "+one", "+two", "diff --git a/gone.txt b/gone.txt", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", "@@@bbbbbbb2", "diff --git a/img.png b/img.png", "Binary files differ", "@@@ccccccc3"].join("\n");
    expect(addedLines(log)).toEqual([{ sha: "aaaaaaa1", path: "f.txt", text: "one\ntwo\n" }]);
  });

  it("the guard workflow passes the title, the body, the commits and their content to the scan, and gitleaks reads the commit range too", () => {
    // In the private workspace the workflow is an overlay file; in the public repo it is the real workflow.
    const overlay = join(process.cwd(), "public-overlay/.github/workflows/public-guard.yml");
    const yml = readFileSync(existsSync(overlay) ? overlay : join(process.cwd(), ".github/workflows/public-guard.yml"), "utf8");
    for (const must of ["--pr-title-env PR_TITLE", "--pr-body-env PR_BODY", "--commits", "--history", '" git . --log-opts="$RANGE"']) expect(yml).toContain(must);
  });
});
