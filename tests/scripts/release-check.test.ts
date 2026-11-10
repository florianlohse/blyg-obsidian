import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { checkRelease } from "../../scripts/release-check.mjs";

function tree(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "relcheck-"));
  const good: Record<string, string> = {
    "manifest.json": JSON.stringify({ id: "blyg", name: "Blyg", version: "1.2.3" }),
    "package.json": JSON.stringify({ version: "1.2.3" }),
    "versions.json": JSON.stringify({ "1.2.3": "1.13.0" }),
    "CHANGELOG.md": "## [1.2.3]\n- x\n",
  };
  for (const [p, c] of Object.entries({ ...good, ...files })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}
const run = (dir: string, extra = {}) => checkRelease(dir, { mode: "release", latest: "1.2.2", ...extra });
const manifest = (o: object) => JSON.stringify({ id: "blyg", name: "Blyg", version: "1.2.3", ...o });

describe("release-check: what a stable release must satisfy", () => {
  it("a consistent tree passes in release mode", () => {
    expect(run(tree({}))).toEqual({ errors: [], warnings: [] });
  });

  it("version rules are always errors", () => {
    expect(run(tree({ "manifest.json": manifest({ version: "1.2.3-dev.1" }), "package.json": JSON.stringify({ version: "1.2.3-dev.1" }) })).errors.join()).toContain("plain x.y.z");
    expect(run(tree({ "package.json": JSON.stringify({ version: "1.2.4" }) })).errors.join()).toContain("disagree");
    expect(run(tree({ "versions.json": "{}" })).errors.join()).toContain("versions.json has no entry");
    expect(run(tree({ "manifest.json": manifest({ name: "Blyg (dev)" }) })).errors.join()).toContain("dev build");
    expect(run(tree({}), { mode: "dry-run" }).errors).toEqual([]);
    expect(run(tree({ "versions.json": "{}" }), { mode: "dry-run" }).errors.join()).toContain("versions.json has no entry");
  });

  it("the version must be above the newest published release, compared by number", () => {
    expect(run(tree({}), { latest: "1.2.3" }).errors.join()).toContain("not above the latest");
    expect(run(tree({}), { latest: "1.10.0" }).errors.join()).toContain("not above the latest");
    expect(run(tree({}), { latest: "1.2.2" }).errors).toEqual([]);
    expect(run(tree({}), { latest: "not-a-version" }).errors.join()).toContain("is not x.y.z");
  });

  it("fails closed: release mode needs --latest, a missing or broken file is an error", () => {
    expect(run(tree({}), { latest: undefined }).errors.join()).toContain("needs --latest");
    expect(run(tree({ "manifest.json": "{ nope" })).errors.join()).toContain("does not parse");
    const dir = tree({});
    execFileSync("rm", [join(dir, "CHANGELOG.md")]);
    expect(run(dir).errors).toEqual(["CHANGELOG.md: missing"]);
  });

  it("id, CHANGELOG section and version order are warnings in dry-run, errors in release", () => {
    const files = { "manifest.json": manifest({ id: "obsidian-blyg" }), "CHANGELOG.md": "## [Unreleased]" };
    expect(run(tree(files)).errors).toHaveLength(2);
    const dry = run(tree(files), { mode: "dry-run" });
    expect(dry.errors).toEqual([]);
    expect(dry.warnings).toHaveLength(2);
  });

  it("the command line: 0 when ok, 1 on an error, 2 on a bad call", () => {
    const cli = (args: string[]) => { try { execFileSync("node", ["scripts/release-check.mjs", ...args], { stdio: "pipe" }); return 0; } catch (e) { return (e as { status: number }).status; } };
    const dir = tree({});
    expect(cli(["--dir", dir, "--mode", "release", "--latest", "1.2.2"])).toBe(0);
    expect(cli(["--dir", dir, "--mode", "release", "--latest", "1.2.3"])).toBe(1);
    expect(cli(["--dir", dir, "--mode", "release"])).toBe(1);
    expect(cli(["--dir", dir, "--mode", "nonsense"])).toBe(2);
  });
});

