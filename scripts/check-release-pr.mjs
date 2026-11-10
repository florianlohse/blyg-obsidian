// A release pull request ("Release x.y.z") cannot be merged while its checklist has unticked boxes (M2 P3, the maintainer 2026-11-06): merging it is the go for the
// release. Reads PR_TITLE and PR_BODY; any other pull request passes. Not shipped.
import { fileURLToPath } from "node:url";
import { unticked } from "./release-notes.mjs";

export const isReleasePr = (title) => /^Release \d+\.\d+\.\d+$/.test(String(title ?? "").trim());

/** @returns {string[]} one line per problem */
export function releasePrProblems(title, body) {
  if (!isReleasePr(title)) return [];
  return unticked(body).map((t) => `Not ticked yet: ${t}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = releasePrProblems(process.env.PR_TITLE, process.env.PR_BODY);
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(isReleasePr(process.env.PR_TITLE) ? "Every box of the release checklist is ticked." : "Not a release pull request: nothing to check.");
}
