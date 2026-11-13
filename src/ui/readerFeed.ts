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

export type FeedSort = "newest" | "oldest";
export interface FeedFilter {
  sort: FeedSort;
  /** A subscription id, or null for all blygs. */
  source: string | null;
  unreadOnly: boolean;
}
export const DEFAULT_FILTER: FeedFilter = { sort: "newest", source: null, unreadOnly: false };

export function arrange(posts: ReadingPost[], f: FeedFilter): ReadingPost[] {
  const kept = posts.filter((p) => (f.source === null || p.subscriptionId === f.source) && (!f.unreadOnly || isUnread(p)));
  const sign = f.sort === "newest" ? -1 : 1;
  return kept
    .map((p, i) => ({ p, i, t: Date.parse(dateOf(p)) }))
    .sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? sign * (a.t - b.t) : a.i - b.i))
    .map((x) => x.p);
}

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

/**
 * May this page be shown inside Obsidian? Read from its response headers: `X-Frame-Options` of any value, or a CSP `frame-ancestors` that does not allow
 * every origin, says no (Obsidian's own origin is never one a site lists). No such header: yes.
 */
export function framePolicy(headers: Record<string, string>): "allowed" | "forbidden" {
  const get = (name: string): string | undefined => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  if ((get("x-frame-options") ?? "").trim() !== "") return "forbidden";
  for (const directive of (get("content-security-policy") ?? "").split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name?.toLowerCase() === "frame-ancestors" && !sources.includes("*")) return "forbidden";
  }
  return "allowed";
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
