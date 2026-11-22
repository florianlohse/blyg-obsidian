// Which items a post quotes. The reader's saved list keeps the post's rendered HTML but not its Markdown, so the quotes are read from the
// rendered form the Studio gives (`<blockquote class="blyg-transclusion" data-blyg-id="…">`), with the Markdown directives (core/quoteRefs) as a
// second source when a post still has its Markdown. Pure.
import { quotedItemIds } from "../core/quoteRefs";
import { plainTextFromHtml } from "../core/textContent";
import type { ReadingPost } from "../studio/reading";

const BLOCKQUOTE_OPEN = /<blockquote\b[^>]*>/gi;
const TRANSCLUSION = /<blockquote\b[^>]*\bclass\s*=\s*"[^"]*\bblyg-transclusion\b[^"]*"[^>]*>[\s\S]*?<\/blockquote>/gi;

/** The distinct item ids a post quotes, in order of appearance (never the post's own id). */
export function quotedIdsOf(post: ReadingPost): string[] {
  const ids: string[] = [];
  for (const m of post.contentHtml.matchAll(BLOCKQUOTE_OPEN)) {
    const tag = m[0];
    if (!/\bclass\s*=\s*"[^"]*\bblyg-transclusion\b/i.test(tag)) continue;
    const id = /\bdata-blyg-id\s*=\s*"([^"]+)"/i.exec(tag)?.[1];
    if (id) ids.push(id);
  }
  if (post.contentMd) ids.push(...quotedItemIds(post.contentMd));
  return [...new Set(ids)].filter((id) => id !== post.remoteId);
}

/** The post's own words as plain text: what it quotes is left out (those are someone else's words), unless that leaves nothing. */
export function ownWords(post: ReadingPost): string {
  const without = plainTextFromHtml(post.contentHtml.replace(TRANSCLUSION, " "));
  return without !== "" ? without : plainTextFromHtml(post.contentHtml);
}
