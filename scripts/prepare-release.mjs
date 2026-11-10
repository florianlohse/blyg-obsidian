// Prepare a release (M2 P3a, the maintainer 2026-11-06). A session runs this when the maintainer says "prepare release": it works out the version, writes the CHANGELOG section,
// bumps the version files and writes the body of the pull request "Release x.y.z". It changes files in the working tree and prints what it did; the session then
// commits, pushes and opens the pull request, so everything stays reviewable. It never publishes anything.
//
//   node scripts/prepare-release.mjs --bump patch|minor|major --since <commit> [--date YYYY-MM-DD] [--body-out FILE] [--prs FILE.json] [--dry]
//
// --since: the commit of the last release (the merged pull requests after it are the scope); omitted, the merge commit of the newest merged pull request titled "Release x.y.z" is used. --prs: pull requests as JSON (GitHub's shape, with merge_commit_sha)
// instead of asking GitHub (tests, offline). Not shipped (not on the snapshot allow-list).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRelease, bumpVersion, insertChangelogSection, renderPrBody } from "./release-notes.mjs";

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** The merge commit of the newest merged pull request titled "Release x.y.z": the last release. Read from the pull request, because a merge commit made in the GitHub app carries no title. */
export function lastReleaseCommit(prs) {
  const hit = prs
    .filter((p) => p.merged_at && p.merge_commit_sha && /^Release \d+\.\d+\.\d+$/.test(String(p.title).trim()))
    .sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)))[0];
  return hit?.merge_commit_sha ?? undefined;
}

/** The pull requests merged since `since`, oldest first, without release pull requests. */
export function mergedSince(prs, commitsSince) {
  const set = new Set(commitsSince);
  return prs
    .filter((p) => p.merged_at && p.merge_commit_sha && set.has(p.merge_commit_sha) && !/^Release \d+\.\d+\.\d+/.test(p.title))
    .sort((a, b) => String(a.merged_at).localeCompare(String(b.merged_at)));
}

function main() {
  const a = process.argv.slice(2);
  const arg = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const bump = arg("--bump");
  if (!bump) throw new Error("usage: node scripts/prepare-release.mjs --bump patch|minor|major [--since <commit of the last release; default: the merge of the newest pull request titled Release x.y.z>] [--date YYYY-MM-DD] [--body-out FILE] [--prs FILE.json] [--dry]");
  const dry = a.includes("--dry");
  const date = arg("--date") ?? new Date().toISOString().slice(0, 10);

  const manifest = readJson("manifest.json");
  const previous = manifest.version;
  const version = bumpVersion(previous, bump);

  let all;
  if (arg("--prs")) all = readJson(arg("--prs"));
  else {
    const repo = arg("--repo") ?? process.env.REPO ?? /([^/:]+\/[^/]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"))?.[1];
    if (!repo) throw new Error("cannot tell the repository: pass --repo owner/name");
    const out = execFileSync("gh", ["api", "--paginate", `repos/${repo}/pulls?state=closed&base=main&per_page=100`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    all = out.trim().startsWith("[") ? JSON.parse(out.replace(/\]\s*\[/g, ",")) : [];
  }
  // The last release: given, or the merge of the newest pull request titled "Release x.y.z" (P3). The very first release has none: pass --since.
  const since = arg("--since") ?? lastReleaseCommit(all);
  if (!since) throw new Error("no earlier release pull request found: pass --since <commit of the last release>");
  const commits = git("rev-list", `${since}..HEAD`).split("\n").filter(Boolean);
  const prs = mergedSince(all, commits);
  const release = buildRelease({ prs, version, date });
  const body = renderPrBody({ release, version, previous, bump, minAppVersion: `${manifest.minAppVersion}` });

  console.log(`Release ${version} (${bump} from ${previous}), ${prs.length} pull request(s) since ${since.slice(0, 7)}:`);
  for (const l of release.scopeLines) console.log(`  ${l}`);
  if (release.undeclared.length > 0) console.log(`  without note/steps sections (read them): ${release.undeclared.map((p) => `#${p.number}`).join(", ")}`);
  console.log(`\nCHANGELOG section:\n${release.changelogSection}`);
  if (dry) {
    console.log("--dry: nothing written.");
    return;
  }

  manifest.version = version;
  writeJson("manifest.json", manifest);
  const pkg = readJson("package.json");
  pkg.version = version;
  writeJson("package.json", pkg);
  try {
    const lock = readJson("package-lock.json");
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeJson("package-lock.json", lock);
  } catch { /* no lockfile */ }
  const versions = readJson("versions.json");
  versions[version] = manifest.minAppVersion;
  writeJson("versions.json", versions);
  writeFileSync("CHANGELOG.md", insertChangelogSection(readFileSync("CHANGELOG.md", "utf8"), release.changelogSection));
  const out = arg("--body-out");
  if (out) writeFileSync(out, body);
  console.log(`Wrote manifest.json, package.json, package-lock.json, versions.json, CHANGELOG.md${out ? ` and ${out}` : ""}. Next: review, commit, push, open the pull request "Release ${version}".`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
