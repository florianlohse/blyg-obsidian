// Which changed files affect the built plugin? Reads file paths (one per line) on stdin and prints the ones that are inputs of the plugin build. Used by dev-build.yml:
// a merge into main that changes only tests, docs, workflows or release scripts makes no dev build. An input is an exact file or a directory prefix ending in "/".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BUILD_INPUTS = [
  "src/", "styles.css", "manifest.json", "package.json", "package-lock.json", "esbuild.config.mjs", "tsconfig.json", "scripts/flavour.mjs",
];

/** @param {string[]} paths @returns {string[]} the ones that are build inputs */
export function devBuildChanges(paths) {
  return paths
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .filter((p) => BUILD_INPUTS.some((i) => (i.endsWith("/") ? p.startsWith(i) : p === i)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const hits = devBuildChanges(readFileSync(0, "utf8").split("\n"));
  if (hits.length > 0) console.log(hits.join("\n"));
}
