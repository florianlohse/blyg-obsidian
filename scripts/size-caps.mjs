// Size caps for the two files that grow with every feature: a file may not get longer than its cap in scripts/size-caps.json (lines, as `wc -l` counts them).
// New logic goes into its own module (src/app/, src/ui/), not into these. The caps only go down: when a change shortens a file, lower its cap in scripts/size-caps.json to the new length (the check prints a reminder); never raise one.
// Runs as part of `npm test` (tests/scripts/size-caps.test.ts), so CI enforces it. Also usable directly: `node scripts/size-caps.mjs`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string} text @returns {number} the number of lines, counted like `wc -l` */
export function lineCount(text) {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * @param {Record<string, number>} caps file path (relative to the repository) -> most lines allowed
 * @param {(path: string) => string} read the file's text
 * @returns {string[]} one message per file over its cap; empty when all is well
 */
export function checkSizeCaps(caps, read) {
  const problems = [];
  for (const [file, cap] of Object.entries(caps)) {
    const lines = lineCount(read(file));
    if (lines > cap) problems.push(`${file} has ${lines} lines, over its cap of ${cap}. Put new logic in its own module (src/app/ or src/ui/) instead of growing this file. Caps only go down: shorten the file, do not raise the cap.`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(here, "..");
  const caps = JSON.parse(readFileSync(join(here, "size-caps.json"), "utf8"));
  const problems = checkSizeCaps(caps, (f) => readFileSync(join(root, f), "utf8"));
  for (const [file, cap] of Object.entries(caps)) {
    const lines = lineCount(readFileSync(join(root, file), "utf8"));
    if (lines < cap) console.log(`${file} is ${lines} lines, under its cap of ${cap}: lower the cap in scripts/size-caps.json to ${lines}.`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}
