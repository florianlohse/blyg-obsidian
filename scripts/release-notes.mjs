// The pure core of "prepare a release" (M2 P3a, the maintainer 2026-11-06): from the merged pull requests since the last release to the new version, the CHANGELOG section,
// the device steps and the body of the pull request "Release x.y.z". No network, no files: scripts/prepare-release.mjs feeds it and writes the results.
// The sections each pull request declares (`## User-facing note`, `## Device steps`, checked by scripts/check-pr-body.mjs) are what the notes are made of.
import { sectionText } from "./check-pr-body.mjs";

/** @param {string} current "x.y.z" @param {"patch"|"minor"|"major"} kind */
export function bumpVersion(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`"${current}" is not a plain x.y.z version`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "major") return `${major + 1}.0.0`;
  throw new Error(`unknown bump "${kind}" (patch, minor or major)`);
}

const isNone = (text) => /^none\b/i.test(text.trim());

/**
 * What one merged pull request says for the release. `note`: the user-facing text, or null when it says none; `steps`: the device steps, or null for none;
 * `declared`: false when the body has no such sections (pull requests from before the template).
 * @param {{number: number, title: string, html_url?: string, body?: string | null}} pr
 */
export function classifyPr(pr) {
  const note = sectionText(pr.body ?? "", "User-facing note");
  const steps = sectionText(pr.body ?? "", "Device steps");
  const declared = note !== null && steps !== null && note !== "" && steps !== "";
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url ?? "",
    declared,
    note: note && !isNone(note) ? note : null,
    steps: steps && !isNone(steps) ? steps : null,
  };
}

/** @param {{number: number, title: string, html_url?: string, body?: string | null}[]} prs oldest first */
export function buildRelease({ prs, version, date }) {
  const items = prs.map(classifyPr);
  const noted = items.filter((p) => p.note);
  const bullets = noted.map((p) => p.note.split("\n").map((l, i) => (i === 0 ? (l.startsWith("- ") ? l : `- ${l}`) : `  ${l}`)).join("\n"));
  const body = bullets.length > 0 ? bullets.join("\n") : "- No changes for people who use the plugin (maintenance only).";
  const steps = [...new Set(items.filter((p) => p.steps).map((p) => p.steps))];
  return {
    items,
    notesBody: body,
    changelogSection: `## [${version}] — ${date}\n\n### Changed\n\n${body}\n`,
    scopeLines: items.map((p) => `- ${p.url ? `[#${p.number}](${p.url})` : `#${p.number}`} ${p.title}`),
    deviceSteps: steps,
    undeclared: items.filter((p) => !p.declared),
  };
}

/** Put the new section under `## [Unreleased]`, moving what Unreleased holds into it (it ships with this release); Unreleased stays as an empty heading. */
export function insertChangelogSection(changelog, section) {
  const lines = changelog.split("\n");
  const u = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l));
  if (u < 0) throw new Error("CHANGELOG.md has no `## [Unreleased]` heading");
  let end = lines.findIndex((l, i) => i > u && /^## \[/.test(l));
  if (end < 0) end = lines.length;
  const held = lines.slice(u + 1, end).join("\n").trim();
  const [head, ...rest] = section.trimEnd().split("\n");
  const merged = held === "" ? section.trimEnd() : [head, ...rest, "", held].join("\n");
  return [...lines.slice(0, u + 1), "", merged, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The checklist boxes the maintainer ticks (docs/RELEASE-CHECKLIST.md). */
export const TICKS = [
  "Scope is what I want released (nothing to hold back)",
  "Release notes read and OK (they go out exactly like this)",
  "Version number right",
  "Device checks done on Blyg (dev) of this commit: all pass (or listed exceptions are acceptable)",
  "Anything to announce? (blyg post / Discord: decided)",
];

/** The body of the pull request "Release x.y.z": it also satisfies the template's two sections. */
export function renderPrBody({ release, version, previous, bump, minAppVersion }) {
  const steps = release.deviceSteps.length > 0 ? release.deviceSteps.join("\n\n") : "none: covered by tests";
  const undeclared = release.undeclared.length > 0 ? `\n- **Without the note/steps sections (older pull requests, read them):** ${release.undeclared.map((p) => `#${p.number}`).join(", ")}` : "";
  return `## What and why

Release ${version} (${bump} bump from ${previous}): ${release.items.length} merged pull request${release.items.length === 1 ? "" : "s"} since the last release. Merging this pull request is the go for the release (a session starts the public release from it).

## User-facing note

${release.notesBody}

## Device steps

${steps}

## Release checklist

### Filled in by Claude

- **Version:** ${version} (${bump}; patch: fixes only, minor: new behaviour, major: anything that breaks settings or an older Studio than stated)
- **Scope:**
${release.scopeLines.map((l) => `  ${l}`).join("\n") || "  - (nothing merged)"}${undeclared}
- **Release notes:** the \`## [${version}]\` section of CHANGELOG.md in this pull request (above)
- **Breaking changes / migrations:** none (to confirm)
- **Compatibility:** Obsidian ${minAppVersion} or newer; Studio as the README states
- **Automated evidence:** CI, the release dry-run and the real-Obsidian smoke test on this commit: see the checks below
- **Docs:** README and screenshots still true for this release: to confirm
- **Rollback:** the previous release ${previous} (BRAT: add the repository again and pick that version)

### Ticked by the maintainer

${TICKS.map((t) => `- [ ] ${t}`).join("\n")}
`;
}

/** The unticked boxes of a release pull request body (the check refuses the merge while any is left). */
export function unticked(body) {
  return String(body ?? "").split("\n").filter((l) => /^\s*[-*]\s+\[ \]\s/.test(l)).map((l) => l.replace(/^\s*[-*]\s+\[ \]\s*/, "").trim());
}
