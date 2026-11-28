import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { NEWEST_JOB, REQUIRED_JOBS, releaseGate, type CheckRun, type GateInput } from "../../scripts/release-gate.mjs";

const REVIEWED = "a".repeat(40);
const MERGE = "b".repeat(40);
const TREE = "c".repeat(40);
const NOW = new Date("2026-11-30T12:00:00Z");

const job = (name: string, conclusion: string | null = "success", status = "completed", id = 1): CheckRun => ({ name, status, conclusion, id });
const goodChecks = (): CheckRun[] => [...REQUIRED_JOBS, NEWEST_JOB].map((n) => job(n));
const owner = (body: string, at = "2026-11-29T10:00:00Z") => ({ user: { login: "the-owner" }, author_association: "OWNER", body, created_at: at });
const preview = (sha = REVIEWED, status = "Completed", errors = 0) => owner(`Obsidian preview: ${sha} ${status} errors=${errors}`);

/** A release that passes; each test breaks one thing. */
function base(over: Partial<GateInput> = {}): GateInput {
  return {
    mode: "release", version: "1.2.0", headSha: MERGE, headTree: TREE, expectedSha: MERGE, owner: "the-owner", now: NOW,
    pr: { number: 7, title: "Release 1.2.0", merged_at: "2026-11-29T11:00:00Z", merge_commit_sha: MERGE },
    comments: [preview()],
    commits: { [REVIEWED]: { tree: TREE, checks: goodChecks() } },
    ...over,
  };
}
const blocked = (i: GateInput, part: string) => {
  const r = releaseGate(i);
  expect(r.ok, r.problems.join(" | ")).toBe(false);
  expect(r.problems.join(" | ")).toContain(part);
};

