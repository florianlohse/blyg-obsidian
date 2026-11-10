// Every pull request declares two things (M2 P4, the maintainer 2026-11-06): a user-facing note (or "none") and the device steps (or "none: ..."), so the release
// pull request can be assembled from them (docs/plans/M2-release-pipeline-v2.md). Reads the pull request body from the environment variable PR_BODY and exits 1
// with a plain message when a section is missing or empty (HTML comments, the template's hints, do not count as text). Not shipped (not on the allow-list).
import { fileURLToPath } from "node:url";

export const SECTIONS = ["User-facing note", "Device steps"];

/** The text of a `## Heading` section: up to the next `## ` heading, HTML comments removed, trimmed. Null when the heading is missing. */
export function sectionText(body, heading) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(l.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** @returns {string[]} the problems, empty when the body declares both sections */
export function prBodyProblems(body) {
  const problems = [];
  for (const heading of SECTIONS) {
    const text = sectionText(body, heading);
    if (text === null) problems.push(`The section "## ${heading}" is missing (see .github/pull_request_template.md).`);
    else if (text === "") problems.push(`The section "## ${heading}" is empty: say what it is, or write "none".`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = prBodyProblems(process.env.PR_BODY ?? "");
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log("The pull request declares its user-facing note and its device steps.");
}
