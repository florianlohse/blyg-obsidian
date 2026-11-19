// "README is website-ready" (WS1 phase 3). The README and CHANGELOG of a release can be shown as a web page by a generator that reads them at the
// release tag, so a problem is caught here, in the pull request, long before a release could carry it to a page. Generic: nothing about any particular
// site. What it checks, in plain terms:
//   - every image has alt text, its file exists, and no two images share a file name (a page keeps them in one folder);
//   - a relative link points at a file that exists;
//   - one `#` title, first, and no heading level is skipped (`##` straight to `####`);
//   - the title is followed by an opening paragraph;
//   - no raw HTML except `<img src alt width height>` (alone, in `<p>…</p>` on its own line, or in a table cell); no HTML comments;
//   - the same raw-HTML rule for CHANGELOG.md.
// Not shipped (not on the allow-list of the build). Run: `node scripts/check-readme.mjs [README.md CHANGELOG.md …]` from the repository root.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const IMG_RE = /!\[((?:[^\]\\]|\\.)*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;
const LINK_RE = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Lines with fenced code blanked out and inline code spans replaced by spaces; line numbers are kept. */
function scanLines(text) {
  let fence = null;
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return "";
    }
    return fence ? "" : line.replace(/`+[^`]*`+/g, (x) => " ".repeat(x.length));
  });
}

/** Raw HTML problems of one file: only `<img>` with src, alt, width, height may appear. */
export function htmlProblems(text) {
  const problems = [];
  scanLines(text).forEach((line, i) => {
    const n = i + 1;
    let rest = line;
    if (/^\s*<p>\s*<img\b[^<>]*>\s*<\/p>\s*$/.test(rest)) rest = rest.replace(/<\/?p>/g, "");
    rest = rest.replace(/<img\s+([^<>]*?)\s*\/?>/g, (_, attrs) => {
      const found = {};
      for (const m of attrs.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) found[m[1].toLowerCase()] = m[2];
      const left = attrs.replace(/([a-zA-Z][\w-]*)="([^"]*)"/g, "").trim();
      if (left) problems.push({ line: n, message: `an <img> has attributes that are not double-quoted name="value" pairs: ${left}` });
      for (const k of Object.keys(found)) if (!["src", "alt", "width", "height"].includes(k)) problems.push({ line: n, message: `<img ${k}="…"> is not allowed (src, alt, width and height only)` });
      if (!found.src || /[\s()]/.test(found.src)) problems.push({ line: n, message: `an <img> needs a src without spaces or brackets` });
      if (!found.alt || !found.alt.trim()) problems.push({ line: n, message: `the image ${found.src ?? ""} has no alt text` });
      return ` ![${found.alt ?? ""}](${found.src ?? ""}) `;
    });
    const raw = /<(?!https?:\/\/|mailto:)[A-Za-z\/!]/.exec(rest);
    if (raw) problems.push({ line: n, message: `raw HTML is not allowed here (only <img>): ${rest.slice(raw.index, raw.index + 30).trim()}` });
  });
  return problems;
}

/**
 * @param {string} readme   README.md text
 * @param {(path: string) => boolean} exists   does this repository-relative file exist?
 * @returns {{ line: number, message: string }[]}
 */
export function readmeProblems(readme, exists) {
  const problems = [...htmlProblems(readme)];
  const lines = scanLines(readme);
  // images (Markdown form and the normalised <img> form): alt, file, unique file names
  const names = new Map();
  const asMarkdown = lines.map((l) => l.replace(/^\s*<p>\s*(<img\b[^<>]*>)\s*<\/p>\s*$/, "$1").replace(/<img\s+([^<>]*?)\s*\/?>/g, (_, a) => {
    const src = /src="([^"]*)"/.exec(a)?.[1] ?? "";
    const alt = /alt="([^"]*)"/.exec(a)?.[1] ?? "";
    return `![${alt}](${src})`;
  }));
  asMarkdown.forEach((line, i) => {
    for (const m of line.matchAll(IMG_RE)) {
      const [, alt, src] = m;
      const n = i + 1;
      if (!alt.trim() && !problems.some((p) => p.line === n && /no alt text/.test(p.message))) problems.push({ line: n, message: `the image ${src} has no alt text` });
      if (!src || SCHEME.test(src) || src.startsWith("/")) continue;
      const path = posix.normalize(src.replace(/^\.\//, "").split(/[?#]/)[0]);
      if (!exists(path)) problems.push({ line: n, message: `the image ${path} does not exist` });
      const base = posix.basename(path);
      if (names.has(base) && names.get(base) !== path) problems.push({ line: n, message: `two images share the file name ${base} (${names.get(base)} and ${path})` });
      names.set(base, path);
    }
    for (const m of line.replace(IMG_RE, "").matchAll(LINK_RE)) {
      const href = m[1];
      if (SCHEME.test(href) || href.startsWith("#") || href.startsWith("/")) continue;
      const path = posix.normalize(href.replace(/^\.\//, "").split(/[?#]/)[0]);
      if (path && !exists(path)) problems.push({ line: i + 1, message: `the link ${href} points at a file that does not exist` });
    }
  });
  // headings: one `#`, first, no skipped level
  let prev = 0;
  let h1s = 0;
  lines.forEach((line, i) => {
    const h = /^(#{1,6}) +(.*?)\s*#*\s*$/.exec(line);
    if (!h) return;
    const level = h[1].length;
    const n = i + 1;
    if (!h[2].trim()) problems.push({ line: n, message: "an empty heading" });
    if (level === 1) {
      h1s++;
      if (h1s > 1) problems.push({ line: n, message: "a second `#` title (one per page)" });
    }
    if (prev === 0 && level !== 1) problems.push({ line: n, message: "the first heading must be the `#` title" });
    if (prev && level > prev + 1) problems.push({ line: n, message: `the heading level jumps from ${prev} to ${level}` });
    prev = level;
  });
  if (h1s === 0) problems.push({ line: 1, message: "there is no `#` title" });
  // an opening paragraph: some text between the title and the first `##` that is not just an image or a quote
  const first = lines.findIndex((l) => /^#\s/.test(l));
  if (first >= 0) {
    const end = lines.findIndex((l, i) => i > first && /^##\s/.test(l));
    const block = asMarkdown.slice(first + 1, end < 0 ? undefined : end).join("\n").split(/\n\s*\n/);
    const hasText = block.some((b) => b.trim() && !b.trim().startsWith(">") && b.replace(IMG_RE, "").trim() !== "");
    if (!hasText) problems.push({ line: first + 1, message: "the title is not followed by an opening paragraph" });
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** CHANGELOG.md: only the raw-HTML rule (it is shown as text under each release). */
export function changelogProblems(text) {
  return htmlProblems(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = process.argv.slice(2).length ? process.argv.slice(2) : ["README.md", "CHANGELOG.md"];
  const exists = (p) => existsSync(join(root, p));
  let bad = 0;
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    const problems = /changelog/i.test(f) ? changelogProblems(text) : readmeProblems(text, exists);
    for (const p of problems) {
      console.error(`::error file=${f},line=${p.line}::${f}:${p.line}: ${p.message}`);
      bad++;
    }
  }
  if (bad) {
    console.error(`${bad} problem(s): the README and CHANGELOG must be website-ready (see scripts/check-readme.mjs).`);
    process.exit(1);
  }
  console.log(`Website-ready: ${files.join(", ")}.`);
}
