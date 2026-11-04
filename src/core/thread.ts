import { maskCode } from "./links";

// The thread grammar (spec §10.1; docs/CONTRACT.md §3.3, §3.4): which lines of a note are transclusion directives, which
// attached blockquote makes one partial, and which `[[id]]` are plain item links.
//
// The site decides what is "code" with a real Markdown parser (remark). The plugin has none, and Florian decided on
// 2026-10-07 (option a′; docs/plans/R3-threads.md "Site-side interface" §2) that it should not try to be one: where a
// directive or an id link COULD be inside code, `scanThread` refuses instead of guessing. The plugin may be stricter than
// the site, never different: for every case in tests/fixtures/site/threads/directives.json it gives the site's answer or
// refuses. The refusals only apply to a body that mentions an item id at all; a note with no `[[id]]` has nothing to
// misclassify.

/** The id alphabet (Crockford base32 minus i, l, o, u) as a regex fragment: exactly what `mintBlygId` produces. */
const ID = "[0-9a-hjkmnp-tv-z]{26}";

const CANDIDATE = new RegExp(`\\[\\[${ID}(?:@v\\d+)?\\]\\]`);
const DIRECTIVE_LINE = new RegExp(`^\\s*!\\[\\[(${ID})\\]\\]\\s*$`);
const RESERVED_LINE = new RegExp(`^\\s*!\\[\\[(${ID})@v\\d+\\]\\]\\s*$`);
const LINK = new RegExp(`\\[\\[(${ID})\\]\\]`, "g");
const QUOTE_LINE = /^\s*>/;
/** Four spaces or a tab of indentation, after any blockquote markers: may be an indented code block. */
const INDENTED = /^[\s>]*(?:\t| {4})/;

export interface Directive {
  id: string;
  /** The attached blockquote's Markdown (markers stripped), or null for a whole quotation. */
  quoteMd: string | null;
  /** 1-based line of the directive. */
  line: number;
}

export type ThreadScan =
  | {
      ok: true;
      /** One per directive, in order (a directive repeated twice is two). */
      directives: Directive[];
      /** Distinct plain item links `[[id]]` outside directives, in order of first appearance. */
      links: string[];
    }
  | { ok: false; problems: string[] };

function lineOffsets(lines: string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const line of lines) {
    out.push(at);
    at += line.length + 1;
  }
  return out;
}

/** Does the text hold a plain item link `[[id]]` (not the inline `![[id]]` form) or is it a whole directive line? */
function mentionsLinkOrDirective(text: string): boolean {
  if (text.split("\n").some((line) => DIRECTIVE_LINE.test(line) || RESERVED_LINE.test(line))) return true;
  for (const m of text.matchAll(LINK)) if (text[(m.index ?? 0) - 1] !== "!") return true;
  return false;
}

/** A backtick that is not escaped by an odd number of backslashes: it can open or close a code span. */
function hasCodeBacktick(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "`") continue;
    let slashes = 0;
    while (i - 1 - slashes >= 0 && text[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

/** The run of `>` lines attached to the directive at line `i` (no blank line between), and where scanning resumes. */
function attachedQuote(lines: string[], i: number): { quoteMd: string | null; next: number } {
  let j = i + 1;
  const run: string[] = [];
  while (j < lines.length && QUOTE_LINE.test(lines[j] ?? "")) {
    run.push((lines[j] ?? "").replace(/^\s*>\s?/, ""));
    j++;
  }
  return { quoteMd: run.length ? run.join("\n") : null, next: j };
}

/**
 * The shapes where the plugin cannot be sure what the site's parser calls code, so it refuses (and says what to change).
 * Only called for a body that mentions an item id.
 */
function codeDoubts(lines: string[]): string[] {
  const problems: string[] = [];
  const fence = lines.findIndex((line) => /```|~~~/.test(line));
  if (fence >= 0) {
    problems.push(`line ${fence + 1}: a code block (\`\`\` or ~~~). A directive or item link next to code might be taken for code, so this plugin does not publish such a note yet. Take the code out, or write it without a fence`);
  }
  lines.forEach((line, i) => {
    if (INDENTED.test(line) && mentionsLinkOrDirective(line)) {
      problems.push(`line ${i + 1}: indented by 4 or more spaces (or a tab), which can make it a code block. Indent it less`);
    }
  });
  // A paragraph is a run of non-blank lines. A backtick in it may turn a neighbouring directive or link into code.
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && (lines[i] ?? "").trim() !== "") continue;
    const paragraph = lines.slice(start, i).join("\n");
    if (paragraph !== "" && hasCodeBacktick(paragraph) && mentionsLinkOrDirective(paragraph)) {
      problems.push(`line ${start + 1}: a backtick (\`) in the same paragraph as an item link or directive, which may turn it into code. Move one of them to another paragraph`);
    }
    start = i + 1;
  }
  return problems;
}

/**
 * The directives and plain item links of a thread body (`content_md`: frontmatter stripped, CRLF normalised, trimmed).
 * Refuses (`ok: false`) a body with an explicit version (`![[id@v2]]`, spec §10.1) or one where the plugin cannot tell
 * whether an id is inside code.
 */
export function scanThread(contentMd: string): ThreadScan {
  const lines = contentMd.split("\n");
  if (!CANDIDATE.test(contentMd)) return { ok: true, directives: [], links: [] };

  const problems = codeDoubts(lines);
  const starts = lineOffsets(lines);
  const directives: Directive[] = [];
  const consumed: Array<[number, number]> = []; // directive lines + their attached quotes: not prose

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (RESERVED_LINE.test(line)) {
      problems.push(`line ${i + 1}: ${line.trim()} — explicit versions (@vN) are not allowed; a quote always takes the source's current version`);
      continue;
    }
    const m = DIRECTIVE_LINE.exec(line);
    if (!m) continue;
    const { quoteMd, next } = attachedQuote(lines, i);
    directives.push({ id: m[1] ?? "", quoteMd, line: i + 1 });
    consumed.push([starts[i] ?? 0, next < lines.length ? (starts[next] ?? contentMd.length) : contentMd.length]);
    i = next - 1;
  }

  const links: string[] = [];
  for (const match of contentMd.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (contentMd[at - 1] === "!") continue; // `![[id]]` inline: plain text, not a link (the directive form is one line)
    if (consumed.some(([s, e]) => at >= s && at < e)) continue;
    const id = match[1] ?? "";
    if (!links.includes(id)) links.push(id);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, directives, links };
}

/**
 * Every `![[` left in the text after the quotes are accounted for, outside code: the site shows notes as plain text, so such an embed
 * (an image, a note, a broken `![[![[id]]` made by autocomplete) would come out as literal brackets, and its build check refuses to deploy a
 * page with literal `[[…]]` in it (found 2026-10-15 on the device and confirmed against the site's own check). Directive lines and the quote
 * lines attached to them are not "left over". Each problem names its line.
 */
export function leftoverEmbeds(contentMd: string, directives: Directive[]): string[] {
  const lines = contentMd.split("\n");
  const masked = maskCode(contentMd).split("\n");
  const taken = new Set<number>();
  for (const d of directives) {
    const quoteLines = d.quoteMd === null ? 0 : d.quoteMd.split("\n").length;
    for (let i = 0; i <= quoteLines; i++) taken.add(d.line + i);
  }
  const problems: string[] = [];
  masked.forEach((line, i) => {
    const at = line.indexOf("![[");
    if (at < 0 || taken.has(i + 1)) return;
    problems.push(`line ${i + 1}: ${(lines[i] ?? "").slice(at, at + 40).trimEnd()}`);
  });
  return problems;
}
