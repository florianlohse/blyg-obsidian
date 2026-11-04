// The text-content rule of spec §10.2 ("the target snapshot's `content_html` with tags stripped, whitespace collapsed
// within a block, block boundaries kept as line breaks") and the helpers built on it (docs/CONTRACT.md §3.3).
//
// PORTED, not reinvented: these functions are the reference studio's (blygger/blygger-studio, src/markdown.ts and
// src/text.ts, MIT licence, © 2026 Venkatesh Rao) as the site repo ports them (src/lib/text-content.js), kept behaviourally
// identical on purpose: a partial quotation is only trustworthy if the publisher's check and any reader's re-check agree to
// the character. Change it only if the reference and the site do. Shared cases: tests/fixtures/site/threads/selection.json.
//
// Pure functions of strings: no DOM, no dependencies, so the same code runs in Node tests and on a phone.

const BLOCK_BOUNDARY = /<\/(?:p|h[1-6]|li|blockquote|pre|div|tr|section|article)>|<br\s*\/?>/gi;
const BLOCK_SEP = "\u0000";

/** Decode the entities a Markdown renderer and a feed pipeline actually emit. `&amp;` last, so "&amp;lt;" stays "&lt;". */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Whitespace within a block collapses to single spaces; empty blocks are dropped; blocks join with a line break. */
function normalizeBlocks(segments: string[]): string {
  return segments
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter((seg) => seg !== "")
    .join("\n");
}

/**
 * The selection normaliser (§10.2). Block boundaries become line breaks BEFORE any whitespace collapsing, so only real
 * boundaries survive as breaks (not wherever the author pressed return inside a paragraph).
 */
export function selectionText(html: string): string {
  return normalizeBlocks(
    decodeEntities(
      html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(BLOCK_BOUNDARY, BLOCK_SEP)
        .replace(/<[^>]+>/g, ""),
    ).split(BLOCK_SEP),
  );
}

/**
 * The same rule for text that is already text, such as a browser selection, where `Selection.toString()` has put a newline
 * at each block boundary. This is how a quote picker turns what the author highlighted into the string `selectionText`
 * will later have to match.
 */
export function normalizeSelection(text: string): string {
  return normalizeBlocks(String(text).split("\n"));
}

/** A normalised selection as an attached Markdown blockquote: `>` on every line, a bare `>` between blocks. */
export function quoteLines(selection: string): string {
  return selection
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n>\n");
}

/** Plain text of already-rendered HTML on one line (block ends become spaces so "evil.</p><p>Next" does not weld). */
export function plainTextFromHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(BLOCK_BOUNDARY, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** The longest prefix of `s` of at most `n` UTF-16 units that ends on a grapheme boundary (never splits an emoji). */
export function graphemePrefix(s: string, n: number): string {
  if (s.length <= n) return s;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let end = 0;
  for (const { index, segment } of segmenter.segment(s)) {
    if (index + segment.length > n) break;
    end = index + segment.length;
  }
  return s.slice(0, end);
}

/** First ~n characters of the plain text of already-rendered HTML, ellipsised. */
export function excerptFromHtml(html: string, n = 60): string {
  const text = plainTextFromHtml(html);
  return text.length <= n ? text : graphemePrefix(text, n).trimEnd() + "…";
}

/** First ~n characters of a plain-text string, ellipsised (the same cut as `excerptFromHtml`). */
export function excerptFromText(text: string, n = 60): string {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : graphemePrefix(flat, n).trimEnd() + "…";
}

/** The escape the baked partial-quote paragraphs use (§10.2: "the selection's plain text, one `<p>` per line, escaped"). */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** How much context either side of a match a selector records (spec §10.3: "short"). */
const SELECTOR_CONTEXT = 32;

export interface Selector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Locate a selection in a target's text. `null` when it is not there, which is a publish error exactly as an unresolvable
 * directive is. Context comes from the FIRST match (arbitrary but deterministic; `prefix`/`suffix` are a relocation hint
 * for readers, never part of the check). Same as the site's `locateSelection`.
 */
export function locateSelection(targetHtml: string, selection: string): Selector | null {
  const hay = selectionText(targetHtml);
  const at = hay.indexOf(selection);
  if (at < 0) return null;
  const prefix = hay.slice(Math.max(0, at - SELECTOR_CONTEXT), at);
  const suffix = hay.slice(at + selection.length, at + selection.length + SELECTOR_CONTEXT);
  return { exact: selection, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
}
