import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { prBodyProblems, sectionText } from "../../scripts/check-pr-body.mjs";
import { buildRelease, bumpVersion, classifyPr, insertChangelogSection, renderPrBody, TICKS, unticked } from "../../scripts/release-notes.mjs";
import { isReleasePr, releasePrProblems } from "../../scripts/check-release-pr.mjs";
import { lastReleaseCommit, mergedSince } from "../../scripts/prepare-release.mjs";
import { releasePlan } from "../../scripts/release-plan.mjs";

describe("issue forms and the security policy (public repo intake, issues only)", () => {
  const root = new URL("../../", import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, root), "utf8");
  // GitHub's default labels, which the project keeps (the maintainer, 2026-11-06): a form must not apply a label that does not exist there.
  const vanilla = ["bug", "documentation", "duplicate", "enhancement", "good first issue", "help wanted", "invalid", "question", "wontfix", "accessibility"];
  type Field = { type: string; id?: string; attributes?: Record<string, unknown>; validations?: { required?: boolean } };
  type Form = { name: string; description: string; labels?: string[]; body: Field[] };
  const forms = ["bug_report.yml", "feature_request.yml"].map((f) => ({ f, form: yaml.load(read(`.github/ISSUE_TEMPLATE/${f}`)) as Form }));

  it("each form has a name, a description, vanilla labels and fields with unique ids", () => {
    for (const { f, form } of forms) {
      expect(typeof form.name, f).toBe("string");
      expect(typeof form.description, f).toBe("string");
      for (const l of form.labels ?? []) expect(vanilla, `${f}: label ${l}`).toContain(l);
      const ids = form.body.map((b) => b.id).filter(Boolean);
      expect(new Set(ids).size, `${f}: ids are unique`).toBe(ids.length);
      expect(form.body.some((b) => b.validations?.required === true || b.type === "checkboxes"), f).toBe(true);
    }
    expect(forms[0]?.form.labels).toEqual(["bug"]);
    expect(forms[1]?.form.labels).toEqual(["enhancement"]);
  });
  it("the bug form asks for the versions that matter and for a no-token confirmation", () => {
    const ids = forms[0]?.form.body.map((b) => b.id);
    for (const id of ["what", "plugin-version", "obsidian-version", "device", "studio-version", "tokens"]) expect(ids).toContain(id);
    const tokens = forms[0]?.form.body.find((b) => b.id === "tokens");
    const options = (tokens?.attributes?.["options"] ?? []) as { required?: boolean }[];
    expect(options.every((o) => o.required === true)).toBe(true);
  });
  it("blank issues stay possible (questions), and the policy says how to report privately and where tokens live", () => {
    expect((yaml.load(read(".github/ISSUE_TEMPLATE/config.yml")) as { blank_issues_enabled: boolean }).blank_issues_enabled).toBe(true);
    const policy = read("SECURITY.md");
    expect(policy).toContain("Report a vulnerability");
    expect(policy).toContain("keychain");
    expect(policy).not.toMatch(/https?:\/\//); // relative guidance only: the repository's own tabs, no addresses to keep in step
  });
});

describe("every pull request declares a user-facing note and device steps (M2 P4)", () => {
  const body = (note: string, steps: string) => `## What and why\n\nSomething.\n\n## User-facing note\n\n${note}\n\n## Device steps\n\n${steps}\n`;

  it("accepts a body with both sections, including the explicit 'none' answers", () => {
    expect(prBodyProblems(body("The panel says Stub.", "1. Open a stub note: the panel shows the Stub line."))).toEqual([]);
    expect(prBodyProblems(body("none", "none: covered by tests"))).toEqual([]);
    expect(prBodyProblems(body("None", "None"))).toEqual([]);
  });

  it("names a missing section, an empty one, and one that holds only the template's comment", () => {
    expect(prBodyProblems("just text")).toHaveLength(2);
    expect(prBodyProblems("## User-facing note\n\nnone\n")).toEqual(['The section "## Device steps" is missing (see .github/pull_request_template.md).']);
    expect(prBodyProblems(body("", "none"))[0]).toContain('"## User-facing note" is empty');
    expect(prBodyProblems(body("<!-- a hint -->", "<!-- a hint -->"))).toHaveLength(2);
    expect(prBodyProblems(undefined as unknown as string)).toHaveLength(2);
  });

  it("reads a section up to the next heading, with any line ending and heading case", () => {
    expect(sectionText("## user-facing NOTE\r\nHello\r\n## Device steps\r\nX", "User-facing note")).toBe("Hello");
    expect(sectionText("## Device steps\n- a\n- b", "Device steps")).toBe("- a\n- b");
    expect(sectionText("nothing", "Device steps")).toBeNull();
  });

  it("the template has both sections and the workflow runs the checker on pull requests into main", () => {
    const tpl = readFileSync(new URL("../../.github/pull_request_template.md", import.meta.url), "utf8");
    expect(tpl).toContain("## User-facing note");
    expect(tpl).toContain("## Device steps");
    const wf = yaml.load(readFileSync(new URL("../../.github/workflows/pr-declares.yml", import.meta.url), "utf8")) as { on: { pull_request: { branches: string[]; types: string[] } }; permissions: Record<string, string> };
    expect(wf.on.pull_request.branches).toEqual(["main"]);
    expect(wf.on.pull_request.types).toContain("edited");
    expect(wf.permissions).toEqual({ contents: "read" });
  });
});

