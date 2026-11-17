// S15, the reader's feed: what a card shows, how the list is ordered and filtered, and whether a post's web page may be shown inside Obsidian.
// Pure functions (no DOM, no network), so they are unit-tested; everything here reads text and returns text.
import { plainText } from "./defang";
import { isUnread, type ReadingPost } from "../studio/reading";

export interface Card {
  /** The words a thread quotes (from its quote blocks), or null. */
  quote: string | null;
  /** The author's own words. */
  words: string;
  /** How many images the post carries (none are loaded in the list). */
  images: number;
}

const QUOTE = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;

export function cardOf(post: Pick<ReadingPost, "contentHtml">, max = 320): Card {
  const html = post.contentHtml;
  const quotes = [...html.matchAll(QUOTE)].map((m) => plainText(m[1] ?? "")).filter((t) => t !== "");
  const own = plainText(html.replace(QUOTE, " "));
  const cut = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
  return { quote: quotes.length ? cut(quotes.join(" … "), 160) : null, words: cut(own, max), images: (html.match(/<img\b/gi) ?? []).length };
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** The date a post is sorted by: the author's own date when known, else when this Studio first saw it. */
export const dateOf = (p: Pick<ReadingPost, "created" | "observedAt">): string => p.created ?? p.observedAt;

/** How long a post takes to read, in whole minutes (at least one): its words at an ordinary reading speed. A thread counts its quotes too. */
const WORDS_PER_MINUTE = 230;
const minutesCache = new WeakMap<object, { html: string; minutes: number }>();
export function readingMinutes(post: Pick<ReadingPost, "contentHtml">): number {
  const kept = minutesCache.get(post);
  if (kept && kept.html === post.contentHtml) return kept.minutes;
  const words = plainText(post.contentHtml).split(/\s+/).filter((w) => w !== "").length;
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  minutesCache.set(post, { html: post.contentHtml, minutes });
  return minutes;
}
export const readingTimeLabel = (post: Pick<ReadingPost, "contentHtml">): string => `${readingMinutes(post)} min read`;

export type FeedSort = "newest" | "oldest" | "shortest" | "longest";
/** Which posts by length: short (under 2 minutes), medium (2 to 5), long (over 5). */
export type FeedLength = "any" | "short" | "medium" | "long";
export const LENGTH_LABELS: Record<FeedLength, string> = { any: "Any length", short: "Under 2 min", medium: "2 to 5 min", long: "Over 5 min" };
export const SORT_LABELS: Record<FeedSort, string> = { newest: "Newest first", oldest: "Oldest first", shortest: "Shortest read first", longest: "Longest read first" };
export interface FeedFilter {
  sort: FeedSort;
  /** A subscription id, or null for all blygs. */
  source: string | null;
  unreadOnly: boolean;
  length: FeedLength;
}
export const DEFAULT_FILTER: FeedFilter = { sort: "newest", source: null, unreadOnly: false, length: "any" };

/** The feed's choices as kept in the settings: anything that is not one of the known values is the start value (an old or hand-edited file never breaks the feed). */
export function readFilter(raw: unknown): FeedFilter {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const sorts = Object.keys(SORT_LABELS) as FeedSort[];
  const lengths = Object.keys(LENGTH_LABELS) as FeedLength[];
  return {
    sort: sorts.find((x) => x === o.sort) ?? DEFAULT_FILTER.sort,
    source: typeof o.source === "string" && o.source !== "" ? o.source : null,
    unreadOnly: o.unreadOnly === true,
    length: lengths.find((x) => x === o.length) ?? DEFAULT_FILTER.length,
  };
}

/** How many of the feed's choices differ from the start (shown on the button that opens them). */
export const activeFilters = (f: FeedFilter): number => (f.sort !== "newest" ? 1 : 0) + (f.source !== null ? 1 : 0) + (f.unreadOnly ? 1 : 0) + (f.length !== "any" ? 1 : 0);

const inLength = (minutes: number, length: FeedLength): boolean => length === "any" || (length === "short" ? minutes < 2 : length === "medium" ? minutes >= 2 && minutes <= 5 : minutes > 5);

/** The key a post is known by in sets of posts (a hopper's members): the blyg's subscription and the item's id. */
export const postKey = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;

/** `only`: when given, just the posts whose key is in it (the posts of one hopper, increment 8); null/undefined: no such limit. */
export function arrange(posts: ReadingPost[], f: FeedFilter, only: ReadonlySet<string> | null = null): ReadingPost[] {
  const kept = posts.filter((p) => (only === null || only.has(postKey(p))) && (f.source === null || p.subscriptionId === f.source) && (!f.unreadOnly || isUnread(p)) && inLength(readingMinutes(p), f.length));
  const byTime = f.sort === "newest" ? -1 : 1;
  return kept
    .map((p, i) => ({ p, i, t: Date.parse(dateOf(p)), m: readingMinutes(p) }))
    .sort((a, b) => {
      if (f.sort === "shortest" || f.sort === "longest") {
        const lengthSign = f.sort === "shortest" ? 1 : -1;
        if (a.m !== b.m) return lengthSign * (a.m - b.m);
        return Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? b.t - a.t : a.i - b.i; // equal length: the newer first
      }
      return Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? byTime * (a.t - b.t) : a.i - b.i;
    })
    .map((x) => x.p);
}

/**
 * The post to open after `current`: the next unread one in the order the feed shows now (its sort, blyg and length choices; "unread only" does not
 * matter, because the post just read is no longer unread). Not wrapping round: at the end there is none, and the reader goes back to the feed.
 */
export function nextAfter(posts: ReadingPost[], f: FeedFilter, current: ReadingPost, only: ReadonlySet<string> | null = null): ReadingPost | null {
  return nextInOrder(arrange(posts, { ...f, unreadOnly: false }, only), current);
}

/** The same, from an order already worked out (the reader keeps it while the list and the order choices stay as they are). */
export function nextInOrder(order: ReadingPost[], current: ReadingPost): ReadingPost | null {
  const same = (q: ReadingPost): boolean => q.subscriptionId === current.subscriptionId && q.remoteId === current.remoteId;
  const at = order.findIndex(same);
  return order.slice(at + 1).find((q) => isUnread(q) && !same(q)) ?? null;
}

/** The post a quote (`blockquote.blyg-transclusion`, `data-blyg-id`) was taken from, when the Studio reads that blyg and holds it. Null otherwise. */
export function postOfQuote(posts: ReadingPost[], itemId: string): ReadingPost | null {
  return itemId === "" ? null : (posts.find((q) => q.remoteId === itemId && !q.withdrawn) ?? posts.find((q) => q.remoteId === itemId) ?? null);
}

/** How far a finger has to pull up past the end of a post (CSS pixels) before letting go counts. */
export const PULL_THRESHOLD = 90;
/** How far into the pull it is: 0 (not pulling) to 1 (let go now). */
export const pullProgress = (dy: number): number => (dy <= 0 ? 0 : Math.min(1, dy / PULL_THRESHOLD));

/** The blygs in the list, for the source picker: id, title and how many posts, by title. */
export function sourcesOf(posts: ReadingPost[]): Array<{ id: string; title: string; count: number }> {
  const by = new Map<string, { id: string; title: string; count: number }>();
  for (const p of posts) {
    const s = by.get(p.subscriptionId) ?? { id: p.subscriptionId, title: p.subscriptionTitle || p.origin || p.subscriptionId, count: 0 };
    s.count++;
    by.set(p.subscriptionId, s);
  }
  return [...by.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** An address a frame may load: absolute http(s) only. */
export function frameable(url: string | null): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
