// What the digest page says about itself, as data: the honest line for what is not on the front page, the flat "Other posts" list, the Mixed bag, the preview of a post, and the
// plain-words note on how posts become stories. Pure. The note repeats the rules of cluster.ts and daily.ts; tests/digest/layout.test.ts pins the numbers it names.
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
  /** Every post of the stories beyond the front page, one after the other. */
  posts: ReadingPost[];
}

/** The stories beyond the front page, told as they are. */
export function summarizeRest(rest: readonly Cluster[]): RestSummary {
  const posts = rest.flatMap((c) => c.posts);
  if (posts.length === 0) return { line: "", posts: [] };
  return { line: `${plural(rest.length, "more story", "more stories")} (${plural(posts.length, "post", "posts")}) not on the front page`, posts };
}

/** The first lines of a post's own words (what it quotes is left out), cut at a word. "" when it has no words. */
export function previewOf(post: ReadingPost, max = PREVIEW_MAX): string {
  const t = ownWords(post).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = Array.from(t).slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** How posts become stories, in plain words. Claims only what cluster.ts and daily.ts do. */
export const GROUPING_NOTE: readonly string[] = [
  "Only today's posts from your saved reader list are used. Your own posts and withdrawn posts are left out.",
  "Posts are put in one story when one replies to another, or when they quote the same item.",
  `A post that is still alone is added to the post it resembles most when their wording is very alike (at least ${MIN_SHARED_TERMS} shared words, compared on this device); otherwise it stays alone.`,
  `A story has at least two posts. Bigger stories come first. The front page shows the first ${FRONT_PAGE_MAX} stories; the rest are in "Other posts". Posts that fit no story are in the Mixed bag at the bottom, and the AI is not asked about them.`,
  "Sections are written by the AI from the story headlines: it is sent only the headlines and summaries, not the posts, and each story is in one section.",
];