// The release workflows. In the private workspace these are overlay files (public-overlay/); in the public repo they are the real workflows. Same path logic, same tests.
describe("the release workflows keep their locks", () => {
  const overlay = (f: string) => join(process.cwd(), "public-overlay/.github/workflows", f);
  const read = (f: string) => readFileSync(existsSync(overlay(f)) ? overlay(f) : join(process.cwd(), ".github/workflows", f), "utf8");
  const codeOf = (yml: string) => yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  type Job = { needs?: string; if?: string; environment?: string; permissions?: Record<string, string>; steps: { name?: string; run?: string; env?: Record<string, string> }[] };
  type Wf = { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: { group: string; "cancel-in-progress": boolean | string }; jobs: Record<string, Job> };

  it("release-on-merge.yml only plans on a push to main, dispatches release.yml and nothing else, and honours the off-switch", () => {
    const yml = read("release-on-merge.yml");
    const wf = yaml.load(yml) as Wf;
    expect(wf.on).toEqual({ push: { branches: ["main"] } });
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "read", actions: "write" });
    expect(wf.concurrency).toEqual({ group: "release-on-merge", "cancel-in-progress": false });
    expect(Object.keys(wf.jobs).sort()).toEqual(["dispatch", "plan"]);
    expect(wf.jobs["dispatch"]?.needs).toBe("plan");
    expect(wf.jobs["dispatch"]?.if).toContain("needs.plan.outputs.release == 'true'");
    const run = wf.jobs["dispatch"]?.steps.map((st) => st.run ?? "").join("\n") ?? "";
    expect(run).toContain('gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref main -f version="$VERSION"');
    expect(run.indexOf('"$SWITCH" != "true"')).toBeGreaterThan(-1);
    expect(run.indexOf('"$SWITCH" != "true"')).toBeLessThan(run.indexOf("gh workflow run")); // the switch is looked at before anything is started
    expect(wf.jobs["dispatch"]?.steps[0]?.env?.["SWITCH"]).toBe("${{ vars.PUBLIC_RELEASE_ENABLED }}");
    const code = codeOf(yml);
    expect(code).not.toMatch(/gh release|git push|secrets\./); // it publishes nothing and holds no secret
    expect((code.match(/gh workflow run/g) ?? []).length).toBe(1);
  });

  it("release.yml: a pull request or a dispatch with one input; read-only by default; the only write permission is in the publish job", () => {
    const wf = yaml.load(read("release.yml")) as Wf;
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(Object.keys((wf.on["workflow_dispatch"] as { inputs: object }).inputs)).toEqual(["version"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(Object.keys(wf.jobs).sort()).toEqual(["publish", "verify"]);
    expect(wf.jobs["verify"]?.permissions).toBeUndefined();
    expect(wf.jobs["publish"]?.permissions).toEqual({ contents: "write" });
    expect(wf.jobs["publish"]?.needs).toBe("verify");
  });

  it("release.yml: publishing needs the variable, a dispatch, main and the environment; it builds nothing and tags the verified commit", () => {
    const yml = read("release.yml");
    const wf = yaml.load(yml) as Wf;
    const publish = wf.jobs["publish"]!;
    expect(publish.if).toContain("vars.PUBLIC_RELEASE_ENABLED == 'true'");
    expect(publish.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(publish.if).toContain("github.ref == 'refs/heads/main'");
    expect(publish.environment).toBe("public-release");
    const steps = publish.steps.map((s) => s.run ?? "").join("\n");
    expect(steps).not.toMatch(/\bnpm\b|\bnode\b|\bnpx\b/); // the write token never sits next to code from a dependency
    expect(steps).toContain('--draft --target "$GITHUB_SHA"');
    expect(steps.indexOf("gh release create")).toBeLessThan(steps.indexOf("gh release edit"));
    const verify = codeOf(yml).split("\n  publish:")[0] ?? "";
    expect(verify).not.toMatch(/gh release (create|edit|delete|upload)|git push/);
    expect(codeOf(yml)).not.toMatch(/^ {2}push:/m); // a push never releases by itself: only the dispatch does
  });

  it("release.yml: the release is checked, scanned for leaks and assembled before it is kept, and a release needs the private needles", () => {
    const yml = codeOf(read("release.yml"));
    for (const must of ["scripts/release-check.mjs", "scripts/public-scan.mjs", "gitleaks", "scripts/flavour.mjs blyg dist/blyg", "--require-private"]) expect(yml).toContain(must);
    expect(yml.indexOf("release-check.mjs")).toBeLessThan(yml.indexOf("upload-artifact"));
    expect(yml.indexOf("public-scan.mjs")).toBeLessThan(yml.indexOf("upload-artifact"));
    expect(yml).toMatch(/--mode "\$MODE"/);
    expect(yml).toContain("github.event_name == 'workflow_dispatch' && 'release' || 'dry-run'");
  });
});
