// HK3 Marginalia: the words a reply or quoting post says ITSELF, for the Reception list's preview. A reply note starts with the directive that quotes the item it answers (and,
// for a passage, the blockquote under it); that leading quoted block is the ORIGINAL's text, not the reply's, so it is cut off and what follows is shown. Pure string reading; the
// result is a stranger's text that is only ever shown as text and never stored.
import { plainTextFromHtml } from "../core/textContent";

export const OWN_TEXT_MAX = 160;

const cut = (s: string): string => (s.length > OWN_TEXT_MAX ? `${s.slice(0, OWN_TEXT_MAX - 1)}…` : s);

/** The post's own words in its Markdown: the leading run of quote directives, blockquote lines and blank lines is skipped, the rest is reduced to plain words. "" when nothing is left. */
export function ownTextFromMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (close > 0) i = close + 1;
  }
  while (i < lines.length && /^\s*(?:$|>.*|!\[\[[^\]]*\]\]\s*)$/.test(lines[i] ?? "")) i++;
  const rest = lines.slice(i).join("\n");
  return cut(
    rest
      .replace(/!\[\[[^\]]*\]\]/g, " ")
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/[*_~=`]+/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** The same from a post's rendered HTML: the quote blocks the Studio bakes (`blockquote.blyg-transclusion`) are removed, the rest is its text. */
export function ownTextFromHtml(html: string): string {
  const without = html.replace(/<blockquote\b[^>]*\bblyg-transclusion\b[^>]*>[\s\S]*?<\/blockquote>/gi, " ");
  return cut(plainTextFromHtml(without).replace(/\s+/g, " ").trim());
}
