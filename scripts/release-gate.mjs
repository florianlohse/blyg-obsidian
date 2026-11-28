// The publication gate of a stable release (REVIEW-198 C1). `release.yml` runs it in the verify job of a release dispatch, before anything is kept for the publish job, and the
// publish job needs that job: a red gate means no release. It checks, from GitHub's own records and never from text anyone can edit:
//   1. the checkout is exactly the commit the merge dispatched (main did not advance in between) and is the merge commit of the pull request "Release x.y.z";
//   2. the repository OWNER confirmed the official Obsidian review preview for a full commit SHA, in a comment on that pull request (GitHub vouches for the author, so a contributor
//      cannot forge it): `Obsidian preview: <40-hex sha> Completed errors=0`. The newest such comment counts; Failed/Incomplete or errors > 0 blocks; older than MAX_AGE_DAYS is stale;
//   3. the reviewed commit has the SAME git TREE as the checkout, so a changed source file or version after the scan is caught, whatever the merge made of the commit SHA;
//   4. every required CI job succeeded on the reviewed commit (a job's own conclusion, never a workflow's overall result; skipped, cancelled, missing or pending all block);
//   5. the newest-Obsidian UI job has finished on it: success passes, a failure needs the owner's `Newest Obsidian UI accepted: <sha>`, a missing or pending result blocks.
// In dry-run mode (a pull request) it reports the same findings as warnings and never fails, so the mechanism is exercised on every release pull request without publishing.
// Not shipped. Needs `gh` and a token with contents, pull-requests, issues and checks read.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_AGE_DAYS = 7;
/** Jobs that must have succeeded on the candidate (their names as GitHub lists them). `obsidian-ui-newest` is handled apart (advisory, acknowledged). */
export const REQUIRED_JOBS = ["check", "guard", "verify", "declares", "ticked", "e2e (pinned)", "e2e (newest)", "obsidian-smoke", "obsidian-ui"];
export const NEWEST_JOB = "obsidian-ui-newest";
export const PREVIEW_RE = /^Obsidian preview: ([0-9a-f]{40}) (Completed|Failed|Incomplete) errors=(\d+)\s*$/im;
export const ACCEPT_RE = /^Newest Obsidian UI accepted: ([0-9a-f]{40})\s*$/im;
const RELEASE_TITLE = /^Release (\d+\.\d+\.\d+)$/;

/**
 * @typedef {{name: string, status: string, conclusion: string | null, id: number}} CheckRun
 * @typedef {{user?: {login?: string}, author_association?: string, body?: string | null, created_at: string}} Comment
 * @param {{
 *   mode: "release" | "dry-run", version: string, headSha: string, headTree: string, expectedSha: string, owner: string, now: Date,
 *   pr: {number: number, title: string, merged_at?: string | null, merge_commit_sha?: string | null} | null,
 *   comments: Comment[],
 *   commits: Record<string, {tree: string, checks: CheckRun[]}>,
 * }} i
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
export function releaseGate(i) {
  const problems = [];
  const notes = [];
  const release = i.mode === "release";

  if (release && i.headSha !== i.expectedSha) problems.push(`Main moved: the release was dispatched for ${i.expectedSha} but the checkout is ${i.headSha}. Nothing is published; re-run the merge's "Release on merge" job.`);
  if (!i.pr) problems.push("No pull request is linked to the release commit.");
  else {
    const m = RELEASE_TITLE.exec(i.pr.title.trim());
    if (!m) problems.push(`Pull request #${i.pr.number} is not titled "Release x.y.z".`);
    else if (m[1] !== i.version) problems.push(`Pull request #${i.pr.number} is for ${m[1]}, the release is ${i.version}.`);
    if (release && (!i.pr.merged_at || i.pr.merge_commit_sha !== i.headSha)) problems.push(`The checkout ${i.headSha} is not the merge commit of pull request #${i.pr.number}.`);
  }

  // 2. the owner's preview confirmation
  const mine = i.comments
    .filter((c) => c.user?.login === i.owner && c.author_association === "OWNER" && typeof c.body === "string")
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const previews = mine.flatMap((c) => {
    const m = PREVIEW_RE.exec(c.body ?? "");
    return m ? [{ sha: m[1], status: m[2], errors: Number(m[3]), at: Date.parse(c.created_at) }] : [];
  });
  const last = previews.at(-1);
  /** @type {{tree: string, checks: CheckRun[]} | undefined} */
  let reviewed;
  if (!last) problems.push(`No confirmed Obsidian preview: the owner has not commented "Obsidian preview: <full commit sha> Completed errors=0" on the release pull request.`);
  else {
    if (last.status !== "Completed" || last.errors !== 0) problems.push(`The owner's newest preview is ${last.status} with ${last.errors} error(s) for ${last.sha}: only Completed with errors=0 passes.`);
    if (i.now.getTime() - last.at > MAX_AGE_DAYS * 86400000) problems.push(`The confirmed preview is older than ${MAX_AGE_DAYS} days: scan again and confirm again.`);
    reviewed = i.commits[last.sha];
    if (!reviewed) problems.push(`The reviewed commit ${last.sha} is unknown to this repository.`);
    else if (reviewed.tree !== i.headTree) problems.push(`The release is not what was reviewed: tree ${i.headTree} differs from the tree ${reviewed.tree} of the reviewed commit ${last.sha}. Scan this candidate and confirm it.`);
    else notes.push(`Preview: confirmed by the owner for ${last.sha}, identical tree ${i.headTree}.`);
  }

  // 4./5. CI on the reviewed commit (only if it really is the same tree)
  if (reviewed && reviewed.tree === i.headTree && last) {
    /** @param {string} name */
    const latest = (name) => reviewed.checks.filter((c) => c.name === name).sort((a, b) => b.id - a.id)[0];
    for (const name of REQUIRED_JOBS) {
      const c = latest(name);
      if (!c) problems.push(`Required job "${name}" has no result on ${last.sha}.`);
      else if (c.status !== "completed") problems.push(`Required job "${name}" is still ${c.status} on ${last.sha}.`);
      else if (c.conclusion !== "success") problems.push(`Required job "${name}" did not succeed on ${last.sha} (${c.conclusion}).`);
    }
    const n = latest(NEWEST_JOB);
    if (!n) problems.push(`The newest-Obsidian UI job has no result on ${last.sha}: it must run and finish before a release.`);
    else if (n.status !== "completed") problems.push(`The newest-Obsidian UI job is still ${n.status} on ${last.sha}.`);
    else if (n.conclusion === "success") notes.push(`Newest Obsidian UI: success on ${last.sha}.`);
    else if (n.conclusion === "failure" || n.conclusion === "timed_out") {
      const accepted = mine.some((c) => ACCEPT_RE.exec(c.body ?? "")?.[1] === last.sha);
      if (accepted) notes.push(`Newest Obsidian UI: ${n.conclusion} on ${last.sha}, accepted by the owner (advisory).`);
      else problems.push(`The newest-Obsidian UI job ${n.conclusion} on ${last.sha} and the owner has not accepted it ("Newest Obsidian UI accepted: ${last.sha}").`);
    } else problems.push(`The newest-Obsidian UI job ended ${n.conclusion} on ${last.sha}: that is neither a result nor an accepted failure.`);
  }

  return { ok: problems.length === 0, problems, notes };
}