describe("preparing a release from the merged pull requests (M2 P3)", () => {
  const pr = (number: number, note: string, steps: string, title = `Change ${number}`) => ({ number, title, html_url: `https://example.test/pull/${number}`, body: `## What and why\n\nx\n\n## User-facing note\n\n${note}\n\n## Device steps\n\n${steps}\n` });

  it("bumps the version by the chosen kind and refuses anything that is not x.y.z", () => {
    expect(bumpVersion("0.9.0", "patch")).toBe("0.9.1");
    expect(bumpVersion("0.9.9", "minor")).toBe("0.10.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(() => bumpVersion("0.9.0-dev.1", "patch")).toThrow(/plain x.y.z/);
    expect(() => bumpVersion("0.9.0", "huge" as never)).toThrow(/unknown bump/);
  });

  it("reads each pull request's note and steps; 'none' means nothing to say; no sections means undeclared", () => {
    expect(classifyPr(pr(1, "The panel says Stub.", "1. Open a stub note."))).toMatchObject({ declared: true, note: "The panel says Stub.", steps: "1. Open a stub note." });
    expect(classifyPr(pr(2, "none", "none: covered by tests"))).toMatchObject({ declared: true, note: null, steps: null });
    expect(classifyPr(pr(3, "None.", "None"))).toMatchObject({ note: null, steps: null });
    expect(classifyPr({ number: 4, title: "old", body: "just text" })).toMatchObject({ declared: false, note: null, steps: null });
    expect(classifyPr({ number: 5, title: "no body", body: null }).declared).toBe(false);
  });

  it("builds the CHANGELOG section, the scope and the union of device steps; a release with no notes says so", () => {
    const r = buildRelease({ prs: [pr(1, "The panel says Stub.", "1. Open a stub note."), pr(2, "none", "none"), pr(3, "Repost is hidden.\nSecond line.", "1. Open a stub note.")], version: "0.9.1", date: "2026-11-10" });
    expect(r.changelogSection).toBe("## [0.9.1] — 2026-11-10\n\n### Changed\n\n- The panel says Stub.\n- Repost is hidden.\n  Second line.\n");
    expect(r.deviceSteps).toEqual(["1. Open a stub note."]); // the same steps from two pull requests appear once
    expect(r.scopeLines[0]).toBe("- #1 Change 1"); // no full link: it would carry the owner's name into a body the leak guard scans
    expect(r.undeclared).toEqual([]);
    const quiet = buildRelease({ prs: [pr(2, "none", "none")], version: "0.9.2", date: "2026-11-11" });
    expect(quiet.changelogSection).toContain("- No changes for people who use the plugin (maintenance only).");
    expect(buildRelease({ prs: [], version: "0.9.2", date: "2026-11-11" }).scopeLines).toEqual([]);
  });

  it("inserts the section under Unreleased and moves what Unreleased holds into it", () => {
    const changelog = "# Changelog\n\nintro\n\n## [Unreleased]\n\n### Added\n\n- A dev thing.\n\n## [0.9.0] — 2026-11-06\n\nold\n";
    const out = insertChangelogSection(changelog, "## [0.9.1] — 2026-11-10\n\n### Changed\n\n- New.\n");
    expect(out).toBe("# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.9.1] — 2026-11-10\n\n### Changed\n\n- New.\n\n### Added\n\n- A dev thing.\n\n## [0.9.0] — 2026-11-06\n\nold\n");
    expect(insertChangelogSection("## [Unreleased]\n\n## [0.9.0] — x\n", "## [0.9.1] — y\n\n- n\n")).toBe("## [Unreleased]\n\n## [0.9.1] — y\n\n- n\n\n## [0.9.0] — x\n");
    expect(() => insertChangelogSection("no heading", "## [0.9.1]\n")).toThrow(/Unreleased/);
  });

  it("the pull request body satisfies the template's two sections and carries the unticked boxes; ticking them all clears the check", () => {
    const release = buildRelease({ prs: [pr(1, "The panel says Stub.", "1. Open a stub note."), { number: 9, title: "old", body: "x" }], version: "0.9.1", date: "2026-11-10" });
    const body = renderPrBody({ release, version: "0.9.1", previous: "0.9.0", bump: "patch", minAppVersion: "1.13.0" });
    expect(prBodyProblems(body)).toEqual([]);
    expect(body).toContain("Release 0.9.1 (patch bump from 0.9.0)");
    expect(body).toContain("#9"); // the undeclared pull request is named for review
    expect(unticked(body)).toEqual(TICKS);
    expect(releasePrProblems("Release 0.9.1", body)).toHaveLength(TICKS.length);
    expect(releasePrProblems("Release 0.9.1", body.replaceAll("- [ ]", "- [x]"))).toEqual([]);
  });

  it("the tick check only judges release pull requests", () => {
    expect(isReleasePr("Release 0.9.1")).toBe(true);
    expect(isReleasePr("Release 0.9.1 (extra)")).toBe(false);
    expect(isReleasePr("docs: release notes")).toBe(false);
    expect(releasePrProblems("Fix the panel", "- [ ] anything")).toEqual([]);
  });

  it("takes only the merged pull requests whose merge commit is after the last release, oldest first, without release pull requests", () => {
    const prs = [
      { number: 3, title: "C", merged_at: "2026-11-08T10:00:00Z", merge_commit_sha: "c3" },
      { number: 2, title: "B", merged_at: "2026-11-07T10:00:00Z", merge_commit_sha: "b2" },
      { number: 1, title: "A", merged_at: "2026-11-01T10:00:00Z", merge_commit_sha: "a1" }, // before the release
      { number: 4, title: "closed, not merged", merged_at: null, merge_commit_sha: "d4" },
      { number: 5, title: "Release 0.9.0", merged_at: "2026-11-06T10:00:00Z", merge_commit_sha: "e5" },
    ];
    expect(mergedSince(prs, ["c3", "b2", "d4", "e5"]).map((p) => p.number)).toEqual([2, 3]);
  });

  it("the tick-check workflow runs on pull requests into main and re-runs when the body is edited", () => {
    const wf = yaml.load(readFileSync(new URL("../../.github/workflows/release-pr-ticked.yml", import.meta.url), "utf8")) as { on: { pull_request: { branches: string[]; types: string[] } }; permissions: Record<string, string> };
    expect(wf.on.pull_request.branches).toEqual(["main"]);
    expect(wf.on.pull_request.types).toContain("edited");
    expect(wf.permissions).toEqual({ contents: "read" });
  });
});


describe("releasing by merging the release pull request (P3b): the plan", () => {
  const ok = { number: 61, title: "Release 0.9.1", body: "## x\n- [x] a\n- [x] b\n", merged_at: "2026-11-10T09:00:00Z", merge_commit_sha: "abc" };
  const base = { sha: "abc", manifestVersion: "0.9.1", changelog: "# C\n\n## [Unreleased]\n\n## [0.9.1] — 2026-11-10\n\n- x\n", prs: [ok] };

  it("a merged, fully ticked release pull request whose version and CHANGELOG agree is a release, however it was merged", () => {
    // The commit message does not matter: a merge commit made in the GitHub app is only "Merge pull request #61 from …" (the first real release, 2026-11-06, was merged so).
    expect(releasePlan(base)).toEqual({ release: true, version: "0.9.1", pr: 61 });
  });

  it("any other push is not a release: no pull request, another title, release candidates, a pull request that was not merged into this commit", () => {
    const none = { release: false, reason: "not the merge of a release pull request" };
    expect(releasePlan({ ...base, prs: [] })).toEqual(none); // a direct push, a revert
    for (const title of ["docs: STATUS", "Release 0.9.1-rc.1", "Release 0.9.1 extra", "release 0.9.1", "Prepare release 0.9.1", "Release 0.9", 'Revert "Release 0.9.1"']) {
      expect(releasePlan({ ...base, prs: [{ ...ok, title }] }), title).toEqual(none);
    }
    expect(releasePlan({ ...base, prs: [{ ...ok, merged_at: null }] })).toEqual(none);
    expect(releasePlan({ ...base, prs: [{ ...ok, merge_commit_sha: "other" }] })).toEqual(none); // an older pull request with the same title does not count
  });

  it("fails closed: an inconsistent release pull request is a problem to read, never a release", () => {
    const problems = (over: object) => {
      const r = releasePlan({ ...base, ...over });
      expect(r.release).toBe(false);
      return "problems" in r ? r.problems.join(" | ") : "";
    };
    expect(problems({ prs: [{ ...ok, body: "- [x] a\n- [ ] b" }] })).toContain("Not ticked yet: b");
    expect(problems({ manifestVersion: "0.9.0" })).toContain("manifest.json says 0.9.0");
    expect(problems({ changelog: "## [Unreleased]\n## [0.9.0] — x\n" })).toContain('no "## [0.9.1]" section');
    expect(problems({ changelog: "## [0.9.10] — x\n" })).toContain('no "## [0.9.1]" section'); // 0.9.10 is not 0.9.1
  });

  it("the last release is found from the pull request titles, newest first, not from commit messages", () => {
    const prs = [
      { title: "Release 0.9.1", merged_at: "2026-11-10T09:00:00Z", merge_commit_sha: "r2" },
      { title: "Release 0.9.2", merged_at: null, merge_commit_sha: "unmerged" },
      { title: "Fix the panel", merged_at: "2026-11-12T09:00:00Z", merge_commit_sha: "fix" },
      { title: "Release 0.9.0", merged_at: "2026-11-06T09:00:00Z", merge_commit_sha: "r1" },
    ];
    expect(lastReleaseCommit(prs)).toBe("r2");
    expect(lastReleaseCommit([prs[2] as (typeof prs)[number]])).toBeUndefined();
    expect(lastReleaseCommit([])).toBeUndefined();
  });

});
