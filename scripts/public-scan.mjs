// The leak scan for anything that becomes public (M3 WP2 step 2, docs/plans/M3-wp2-execution.md). It checks three things with the same rules:
// the files of a tree, a pull request title and body, commit messages, and what every commit of a range ADDED (a secret added in one commit and removed in the next stays
// in the public history, so the head of the tree is not enough). The same rules apply to all of them. Secret shapes and forbidden strings ("needles") both fail the scan.
//
//   node scripts/public-scan.mjs [--tree DIR] [--pr-title-env VAR] [--pr-body-env VAR] [--commits RANGE] [--history RANGE] [--needles FILE] [--require-private]
//
// Needles: the generic list in --needles (default .github/release/public-needles.txt, safe to publish) plus the PRIVATE needles from the environment variable
// PRIVATE_NEEDLES (same format, kept in an Actions secret, never in a file of the public repo). A private needle is REPORTED BY NUMBER ONLY: a public CI log must
// not spell the value it guards. Fail closed: no needles at all is an error; with --require-private an empty PRIVATE_NEEDLES is an error too (fork pull requests
// get no secrets, so their workflow omits the flag; their code is public anyway). gitleaks runs beside this in CI as the second net.
// Needle format, one per line:  needle [ | comma-separated paths where it IS allowed (exact file or "dir/") ]. Case-insensitive, literal, # comments.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Secret shapes that must never be in a public tree. Deliberately few and precise. */
export const SECRET_PATTERNS = [
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

/** @returns {{needle: string, allowed: string[]}[]} */
export function parseForbidden(text) {
  const rules = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [needle, allowed = ""] = line.split("|");
    rules.push({ needle: needle.trim().toLowerCase(), allowed: allowed.split(",").map((s) => s.trim()).filter(Boolean) });
  }
  return rules;
}

/**
 * Marks each rule public (may be named in a message) or private (named by number only). Private rules come after the public ones. A private line that repeats a
 * public needle is dropped: the public rule already covers it (with its own path exceptions) and the private copy would only report the same hit a second time and
 * inflate the private count. The private list may therefore be the whole old list, generic lines included.
 */
export function buildRules(publicText, privateText) {
  const pub = parseForbidden(publicText).map((r) => ({ ...r, private: false }));
  const known = new Set(pub.map((r) => r.needle));
  const priv = [];
  for (const r of parseForbidden(privateText)) {
    if (known.has(r.needle)) continue;
    known.add(r.needle);
    priv.push({ ...r, private: true, n: priv.length + 1 });
  }
  return [...pub, ...priv];
}

/** Labels are file paths and commit subjects, which can themselves carry a needle: private ones are replaced by their number before anything is printed. */
function redact(label, rules) {
  let out = label;
  for (const r of rules) if (r.private) out = out.replace(new RegExp(r.needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), `[private needle #${r.n}]`);
  return out;
}

const name = (r) => (r.private ? `private needle #${r.n}` : `forbidden string "${r.needle}"`);