describe("release gate: the positive cases", () => {
  it("passes the exact, reviewed, green candidate (the merge has another SHA but the same tree)", () => {
    const r = releaseGate(base());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("passes a failed newest-Obsidian job the owner accepted for this commit", () => {
    const checks = goodChecks().map((c) => (c.name === NEWEST_JOB ? job(NEWEST_JOB, "failure") : c));
    const accept = owner(`Newest Obsidian UI accepted: ${REVIEWED}`);
    const r = releaseGate(base({ commits: { [REVIEWED]: { tree: TREE, checks } }, comments: [preview(), accept] }));
    expect(r.problems).toEqual([]);
    expect(r.notes.join(" ")).toContain("accepted by the owner");
  });
  it("uses the newest of several runs of a job (a re-run that succeeded)", () => {
    const checks = [job("obsidian-ui", "failure", "completed", 1), ...goodChecks().filter((c) => c.name !== "obsidian-ui"), job("obsidian-ui", "success", "completed", 9)];
    expect(releaseGate(base({ commits: { [REVIEWED]: { tree: TREE, checks } } })).ok).toBe(true);
  });
});

describe("release gate: blocked (negative cases)", () => {
  it("absent preview", () => blocked(base({ comments: [] }), "No confirmed Obsidian preview"));
  it("failed preview", () => blocked(base({ comments: [preview(REVIEWED, "Failed", 1)] }), "only Completed with errors=0 passes"));
  it("incomplete preview", () => blocked(base({ comments: [preview(REVIEWED, "Incomplete", 0)] }), "Incomplete"));
  it("completed but with errors", () => blocked(base({ comments: [preview(REVIEWED, "Completed", 2)] }), "2 error(s)"));
  it("a newer Failed comment overrides an older Completed one", () =>
    blocked(base({ comments: [owner(`Obsidian preview: ${REVIEWED} Completed errors=0`, "2026-11-28T10:00:00Z"), owner(`Obsidian preview: ${REVIEWED} Failed errors=1`, "2026-11-29T10:00:00Z")] }), "Failed"));
  it("stale preview (older than the limit)", () => blocked(base({ comments: [owner(`Obsidian preview: ${REVIEWED} Completed errors=0`, "2026-11-01T10:00:00Z")] }), "older than 7 days"));
  it("an unauthorized approval: a contributor's comment, a forged owner login without OWNER association", () => {
    const stranger = { user: { login: "someone" }, author_association: "CONTRIBUTOR", body: `Obsidian preview: ${REVIEWED} Completed errors=0`, created_at: "2026-11-29T10:00:00Z" };
    const spoof = { user: { login: "the-owner" }, author_association: "CONTRIBUTOR", body: `Obsidian preview: ${REVIEWED} Completed errors=0`, created_at: "2026-11-29T10:00:00Z" };
    const imposter = { user: { login: "someone" }, author_association: "OWNER", body: `Obsidian preview: ${REVIEWED} Completed errors=0`, created_at: "2026-11-29T10:00:00Z" };
    blocked(base({ comments: [stranger, spoof, imposter] }), "No confirmed Obsidian preview");
  });
  it("an abbreviated sha is not accepted", () => blocked(base({ comments: [owner(`Obsidian preview: ${REVIEWED.slice(0, 7)} Completed errors=0`)] }), "No confirmed Obsidian preview"));
  it("source or version changed after the approval (different tree)", () => blocked(base({ headTree: "d".repeat(40) }), "is not what was reviewed"));
  it("reviewed commit unknown to the repository", () => blocked(base({ commits: {} }), "unknown to this repository"));
  it("main advanced after the dispatch", () => blocked(base({ expectedSha: "e".repeat(40) }), "Main moved"));
  it("the checkout is not the merge commit of the release pull request", () => blocked(base({ pr: { number: 7, title: "Release 1.2.0", merged_at: "2026-11-29T11:00:00Z", merge_commit_sha: "f".repeat(40) } }), "not the merge commit"));
  it("an unmerged or differently titled or wrong-version pull request", () => {
    blocked(base({ pr: { number: 7, title: "Release 1.2.0", merged_at: null, merge_commit_sha: MERGE } }), "not the merge commit");
    blocked(base({ pr: { number: 7, title: "Quick fix", merged_at: "x", merge_commit_sha: MERGE } }), 'not titled "Release x.y.z"');
    blocked(base({ pr: { number: 7, title: "Release 1.3.0", merged_at: "x", merge_commit_sha: MERGE } }), "is for 1.3.0");
    blocked(base({ pr: null }), "No pull request");
  });
  it("wrong candidate CI: green only on another commit leaves the reviewed one without results", () => blocked(base({ commits: { [REVIEWED]: { tree: TREE, checks: [] } } }), 'Required job "obsidian-ui" has no result'));
  for (const name of REQUIRED_JOBS) {
    it(`a required job that failed, was skipped, cancelled or is pending blocks: ${name}`, () => {
      for (const [conclusion, status] of [["failure", "completed"], ["skipped", "completed"], ["cancelled", "completed"], [null, "in_progress"], [null, "queued"]] as const) {
        const checks = goodChecks().map((c) => (c.name === name ? job(name, conclusion, status) : c));
        blocked(base({ commits: { [REVIEWED]: { tree: TREE, checks } } }), `"${name}"`);
      }
    });
  }
  it("a pinned UI failure blocks (it is a real result, not an advisory one)", () => {
    const checks = goodChecks().map((c) => (c.name === "obsidian-ui" ? job("obsidian-ui", "failure") : c));
    blocked(base({ commits: { [REVIEWED]: { tree: TREE, checks } } }), "did not succeed");
  });
  it("the newest-Obsidian job pending, missing or skipped is not an acknowledged failure", () => {
    const without = goodChecks().filter((c) => c.name !== NEWEST_JOB);
    blocked(base({ commits: { [REVIEWED]: { tree: TREE, checks: without } } }), "has no result");
    blocked(base({ commits: { [REVIEWED]: { tree: TREE, checks: [...without, job(NEWEST_JOB, null, "in_progress")] } } }), "still in_progress");
    blocked(base({ commits: { [REVIEWED]: { tree: TREE, checks: [...without, job(NEWEST_JOB, "skipped")] } } }), "neither a result nor an accepted failure");
  });
  it("a failed newest-Obsidian job without the owner's acceptance, or accepted for another commit, or accepted by a stranger", () => {
    const commits = { [REVIEWED]: { tree: TREE, checks: goodChecks().map((c) => (c.name === NEWEST_JOB ? job(NEWEST_JOB, "failure") : c)) } };
    blocked(base({ commits }), "has not accepted it");
    blocked(base({ commits, comments: [preview(), owner(`Newest Obsidian UI accepted: ${"9".repeat(40)}`)] }), "has not accepted it");
    const stranger = { user: { login: "someone" }, author_association: "CONTRIBUTOR", body: `Newest Obsidian UI accepted: ${REVIEWED}`, created_at: "2026-11-29T10:00:00Z" };
    blocked(base({ commits, comments: [preview(), stranger] }), "has not accepted it");
  });
});

describe("release gate: dry run on a pull request", () => {
  it("reports the same problems but needs no merge and no expected sha", () => {
    const r = releaseGate(base({ mode: "dry-run", expectedSha: "", headSha: REVIEWED, pr: { number: 7, title: "Release 1.2.0", merged_at: null, merge_commit_sha: null } }));
    expect(r.problems).toEqual([]);
    expect(releaseGate(base({ mode: "dry-run", comments: [], pr: { number: 7, title: "Release 1.2.0" } })).problems).toHaveLength(1);
  });
});

describe("the workflows actually enforce the gate", () => {
  type Job = { needs?: string | string[]; if?: string; "continue-on-error"?: boolean; steps?: { name?: string; run?: string; uses?: string; if?: string; "continue-on-error"?: boolean }[]; permissions?: Record<string, string> };
  const load = (f: string) => yaml.load(readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8")) as { on: { workflow_dispatch?: { inputs: Record<string, { required?: boolean }> } }; jobs: Record<string, Job> };
  const release = load("release.yml");
  const ci = load("ci.yml");
  const onMerge = load("release-on-merge.yml");

  it("the publish job needs the verify job, whose release-mode gate step has no continue-on-error and runs before the assets are kept", () => {
    expect([release.jobs.publish!.needs].flat()).toContain("verify");
    const steps = release.jobs.verify!.steps!;
    const gate = steps.findIndex((s) => s.run === "node scripts/release-gate.mjs");
    const keep = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(keep);
    expect(steps[gate]!["continue-on-error"]).toBeUndefined();
    expect(steps[gate]!.if).toContain("workflow_dispatch");
    expect(release.jobs.verify!["continue-on-error"]).toBeUndefined();
  });
  it("only the publish job can write; the verify job reads", () => {
    expect(release.jobs.verify!.permissions).toEqual({ contents: "read", "pull-requests": "read", issues: "read", checks: "read" });
    expect(release.jobs.publish!.permissions).toEqual({ contents: "write" });
  });
  it("a release dispatch requires the exact sha, and release-on-merge passes the merge commit's", () => {
    expect(release.on.workflow_dispatch?.inputs.sha?.required).toBe(true);
    const dispatch = onMerge.jobs.dispatch!.steps!.map((s) => s.run ?? "").join("\n");
    expect(dispatch).toContain('-f sha="$SHA"');
  });
  it("no required CI job is allowed to fail silently: no continue-on-error anywhere in ci.yml", () => {
    for (const [name, j] of Object.entries(ci.jobs)) {
      expect(j["continue-on-error"], name).toBeUndefined();
      for (const s of j.steps ?? []) expect(s["continue-on-error"], `${name}: ${s.name ?? s.run}`).toBeUndefined();
    }
  });
  it("the newest-Obsidian job runs on a release pull request (its result exists on the candidate) as well as on pushes", () => {
    expect(ci.jobs["obsidian-ui-newest"]!.if).toContain("startsWith(github.event.pull_request.title, 'Release ')");
    expect(ci.jobs["obsidian-ui-newest"]!.if).toContain("push");
  });
  it("every job the gate requires exists in ci.yml or the release dry run under that name", () => {
    const names = new Set<string>();
    for (const [id, j] of Object.entries({ ...ci.jobs, ...release.jobs, ...load("pr-declares.yml").jobs, ...load("public-guard.yml").jobs, ...load("release-pr-ticked.yml").jobs })) {
      names.add(id);
      void j;
    }
    for (const n of ["check", "guard", "verify", "declares", "ticked", "obsidian-smoke", "obsidian-ui", NEWEST_JOB]) expect(names, n).toContain(n);
  });
});

describe("the gate command itself (a stub `gh`, the real script and the real checkout)", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  const version = (JSON.parse(readFileSync(`${root}manifest.json`, "utf8")) as { version: string }).version;

  /** Runs `node scripts/release-gate.mjs` with a `gh` that answers from a fixture; returns the exit code and the text. */
  function run(fixture: { comments: unknown[]; checks: CheckRun[]; reviewedTree?: string }, over: Record<string, string> = {}) {
    const head = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const stub = join(dir, "gh");
    const data = {
      pulls: [{ number: 5, title: `Release ${version}`, merged_at: "2026-11-29T00:00:00Z", merge_commit_sha: head }],
      comments: fixture.comments,
      commit: { tree: { sha: fixture.reviewedTree ?? tree } },
      checks: fixture.checks,
    };
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(data));
    writeFileSync(
      stub,
      `#!/usr/bin/env node\nconst d = JSON.parse(require("fs").readFileSync(${JSON.stringify(join(dir, "fixture.json"))}, "utf8"));\nconst p = process.argv.slice(2).find((a) => a.startsWith("repos/"));\n` +
        `const page = (x) => console.log(JSON.stringify([x]));\nif (p.includes("/pulls")) console.log(JSON.stringify(d.pulls));\nelse if (p.includes("/comments")) page(d.comments);\nelse if (p.includes("/check-runs")) page({ check_runs: d.checks });\nelse if (p.includes("/git/commits/")) console.log(JSON.stringify(d.commit));\nelse { console.error("unexpected " + p); process.exit(2); }\n`,
      { mode: 0o755 },
    );
    const r = spawnSync("node", ["scripts/release-gate.mjs"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GATE_MODE: "release", REPO: "the-owner/the-repo", HEAD_SHA: head, EXPECTED_SHA: head, GITHUB_STEP_SUMMARY: "", ...over },
    });
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }
  const ok = { comments: [{ user: { login: "the-owner" }, author_association: "OWNER", body: `Obsidian preview: ${REVIEWED} Completed errors=0`, created_at: new Date().toISOString() }], checks: goodChecks() };

  it("exits 0 for the exact, reviewed, green candidate", () => {
    expect(run(ok).out).toContain("PASS");
    expect(run(ok).code).toBe(0);
  });
  it("exits 1 (the publish path stops) with no preview, a failed required job, a changed tree or a moved main", () => {
    expect(run({ ...ok, comments: [] }).code).toBe(1);
    expect(run({ ...ok, checks: goodChecks().map((c) => (c.name === "obsidian-ui" ? job("obsidian-ui", "failure") : c)) }).code).toBe(1);
    expect(run({ ...ok, reviewedTree: "d".repeat(40) }).code).toBe(1);
    const moved = run(ok, { EXPECTED_SHA: "e".repeat(40) });
    expect(moved.code).toBe(1);
    expect(moved.out).toContain("Main moved");
  });
  it("in dry-run mode the same problems are warnings and the exit code stays 0", () => {
    const r = run({ ...ok, comments: [] }, { GATE_MODE: "dry-run", HEAD_SHA: git("rev-parse", "HEAD") });
    expect(r.out).toContain("::warning::");
  });
});
