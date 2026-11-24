// Runs every scenario in tests/e2e/obsidian/scenarios/ in its own Obsidian (a fresh copy of the fixture vault each), one after the other, and says
// which passed. A scenario that fails is run ONCE more; if it passes then, it is reported as FLAKY (a GitHub warning, never hidden), if not it is red.
// P6 (docs/plans/P6-ui-regression.md). Used by `npm run test:obsidian:ui` and the `obsidian-ui` job of ci.yml. Pass names to run only those:
//   node tests/e2e/obsidian/run-scenarios.mjs publish-loop
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "./artifacts.mjs";
import { escapeAnnotation, failedChecks, failedChecksBlock, flakyNotes, summaryMarkdown } from "./report.mjs";

// A failed attempt (the first of a retried scenario too) leaves screenshots, page state, redacted settings and the console log in E2E_FAIL_DIR/<scenario>-attempt<n>/
// (CI uploads that folder when the job fails). At the end: a FAILED CHECKS block, and in GitHub Actions the job summary and ::error:: annotations.
const failDir = process.env.E2E_FAIL_DIR ?? join(tmpdir(), "blyg-e2e-failures");
const scratch = mkdtempSync(join(tmpdir(), "blyg-e2e-run-"));

const dir = join(dirname(fileURLToPath(import.meta.url)), "scenarios");
const only = process.argv.slice(2);
const names = readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, "")).filter((n) => only.length === 0 || only.includes(n)).sort();
if (names.length === 0) { console.error("no scenario found"); process.exit(2); }

const run = (name, attempt) => {
  const t0 = Date.now();
  const resultFile = join(scratch, `${name}-${attempt}.json`);
  const r = spawnSync(process.execPath, [join(dir, `${name}.mjs`)], { stdio: "inherit", env: { ...process.env, E2E_FAIL_DIR: failDir, E2E_SCENARIO: name, E2E_ATTEMPT: String(attempt), E2E_RESULT_FILE: resultFile } });
  let failures = [];
  try { failures = JSON.parse(readFileSync(resultFile, "utf8")).failures ?? []; failures = failures.map((f) => redactText(f, [process.env.STUDIO_E2E_TOKEN])); } catch { /* no result file: the scenario died before it could write one */ }
  return { attempt, code: r.status ?? 1, seconds: Math.round((Date.now() - t0) / 1000), failures };
};

const rows = [];
for (const name of names) {
  console.log(`\n=== ${name}`);
  const attempts = [run(name, 1)];
  let r = attempts[0];
  const retried = r.code !== 0 && r.code !== 2;
  if (retried) {
    console.log(`\n=== ${name}: failed, running it once more`);
    r = run(name, 2);
    attempts.push(r);
  }
  rows.push({ name, code: r.code, seconds: r.seconds, retried, attempts });
  if (retried && r.code === 0) console.log(`::warning title=Flaky UI scenario::${name} failed once and passed on the retry`);
  if (r.code !== 0) console.log(`::error title=UI scenario failed::${name}`);
}
console.log("\n--- summary");
for (const r of rows) console.log(`${r.code === 0 ? (r.retried ? "FLAKY" : "ok   ") : "FAIL "} ${r.name} (${r.seconds} s)`);

// ---- the readable part: what failed, and what passed only on a retry (never changes the exit code below)
const failed = failedChecks(rows);
const flaky = flakyNotes(rows);
for (const f of flaky) console.log(`${f.scenario}: ${f.text}`);
const block = failedChecksBlock(failed);
if (block) console.log(block + `\n\n(screenshots, page state, redacted settings and console of each failed attempt: ${failDir})`);
for (const f of failed) console.log(`::error title=UI check failed (${escapeAnnotation(f.scenario)}, attempt ${f.attempt})::${escapeAnnotation(f.check)}`);
for (const f of flaky) console.log(`::warning title=FLAKY ${escapeAnnotation(f.scenario)}::${escapeAnnotation(f.text)}`);
if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(rows)); } catch { /* the summary is a courtesy */ } }
rmSync(scratch, { recursive: true, force: true });
process.exit(rows.some((r) => r.code !== 0) ? 1 : 0);
