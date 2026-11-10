// The consistency checks a stable release must pass (M3 WP2 step 3b-2a): the version in manifest.json, package.json and versions.json agree and are a plain x.y.z,
// the plugin id is `blyg`, the name is not a dev build's, the CHANGELOG has a section for the version, and the version is above the newest published release.
// Leaks (secrets, private names) are NOT checked here: scripts/public-scan.mjs and gitleaks do that.
//
//   node scripts/release-check.mjs [--dir DIR] [--mode dry-run|release] [--latest X.Y.Z]
//
// In `release` mode every finding is an error and --latest is required (fail closed: the newest published stable version, or 0.0.0 if there is none). In `dry-run`
// (a pull request) the id, the CHANGELOG section and the version order are only warnings, because a pull request is not the release; the version rules stay errors.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const STABLE_RE = /^\d+\.\d+\.\d+$/;

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** @returns {{errors: string[], warnings: string[]}} */
export function checkRelease(dir, opts) {
  const release = opts.mode === "release";
  const errors = [];
  const warnings = [];
  const timed = (msg) => (release ? errors : warnings).push(msg);
  for (const must of ["manifest.json", "package.json", "versions.json", "CHANGELOG.md"]) {
    if (!existsSync(join(dir, must))) errors.push(`${must}: missing`);
  }
  if (errors.length > 0) return { errors, warnings };
  let manifest, pkg, versions;
  try {
    const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    manifest = read("manifest.json"); pkg = read("package.json"); versions = read("versions.json");
  } catch (e) {
    return { errors: [`a JSON file does not parse: ${e.message}`], warnings };
  }
  const v = String(manifest.version);
  if (pkg.version !== v) errors.push(`manifest.json (${v}) and package.json (${pkg.version}) disagree`);
  if (!STABLE_RE.test(v)) errors.push(`version "${v}" must be a plain x.y.z (no -rc, -dev, -beta, v prefix)`);
  if (!versions[v]) errors.push(`versions.json has no entry for ${v}`);
  if (manifest.id !== "blyg") timed(`manifest id is "${manifest.id}", the public plugin id must be "blyg"`);
  if (/dev|beta/i.test(String(manifest.name))) errors.push(`manifest name "${manifest.name}" looks like a dev build`);
  const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## \\[${v.replaceAll(".", "\\.")}\\]`, "m").test(changelog)) timed(`CHANGELOG.md has no "## [${v}]" section`);
  if (opts.latest) {
    if (!STABLE_RE.test(opts.latest)) errors.push(`latest published version "${opts.latest}" is not x.y.z`);
    else if (STABLE_RE.test(v) && cmp(v, opts.latest) <= 0) timed(`version ${v} is not above the latest published release ${opts.latest}`);
  } else if (release) {
    errors.push("release mode needs --latest (the newest published stable version, or 0.0.0 if there is none)");
  }
  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const mode = opt("--mode") ?? "dry-run";
  if (!["dry-run", "release"].includes(mode)) throw new Error(`unknown mode "${mode}"`);
  const { errors, warnings } = checkRelease(opt("--dir") ?? ".", { mode, latest: opt("--latest") });
  for (const w of warnings) console.warn(`::warning::${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::${e}`);
    console.error(`release-check: ${errors.length} error(s) (${mode})`);
    process.exit(1);
  }
  console.log(`release-check: ok (${mode}, ${warnings.length} warning(s)).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(`::error::${e.message}`); process.exit(2); }
}
