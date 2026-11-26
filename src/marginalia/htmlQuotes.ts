// HK3 Marginalia: the quotes of an item in a post's RENDERED HTML. A peek (`GET /api/peek`) serves a post's HTML for any blyg, followed or not, while its Markdown
// is only held for posts the Studio imported. The Studio bakes a quote as `<blockquote class="blyg-transclusion" data-blyg-id data-blyg-version>`, with the extra class
// `blyg-partial` when it is a passage (the selection's plain text in `<p>`s) and without it when the whole item is quoted (docs/vendor/blygger-spec/css-contract.md).
// Pure string reading, no DOM (as src/digest/quotes.ts): the stranger's words come out as plain text and are only ever shown as text.
import { plainTextFromHtml } from "../core/textContent";
import type { FoundQuote } from "./lookup";

const BLOCKQUOTE = /<blockquote\b([^>]*)>([\s\S]*?)<\/blockquote>/gi;
const classOf = (attrs: string): string => /\bclass\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
const attr = (attrs: string, name: string): string | null => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1] ?? null;

/** The quotes of `itemId` in the HTML of a post, in the order they stand. Empty when the post does not quote it. */
export function parseQuotesFromHtml(html: string, itemId: string): FoundQuote[] {
  const out: FoundQuote[] = [];
  for (const m of html.matchAll(BLOCKQUOTE)) {
    const attrs = m[1] ?? "";
    const classes = classOf(attrs).split(/\s+/);
    if (!classes.includes("blyg-transclusion") || attr(attrs, "data-blyg-id") !== itemId) continue;
    const text = classes.includes("blyg-partial") ? plainTextFromHtml(m[2] ?? "") : "";
    out.push(text !== "" ? { kind: "passage", text } : { kind: "whole" });
  }
  return out;
}