/** @param {string[]} args */
const gh = (args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
/** `--paginate --slurp` gives an array of pages. @param {string} path @param {string} [key] */
const pages = (path, key) => /** @type {any[]} */ (gh(["--paginate", "--slurp", path])).flatMap((p) => (key ? p[key] : p));

function main() {
  const mode = process.env.GATE_MODE === "release" ? "release" : "dry-run";
  const repo = process.env.REPO ?? "";
  const headSha = process.env.HEAD_SHA ?? "";
  if (!repo || !headSha) throw new Error("REPO and HEAD_SHA are required");
  const [owner] = repo.split("/");
  const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
  // A release judges the REAL checkout; a dry run (a pull request) judges the pull request's head, which is not checked out, so its tree comes from the API.
  const checkoutSha = mode === "release" ? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() : headSha;
  const treeOfHead = mode === "release" ? execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim() : gh([`repos/${repo}/git/commits/${headSha}`]).tree.sha;

  const prs = /** @type {any[]} */ (gh([`repos/${repo}/commits/${headSha}/pulls`]));
  const pr = process.env.PR_NUMBER
    ? prs.find((p) => String(p.number) === process.env.PR_NUMBER) ?? null
    : prs.find((p) => RELEASE_TITLE.test(String(p.title).trim())) ?? null;
  /** @type {Comment[]} */
  const comments = pr ? pages(`repos/${repo}/issues/${pr.number}/comments?per_page=100`) : [];

  // look up only the commits the owner named (a candidate for the tree/CI checks)
  /** @type {Record<string, {tree: string, checks: CheckRun[]}>} */
  const commits = {};
  for (const c of comments) {
    const m = c.user?.login === owner && c.author_association === "OWNER" ? PREVIEW_RE.exec(c.body ?? "") : null;
    if (!m || commits[m[1]]) continue;
    try {
      commits[m[1]] = { tree: gh([`repos/${repo}/git/commits/${m[1]}`]).tree.sha, checks: pages(`repos/${repo}/commits/${m[1]}/check-runs?per_page=100`, "check_runs") };
    } catch {
      /* unknown commit: the gate reports it */
    }
  }

  const r = releaseGate({ mode, version, headSha: checkoutSha, headTree: treeOfHead, expectedSha: process.env.EXPECTED_SHA ?? "", owner, now: new Date(), pr, comments, commits });
  const lines = [`Release gate (${mode}) for ${version}: ${r.ok ? "PASS" : "BLOCKED"}`, ...r.notes.map((n) => `- ok: ${n}`), ...r.problems.map((p) => `- blocked: ${p}`)];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  for (const p of r.problems) console.log(`::${mode === "release" ? "error" : "warning"}::${p}`);
  if (!r.ok && mode === "release") process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
