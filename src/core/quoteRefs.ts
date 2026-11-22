// The quote directives of a post (pure): which items a post quotes, and which passage of each. Reads ANY post's Markdown, so it
// never refuses: `scanThread` (thread.ts) judges the reader's own drafts strictly; this module only reports what is there.
//
// A directive is a line holding only `![[id]]`, optionally `![[id@vN]]` (the version the quote cites). The `>` lines right after
// it (no blank line between) are the quoted passage; none means the whole post is quoted. Directive lines inside fenced code or
// indented by 4+ spaces are code, not directives. The passage is returned as its lines with the `>` markers stripped, and as
// text with the Markdown escapes resolved by `renderQuoteSelection` (so a backslash before punctuation, and the pitfall that a
// bare web address swallows backslashes, are handled in quote.ts, once).
import { maskCode } from "./links";
import { renderQuoteSelection } from "./quote";

const ID = "[0-9a-hjkmnp-tv-z]{26}";
const DIRECTIVE = new RegExp(`^\\s*!\\[\\[(${ID})(?:@v(\\d+))?\\]\\]\\s*$`);
const QUOTE_LINE = /^\s*>/;
const INDENTED = /^(?:\t| {4})/;

export interface QuoteRef {
  itemId: string;
  /** The version the directive cites (`![[id@v2]]`), or null when it names none. */
  citedVersion: number | null;
  /** The attached quote's lines, `>` markers stripped (blank lines kept), or null for a whole-post quote. */
  passageLines: string[] | null;
  /** The quote as plain text: escapes resolved, blocks separated by a line break. Null for a whole-post quote. */
  passageText: string | null;
  /** True when `passageText` is exactly what the site's renderer gives; false when the quote uses Markdown this plugin does not render (the text is then the lines as written). */
  passageExact: boolean;
  /** 1-based line of the directive in the Markdown given (frontmatter included when given). */
  line: number;
}

/** Drop a leading YAML frontmatter block, keeping line numbers by blanking it. */
function blankFrontmatter(lines: string[]): string[] {
  if ((lines[0] ?? "").trim() !== "---") return lines;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return lines;
  return lines.map((l, i) => (i <= close ? "" : l));
}

/** The quote directives of a post's Markdown, in order (a directive repeated is repeated). */
export function parseQuoteRefs(markdown: string): QuoteRef[] {
  const text = markdown.replace(/\r\n?/g, "\n");
  const lines = blankFrontmatter(text.split("\n"));
  const masked = maskCode(lines.join("\n")).split("\n");
  const refs: QuoteRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(masked[i] ?? "");
    if (!m || INDENTED.test(lines[i] ?? "")) continue;
    let j = i + 1;
    const quote: string[] = [];
    while (j < lines.length && QUOTE_LINE.test(lines[j] ?? "")) {
      quote.push((lines[j] ?? "").replace(/^\s*>\s?/, ""));
      j++;
    }
    let passageText: string | null = null;
    let passageExact = false;
    if (quote.length > 0) {
      const rendered = renderQuoteSelection(quote.join("\n"));
      passageExact = rendered.ok;
      passageText = rendered.ok ? rendered.selection : quote.filter((l) => l.trim() !== "").join("\n");
    }
    refs.push({
      itemId: m[1] ?? "",
      citedVersion: m[2] === undefined ? null : Number(m[2]),
      passageLines: quote.length > 0 ? quote : null,
      passageText,
      passageExact,
      line: i + 1,
    });
    i = j - 1;
  }
  return refs;
}

/** The distinct item ids a post quotes, in order of first appearance. */
export function quotedItemIds(markdown: string): string[] {
  return [...new Set(parseQuoteRefs(markdown).map((r) => r.itemId))];
}
