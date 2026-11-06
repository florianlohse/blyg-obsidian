// Build flavours (M1, A1.1). The plugin code is the same in both; only the manifest differs, so the two can sit side by side in one vault
// and never share a data.json:
//   blyg      the release flavour: the id and name of manifest.json as they are (A2.1 makes the id `blyg`).
//   blyg-dev  the development flavour: id `<manifest id>-dev`, name `<manifest name> (dev)`.
// The dev id is DERIVED from manifest.json here, never written into it, so this does not depend on which id the manifest holds.
//
//   node scripts/flavour.mjs <blyg|blyg-dev> [OUTDIR]
//
// BLYG_VERSION, if set, replaces the version in the written manifest (the dev build workflow sets it to x.y.z-dev.N).
// Takes main.js and styles.css (from `npm run build`) and manifest.json, writes OUTDIR (default dist/<flavour>/) with the three files a
// release carries. Prints nothing secret; reads nothing but these files.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FLAVOURS = ["blyg", "blyg-dev"];

/** Obsidian's plugin id rules (also the directory's): lowercase letters, digits, dashes. */
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * @param {{id: string, name: string, version: string, [k: string]: unknown}} manifest the repository's manifest.json
 * @param {string} flavour "blyg" | "blyg-dev"
 */
export function manifestFor(manifest, flavour) {
  if (!FLAVOURS.includes(flavour)) throw new Error(`Unknown flavour "${flavour}" (use ${FLAVOURS.join(" or ")}).`);
  const baseId = String(manifest.id).replace(/-dev$/, "");
  const baseName = String(manifest.name).replace(/ \(dev\)$/, "");
  if (!ID_PATTERN.test(baseId)) throw new Error(`manifest.json id "${manifest.id}" is not a valid plugin id.`);
  if (flavour === "blyg") return { ...manifest, id: baseId, name: baseName };
  return { ...manifest, id: `${baseId}-dev`, name: `${baseName} (dev)` };
}

/**
 * The version rules of the two flavours (docs/RELEASING.md). A stable release has a plain x.y.z; a dev pre-release is x.y.z-dev.N
 * (N counts up from 1 for the same x.y.z). Anything else (-beta, build metadata, a leading v) is refused.
 */
export function versionKind(version) {
  if (/^\d+\.\d+\.\d+$/.test(version)) return "stable";
  if (/^\d+\.\d+\.\d+-dev\.\d+$/.test(version)) return "dev";
  return "invalid";
}

/**
 * The next dev pre-release version for a manifest version: `<x.y.z>-dev.<N>`, N one above the highest existing tag of that base.
 * @param {string} base the manifest's stable version, e.g. "0.9.0"
 * @param {string[]} existingTags release tags that exist, e.g. ["0.9.0-dev.1", "0.7.0"]
 */
export function nextDevVersion(base, existingTags) {
  if (versionKind(base) !== "stable") throw new Error(`manifest.json version "${base}" must be a plain x.y.z; the dev suffix is added by the release.`);
  const prefix = `${base}-dev.`;
  let highest = 0;
  for (const tag of existingTags) {
    if (!tag.startsWith(prefix)) continue;
    const n = Number(tag.slice(prefix.length));
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return `${prefix}${highest + 1}`;
}

/**
 * Compare two release tags of the forms this repo uses (`x.y.z` and `x.y.z-dev.N`, optionally `x.y.z-rc.N`) the way semver does, which is how BRAT
 * orders releases ("Latest" is the highest-semver release that is not a pre-release, BRAT 2.2.0 `grabReleaseFromRepository`). Returns a negative
 * number, 0 or a positive number; null when either tag is not of those forms (such a tag is ignored by the caller).
 * @param {string} a @param {string} b
 */
export function compareReleaseTags(a, b) {
  const parse = (t) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(t);
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? { id: m[4], n: Number(m[5]) } : null } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1; // a release is above its own pre-releases
  if (!y.pre) return -1;
  if (x.pre.id !== y.pre.id) return x.pre.id < y.pre.id ? -1 : 1; // semver compares identifiers as text
  return x.pre.n - y.pre.n;
}

/**
 * The existing NORMAL (non-pre-release) release tags that a new dev build would NOT outrank. BRAT's "Latest" is the highest-semver normal
 * release, so a dev build published as a normal release is offered as Latest only if this list is empty (decision D3, 2026-11-06).
 * @param {string} version the new dev version @param {{tagName: string, isPrerelease: boolean}[]} releases
 */
export function normalReleasesAbove(version, releases) {
  return releases.filter((r) => !r.isPrerelease).map((r) => r.tagName).filter((t) => {
    const c = compareReleaseTags(t, version);
    return c !== null && c >= 0;
  });
}

function main() {
  const [flavour, outArg] = process.argv.slice(2);
  if (!flavour) throw new Error("usage: node scripts/flavour.mjs <blyg|blyg-dev> [OUTDIR]  (BLYG_VERSION=<v> overrides the manifest version in the output)");
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  if (process.env.BLYG_VERSION) manifest.version = process.env.BLYG_VERSION;
  const out = resolve(outArg ?? join("dist", flavour));
  for (const f of ["main.js", "styles.css"]) {
    if (!existsSync(f)) throw new Error(`${f} is missing: run \`npm run build\` first.`);
  }
  mkdirSync(out, { recursive: true });
  copyFileSync("main.js", join(out, "main.js"));
  copyFileSync("styles.css", join(out, "styles.css"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifestFor(manifest, flavour), null, 2) + "\n");
  console.log(`wrote ${out} (id ${manifestFor(manifest, flavour).id})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
