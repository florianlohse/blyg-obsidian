// The end-of-run report of run-scenarios.mjs: pure functions (tests/scripts/e2e-report.test.ts). Nothing here decides pass or fail.

/** GitHub workflow-command escaping for the message of `::error::`. */
export const escapeAnnotation = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** rows: { name, attempts: [{ attempt, code, failures: string[], seconds }] } -> every failing check of every attempt. */
export function failedChecks(rows) {
  const out = [];
  for (const r of rows) for (const a of r.attempts) {
    if (a.code === 0 || a.code === 2) continue;
    const list = a.failures.length ? a.failures : [`(no failing check was reported; the scenario exited with code ${a.code})`];
    for (const f of list) out.push({ scenario: r.name, attempt: a.attempt, check: f });
  }
  return out;
}

export const failedChecksBlock = (list) => (list.length === 0 ? "" : ["", "FAILED CHECKS", ...list.map((f) => `  [${f.scenario}, attempt ${f.attempt}] ${f.check}`)].join("\n"));

/** "FLAKY: ..." lines for the scenarios that passed only on a retry. */
export function flakyNotes(rows) {
  return rows.filter((r) => r.attempts.length > 1 && r.attempts.at(-1).code === 0).map((r) => {
    const first = r.attempts[0].failures[0] ?? `exit code ${r.attempts[0].code}`;
    return { scenario: r.name, text: `FLAKY: passed on retry; first attempt failed with: ${first}` };
  });
}

/** The job summary (markdown). Empty when everything passed first time. */
export function summaryMarkdown(rows) {
  const failed = failedChecks(rows);
  const flaky = flakyNotes(rows);
  const lines = ["## Real-Obsidian UI scenarios", "", "| scenario | result | seconds | attempts |", "| --- | --- | --- | --- |"];
  for (const r of rows) {
    const last = r.attempts.at(-1);
    const result = last.code === 0 ? (r.attempts.length > 1 ? "FLAKY (passed on retry)" : "ok") : "FAIL";
    lines.push(`| ${r.name} | ${result} | ${r.attempts.map((a) => a.seconds).join(" + ")} | ${r.attempts.length} |`);
  }
  if (flaky.length) lines.push("", ...flaky.map((f) => `- **${f.scenario}** — ${f.text}`));
  if (failed.length) lines.push("", "### Failed checks", "", ...failed.map((f) => `- \`${f.scenario}\` attempt ${f.attempt}: ${f.check.replace(/\|/g, "\\|")}`));
  if (failed.length) lines.push("", "Screenshots, page state, settings (redacted) and the console log of each failed attempt are in the workflow artifact `obsidian-ui-failures` (kept 7 days).");
  return lines.join("\n") + "\n";
}
