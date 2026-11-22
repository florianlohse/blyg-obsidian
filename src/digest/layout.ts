// What the digest page says about itself, as data: the honest line for what is not on the front page, the flat "Other posts" list, the preview of a post, and the
// plain-words note on how posts are grouped. Pure. The note repeats the rules of cluster.ts and daily.ts; tests/digest/layout.test.ts pins the numbers it names.
import type { ReadingPost } from "../studio/reading";
import { MIN_SHARED_TERMS } from "./cluster";
import type { Cluster } from "./cluster";
import { FRONT_PAGE_MAX } from "./daily";
import { ownWords } from "./quotes";

export const PREVIEW_MAX = 220;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export interface RestSummary {
  /** The line under the front page, or "" when nothing is left over. */
  line: string;
  /** Every post of the groups beyond the front page, one after the other. */
  posts: ReadingPost[];
}

/** The groups beyond the front page, told as they are: posts that stand alone, and smaller groups when there are any. */
export function summarizeRest(rest: readonly Cluster[]): RestSummary {
  const posts = rest.flatMap((c) => c.posts);
  if (posts.length === 0) return { line: "", posts: [] };
  const singles = rest.filter((c) => c.posts.length === 1).length;
  const groups = rest.length - singles;
  const parts = [`${plural(singles, "single post", "single posts")}, not grouped`];
  if (groups > 0) parts.push(`${plural(groups, "smaller group", "smaller groups")} (${plural(posts.length - singles, "post", "posts")}) not on the front page`);
  return { line: singles === 0 ? parts.slice(1).join("") : parts.join("; "), posts };
}

/** The first lines of a post's own words (what it quotes is left out), cut at a word. "" when it has no words. */
export function previewOf(post: ReadingPost, max = PREVIEW_MAX): string {
  const t = ownWords(post).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = Array.from(t).slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** How posts are grouped, in plain words. Claims only what cluster.ts and daily.ts do. */
export const GROUPING_NOTE: readonly string[] = [
  "Only today's posts from your saved reader list are used. Your own posts and withdrawn posts are left out.",
  "Posts are put in one group when one replies to another, or when they quote the same item.",
  `A post that is still alone is added to the post it resembles most when their wording is very alike (at least ${MIN_SHARED_TERMS} shared words, compared on this device); otherwise it stays alone.`,
  `Bigger groups come first. The front page shows the first ${FRONT_PAGE_MAX} groups; the rest are in "Other posts".`,
];
