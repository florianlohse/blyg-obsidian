// P3b (the maintainer, 2026-11-06): merging the pull request "Release x.y.z" is the go for the public release. This decides, for a push to main, whether that push is the merge of
// such a pull request and whether it may release; it never publishes anything itself: `.github/workflows/release-on-merge.yml` then dispatches the release workflow for that
// version, whose own locks (the variable PUBLIC_RELEASE_ENABLED, the public-release environment, the release checks) all still apply. Fails closed: a release pull
// request that is inconsistent is a problem to read, not a release. Not shipped.
//
// The pull request is found by GitHub's link from the pushed commit to its pull request, and judged by ITS TITLE, not by the commit message: a merge made in the GitHub app or on
// the web is a "Merge pull request #N from …" commit that carries no title at all (found the hard way on the first release, 2026-11-06), and a squash merge has a title subject.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { releasePrProblems } from "./check-release-pr.mjs";

export const RELEASE_TITLE = /^Release (\d+\.\d+\.\d+)$/;

/**
 * @param {{sha: string, prs: {number: number, title: string, body?: string | null, merged_at?: string | null, merge_commit_sha?: string | null}[], manifestVersion: string, changelog: string}} i
 * @returns {{release: false, reason: string} | {release: true, version: string, pr: number} | {release: false, problems: string[]}}
 */
export function releasePlan(i) {
  const pr = i.prs.find((p) => p.merged_at && p.merge_commit_sha === i.sha && RELEASE_TITLE.test(p.title.trim()));
  if (!pr) return { release: false, reason: "not the merge of a release pull request" };
  const version = /** @type {RegExpExecArray} */ (RELEASE_TITLE.exec(pr.title.trim()))[1];
  const problems = [...releasePrProblems(pr.title, pr.body ?? "")];
  if (i.manifestVersion !== version) problems.push(`manifest.json says ${i.manifestVersion}, the pull request says ${version}.`);
  if (!new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m").test(i.changelog)) problems.push(`CHANGELOG.md has no "## [${version}]" section.`);
  return problems.length > 0 ? { release: false, problems } : { release: true, version, pr: pr.number };
}

function main() {
  const sha = process.env.SHA ?? "";
  const repo = process.env.REPO ?? "";
  if (!sha || !repo) throw new Error("SHA and REPO are required");
  const prs = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/commits/${sha}/pulls`], { encoding: "utf8" }));
  const plan = releasePlan({ sha, prs, manifestVersion: JSON.parse(readFileSync("manifest.json", "utf8")).version, changelog: readFileSync("CHANGELOG.md", "utf8") });
  const out = process.env.GITHUB_OUTPUT;
  const set = (k, v) => (out ? appendFileSync(out, `${k}=${v}\n`) : console.log(`${k}=${v}`));
  if (plan.release) {
    console.log(`Release ${plan.version}: pull request #${plan.pr} is merged, every box is ticked, the version and the CHANGELOG agree.`);
    set("release", "true");
    set("version", plan.version);
    return;
  }
  set("release", "false");
  if ("problems" in plan) {
    for (const p of plan.problems) console.error(`::error::${p}`);
    process.exit(1); // a release pull request that is not in order must be seen, not skipped
  }
  console.log(`No release: ${plan.reason}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
