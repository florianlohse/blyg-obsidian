// Runs every scenario in tests/e2e/obsidian/scenarios/ in its own Obsidian (a fresh copy of the fixture vault each), one after the other, and says
// which passed. A scenario that fails is run ONCE more; if it passes then, it is reported as FLAKY (a GitHub warning, never hidden), if not it is red.
// P6 (docs/plans/P6-ui-regression.md). Used by `npm run test:obsidian:ui` and the `obsidian-ui` job of ci.yml. Pass names to run only those:
//   node tests/e2e/obsidian/run-scenarios.mjs publish-loop
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "scenarios");
const only = process.argv.slice(2);
const names = readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, "")).filter((n) => only.length === 0 || only.includes(n)).sort();
if (names.length === 0) { console.error("no scenario found"); process.exit(2); }

const run = (name) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(dir, `${name}.mjs`)], { stdio: "inherit", env: process.env });
  return { code: r.status ?? 1, seconds: Math.round((Date.now() - t0) / 1000) };
};

const rows = [];
for (const name of names) {
  console.log(`\n=== ${name}`);
  let r = run(name);
  let retried = false;
  if (r.code !== 0 && r.code !== 2) {
    console.log(`\n=== ${name}: failed, running it once more`);
    retried = true;
    r = run(name);
  }
  rows.push({ name, code: r.code, seconds: r.seconds, retried });
  if (retried && r.code === 0) console.log(`::warning title=Flaky UI scenario::${name} failed once and passed on the retry`);
  if (r.code !== 0) console.log(`::error title=UI scenario failed::${name}`);
}
console.log("\n--- summary");
for (const r of rows) console.log(`${r.code === 0 ? (r.retried ? "FLAKY" : "ok   ") : "FAIL "} ${r.name} (${r.seconds} s)`);
process.exit(rows.some((r) => r.code !== 0) ? 1 : 0);
