import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { BUILD_INPUTS, devBuildChanges } from "../../scripts/dev-gate.mjs";

describe("dev-gate: which changed files are inputs of the plugin build", () => {
  it("source, styles, manifest, package files, the bundler config, tsconfig and the flavour script are; the rest is not", () => {
    const hit = ["src/main.ts", "src/studio/api.ts", "styles.css", "manifest.json", "package.json", "package-lock.json", "esbuild.config.mjs", "tsconfig.json", "scripts/flavour.mjs"];
    expect(devBuildChanges(hit)).toEqual(hit);
    const miss = ["tests/core/a.test.ts", "docs/ARCHITECTURE.md", "README.md", "CHANGELOG.md", "versions.json", ".github/workflows/ci.yml", "scripts/release-notes.mjs", "scripts/dev-gate.mjs", "srcfoo/x.ts", "images/readme/hero.png", "eslint.config.mjs"];
    expect(devBuildChanges(miss)).toEqual([]);
  });

  it("trims blanks and keeps the order; every input is an exact file or a directory prefix", () => {
    expect(devBuildChanges([" src/a.ts ", "", "docs/x.md", "styles.css\n"])).toEqual(["src/a.ts", "styles.css"]);
    for (const i of BUILD_INPUTS) expect(i === i.trim() && !i.startsWith("/")).toBe(true);
  });

  it("the command line reads stdin and prints the hits", () => {
    const out = execFileSync("node", ["scripts/dev-gate.mjs"], { input: "docs/a.md\nsrc/x.ts\ntests/t.ts\n", encoding: "utf8" });
    expect(out).toBe("src/x.ts\n");
    expect(execFileSync("node", ["scripts/dev-gate.mjs"], { input: "docs/a.md\n", encoding: "utf8" })).toBe("");
  });
});

// In the private workspace this is an overlay file (public-overlay/); in the public repo it is the real workflow. Same path logic, same tests.
describe("dev-build.yml: the token stays in the publish job", () => {
  const overlay = join(process.cwd(), "public-overlay/.github/workflows/dev-build.yml");
  const yml = readFileSync(existsSync(overlay) ? overlay : join(process.cwd(), ".github/workflows/dev-build.yml"), "utf8");
  const code = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
  type Job = { needs?: string | string[]; if?: string; environment?: string; permissions?: unknown; env?: Record<string, string>; steps: Step[] };
  const wf = yaml.load(yml) as { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: { group: string; "cancel-in-progress": boolean }; jobs: Record<string, Job> };
  const jobText = (j: Job) => JSON.stringify(j);

  it("runs on a push to main or by hand, read-only by default, and queues instead of cancelling", () => {
    expect(wf.on).toEqual({ push: { branches: ["main"] }, workflow_dispatch: null });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.concurrency).toEqual({ group: "dev-build", "cancel-in-progress": false });
    expect(Object.keys(wf.jobs)).toEqual(["gate", "build", "publish"]);
  });

  it("without DEV_BUILDS_REPO (a fork, or before it is set) nothing runs", () => {
    expect(wf.jobs["gate"]?.if).toContain("vars.DEV_BUILDS_REPO != ''");
    expect(wf.jobs["build"]?.needs).toBe("gate");
    expect(wf.jobs["build"]?.if).toContain("needs.gate.outputs.release == 'true'");
    expect(wf.jobs["publish"]?.if).toContain("needs.gate.outputs.release == 'true'");
    // nothing setup-specific: every cross-repository target comes from the variable, no owner/repo slug is written here
    const targets = [...code.matchAll(/ -R (\S+)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t === '"$DEV_REPO"')).toBe(true);
    expect(code).toContain('gh api "repos/$DEV_REPO/releases');
  });

  it("only the publish job reads the secret; it sits in the dev-builds environment, runs no npm or node step and does not check out the repository", () => {
    expect((code.match(/secrets\.DEV_BUILDS_TOKEN/g) ?? []).length).toBe(1);
    expect(jobText(wf.jobs["gate"]!)).not.toContain("secrets.");
    expect(jobText(wf.jobs["build"]!)).not.toContain("secrets.");
    const publish = wf.jobs["publish"]!;
    expect(publish.environment).toBe("dev-builds");
    expect(publish.env?.["GH_TOKEN"]).toBe("${{ secrets.DEV_BUILDS_TOKEN }}");
    expect(publish.needs).toEqual(["gate", "build"]);
    const runs = publish.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/\bnpm\b|\bnode\b|\bnpx\b/);
    expect(publish.steps.some((s) => (s.uses ?? "").startsWith("actions/checkout"))).toBe(false);
  });

  it("the build job lints, tests and builds before it assembles only the dev flavour; the release is a normal one, made in the dev-builds repository", () => {
    const run = wf.jobs["build"]!.steps.map((s) => s.run ?? "");
    const idx = (needle: string) => run.findIndex((r) => r.includes(needle));
    expect(idx("npm run lint")).toBeGreaterThan(-1);
    expect(idx("npm run lint")).toBeLessThan(idx("npm test"));
    expect(idx("npm test")).toBeLessThan(idx("npm run build"));
    expect(idx("npm run build")).toBeLessThan(idx("scripts/flavour.mjs blyg-dev dist/blyg-dev"));
    expect(code).not.toMatch(/flavour\.mjs blyg dist/); // never the real flavour
    const publish = wf.jobs["publish"]!.steps.map((s) => s.run ?? "").join("\n");
    expect(publish).toContain('gh release create "$VERSION"');
    expect(publish).toContain('-R "$DEV_REPO"');
    expect(publish).not.toContain("--prerelease"); // BRAT's "Latest" ignores pre-releases
    expect(publish).toContain("--latest");
  });

  it("the gate: a manual run always builds, the kill switch is honoured, and it compares with the last build's source commit", () => {
    const gate = wf.jobs["gate"]!.steps.map((s) => s.run ?? "").join("\n");
    expect(gate.indexOf('"$EVENT" != "push"')).toBeLessThan(gate.indexOf('"$AUTO_OFF" = "true"'));
    expect(wf.jobs["gate"]!.steps.find((s) => s.name?.startsWith("Should"))?.env?.["AUTO_OFF"]).toBe("${{ vars.DEV_AUTO_RELEASE == 'false' }}");
    expect(gate).toContain("scripts/dev-gate.mjs");
  });

  it("what the publish job writes into the release notes is exactly what the gate parses back", () => {
    const sed = /sed -n '(s\/\^Source commit[^']*)'/.exec(code)?.[1];
    const printf = /printf '(Source commit: %s[^']*)' "\$SOURCE_SHA"/.exec(code)?.[1];
    expect(sed).toBeTruthy();
    expect(printf).toBeTruthy();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const out = execFileSync("bash", ["-c", `printf '${printf}' "${sha}" | sed -n '${sed}' | head -1`], { encoding: "utf8" }).trim();
    expect(out).toBe(sha);
  });
});