/** Problems in one piece of text. `path` is null for a PR body or a commit message (path exceptions then never apply). */
export function scanText(rawLabel, text, rules, path = null) {
  const label = redact(rawLabel, rules);
  const problems = [];
  for (const [what, re] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${label}: looks like a secret (${what})`);
  const lower = text.toLowerCase();
  for (const r of rules) {
    if (!lower.includes(r.needle)) continue;
    if (path && r.allowed.some((a) => (a.endsWith("/") ? path.startsWith(a) : path === a))) continue;
    problems.push(`${label}: contains ${name(r)}`);
  }
  return problems;
}

const text_ok = (path, r) => r.allowed.some((a) => (a.endsWith("/") ? path.startsWith(a) : path === a));

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ path: relative(base, full).split(sep).join("/"), full, st });
  }
  return out;
}

/** Every text file of the tree; a link, an oversized file or a file that cannot be read is a problem (fail closed), a binary file is skipped. */
export function scanTree(dir, rules) {
  const problems = [];
  for (const { path, full, st } of walk(dir)) {
    if (st.isSymbolicLink()) { problems.push(`${path}: is a link`); continue; }
    if (st.size > MAX_FILE_BYTES) { problems.push(`${path}: larger than ${MAX_FILE_BYTES} bytes, not scanned`); continue; }
    const buf = readFileSync(full);
    if (buf.subarray(0, 4096).includes(0)) continue;
    problems.push(...scanText(path, buf.toString("utf8"), rules, path));
    for (const r of rules) if (path.toLowerCase().includes(r.needle) && !text_ok(path, r)) problems.push(`${redact(path, rules)}: its path contains ${name(r)}`);
  }
  return problems;
}

export const scanPrBody = (body, rules) => scanText("pull request body", String(body ?? ""), rules);
export const scanPrTitle = (title, rules) => scanText("pull request title", String(title ?? ""), rules);

/**
 * GitHub writes "Merge pull request #N from <owner>/<branch>" into every merge commit it makes. The owner is the account that owns the head repository, public by
 * construction and unavoidable here, so it is taken out before scanning; the branch name after it is still scanned.
 */
export const withoutMergeOwner = (message) => message.replace(/^(Merge pull request #\d+ from )[^\s/]+\//, "$1");

/** @param {string[]} messages full commit messages, newest first */
export function scanCommits(messages, rules) {
  return messages.flatMap((raw, i) => {
    const m = withoutMergeOwner(raw);
    return scanText(`commit message ${i + 1} (${m.split("\n")[0].slice(0, 50)})`, m, rules);
  });
}

/**
 * Parses `git log -p -U0` output into the lines each commit ADDED to each file: [{ sha, path, text }]. Merge commits show no diff and are skipped; deleted files have no
 * added lines; a binary file shows none either.
 */
export function addedLines(logOutput) {
  const out = [];
  let sha = "";
  let path = null;
  let cur = null;
  for (const line of logOutput.split("\n")) {
    if (line.startsWith("@@@")) { sha = line.slice(3).trim(); path = null; cur = null; continue; }
    if (line.startsWith("diff --git ")) { path = null; cur = null; continue; }
    if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice(6) : null;
      cur = path ? { sha, path, text: "" } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (cur && line.startsWith("+")) cur.text += `${line.slice(1)}\n`;
  }
  return out;
}

/** What every commit of a range added, scanned like a file of that path (path exceptions apply). */
export function scanHistory(range, rules, cwd = ".") {
  const raw = execFileSync("git", ["log", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=@@@%H", range], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return addedLines(raw).flatMap(({ sha, path, text }) => {
    const where = `(added in commit ${sha.slice(0, 7)})`;
    const inPath = rules.filter((r) => path.toLowerCase().includes(r.needle) && !text_ok(path, r)).map((r) => `${redact(path, rules)} ${where}: its path contains ${name(r)}`);
    return [...scanText(`${path} ${where}`, text, rules, path), ...inPath];
  });
}

/** Commit messages of a range such as origin/main..HEAD, split on a marker no message contains. */
export function commitMessages(range, cwd = ".") {
  const mark = "\u0001--commit--\u0001";
  const raw = execFileSync("git", ["log", `--format=${mark}%B`, range], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return raw.split(mark).map((s) => s.trim()).filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const needlesFile = opt("--needles") ?? ".github/release/public-needles.txt";
  if (!existsSync(needlesFile)) throw new Error(`needle list ${needlesFile} not found: refusing to scan without it`);
  const privateText = process.env.PRIVATE_NEEDLES ?? "";
  const rules = buildRules(readFileSync(needlesFile, "utf8"), privateText);
  if (rules.length === 0) throw new Error("no needles at all: refusing to scan without any");
  if (args.includes("--require-private") && !rules.some((r) => r.private)) throw new Error("PRIVATE_NEEDLES is empty or not set, and --require-private was given: refusing to scan");
  const problems = [];
  const checked = [];
  const tree = opt("--tree");
  if (tree) { problems.push(...scanTree(tree, rules)); checked.push("the tree"); }
  const titleVar = opt("--pr-title-env");
  if (titleVar) { problems.push(...scanPrTitle(process.env[titleVar] ?? "", rules)); checked.push("the pull request title"); }
  const bodyVar = opt("--pr-body-env");
  if (bodyVar) { problems.push(...scanPrBody(process.env[bodyVar] ?? "", rules)); checked.push("the pull request body"); }
  const range = opt("--commits");
  if (range) { problems.push(...scanCommits(commitMessages(range), rules)); checked.push(`the commit messages of ${range}`); }
  const history = opt("--history");
  if (history) { problems.push(...scanHistory(history, rules)); checked.push(`what the commits of ${history} added`); }
  if (checked.length === 0) throw new Error("nothing to scan: give --tree, --pr-title-env, --pr-body-env, --commits or --history");
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error(`public-scan: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`public-scan: clean (${checked.join(", ")}; ${rules.length} needles, ${rules.filter((r) => r.private).length} private).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(`::error::${e.message}`); process.exit(2); }
}
