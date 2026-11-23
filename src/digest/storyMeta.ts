// The small lines under a story: who wrote it and, for a story without an AI summary, a few keywords. Pure.
import type { ReadingPost } from "../studio/reading";

export const KEYWORDS_MAX = 3;
export const AUTHORS_SHOWN = 3;

/** The name the reader shows for a post: its author, else the blyg's title. */
export const authorOf = (p: ReadingPost): string => (p.authorName ?? "").trim() || p.subscriptionTitle;

/** A term worth showing: not a number, not an address, not a lone character. */
const isKeyword = (t: string): boolean => t.length >= 3 && !/\d/.test(t) && !/^(https?|www)\b|[./:@]/i.test(t);

/** At most KEYWORDS_MAX terms, without numbers, address-like tokens, or words that are part of an author's name. */
export function keywordsOf(terms: readonly string[], authors: readonly string[]): string[] {
  const nameWords = new Set(authors.flatMap((a) => a.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
  return terms.filter((t) => isKeyword(t) && !nameWords.has(t.toLowerCase())).slice(0, KEYWORDS_MAX);
}

/** "by Ann, Bo" — each name once, in order; more than AUTHORS_SHOWN end in "and N more". "" when nobody is named. */
export function authorsLine(posts: readonly ReadingPost[]): string {
  const names = [...new Set(posts.map(authorOf).filter(Boolean))];
  if (names.length === 0) return "";
  const shown = names.slice(0, AUTHORS_SHOWN).join(", ");
  return `by ${shown}${names.length > AUTHORS_SHOWN ? ` and ${names.length - AUTHORS_SHOWN} more` : ""}`;
}
