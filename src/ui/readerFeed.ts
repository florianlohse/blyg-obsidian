// S15, the reader's feed: what a card shows, how the list is ordered and filtered, and whether a post's web page may be shown inside Obsidian.
// Pure functions (no DOM, no network), so they are unit-tested; everything here reads text and returns text.
import { decode, plainText } from "./defang";
import { isUnread, type ReadingPost } from "../studio/reading";

export interface Card {
  /** The words a thread quotes (from its quote blocks), or null. */
  quote: string | null;
  /** Where the quote comes from, when the post says so with a line that is only a link (right after the quote, or its last line). Absent when it does not. */
  source?: string;
  /** The author's own words. */
  words: string;
  /** The same words with the three kinds of formatting a card shows (headings and bold in bold, italics in italics); the same length and cut as `words`. */
  runs: Run[];
  /** How many images the post carries (none are loaded in the list). */
  images: number;
}

/** A piece of a card's text: its words and how they look. A heading is bold and ends its line (`breakAfter`). */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  breakAfter?: boolean;
}

const BOLD_TAGS = new Set(["strong", "b", "h1", "h2", "h3", "h4", "h5", "h6"]);
const ITALIC_TAGS = new Set(["em", "i"]);
const HEADING = /^h[1-6]$/;
const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "br", "blockquote", "pre", "tr", "table", "section", "article", "hr"]);

/**
 * The words of a post for a card, with a little formatting (increment 13): headings in bold with a line break after them, bold in bold, italics in italics.
 * Everything else is plain words, as in `plainText`. Nothing is ever inserted as markup: the result is text pieces, drawn as spans. `max` cuts the words
 * (characters, counted as in `words`); a cut ends with an ellipsis.
 */
export function formattedRuns(html: string, max = 320): Run[] {
  const runs: Run[] = [];
  let bold = 0;
  let italic = 0;
  let pendingSpace = false;
  let length = 0;
  const push = (text: string): void => {
    const words = text.replace(/\s+/g, " ");
    if (words.trim() === "" && words === "") return;
    const lead = words.startsWith(" ");
    const body = words.trim();
    if (body === "") {
      pendingSpace = true;
      return;
    }
    const spaced = (pendingSpace || lead) && runs.length > 0 && !runs[runs.length - 1]?.breakAfter ? ` ${body}` : body;
    pendingSpace = words.endsWith(" ");
    const last = runs[runs.length - 1];
    const same = last && !last.breakAfter && (last.bold ?? false) === bold > 0 && (last.italic ?? false) === italic > 0;
    if (same) last.text += spaced;
    else runs.push({ text: spaced, ...(bold > 0 ? { bold: true } : {}), ...(italic > 0 ? { italic: true } : {}) });
    length += spaced.length;
  };
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|([^<]+)|</g;
  for (const m of html.matchAll(tag)) {
    if (length > max + 40) break; // enough to cut from
    if (m[3] !== undefined) {
      push(decode(m[3]));
      continue;
    }
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    if (BOLD_TAGS.has(name)) bold = Math.max(0, bold + (closing ? -1 : 1));
    else if (ITALIC_TAGS.has(name)) italic = Math.max(0, italic + (closing ? -1 : 1));
    if (HEADING.test(name) && closing) {
      const last = runs[runs.length - 1];
      if (last && !last.breakAfter) last.breakAfter = true;
      pendingSpace = false;
    } else if (BLOCK_TAGS.has(name)) pendingSpace = true;
  }
  // Cut to `max` characters: the words are counted as in `plainText` (one space between words).
  let total = 0;
  const out: Run[] = [];
  for (const run of runs) {
    if (total >= max) break;
    const room = max - total;
    if (run.text.length > room) {
      out.push({ ...run, text: `${run.text.slice(0, Math.max(0, room - 1)).trimEnd()}…`, breakAfter: false });
      total = max;
      break;
    }
    out.push({ ...run });
    total += run.text.length;
  }
  const lastOut = out[out.length - 1];
  if (lastOut?.breakAfter) delete lastOut.breakAfter; // no line break at the very end
  return out;
}

// A quote's source line: a block that holds nothing but a link (maybe in italics, maybe with an arrow after it), right after the quote or as its last line.
// It names where the quote comes from; it is not the author's own words, so a card shows it under the quote and keeps it out of the words.
const LINK_TEXT = String.raw`((?:(?!<\/a>|<\/?(?:p|div|footer|blockquote)\b)[\s\S])*)`;
const SOURCE_AFTER = new RegExp(String.raw`^\s*<(p|div|footer)\b[^>]*>\s*(?:<(?:em|i|cite|small|span)\b[^>]*>\s*)*<a\b[^>]*>${LINK_TEXT}<\/a>\s*(?:<\/(?:em|i|cite|small|span)>\s*)*[\s↗⬈➚]*<\/\1>`, "i");
const SOURCE_TAIL_BLOCK = new RegExp(String.raw`<(p|div|footer)\b[^>]*>\s*(?:<(?:em|i|cite|small|span)\b[^>]*>\s*)*<a\b[^>]*>${LINK_TEXT}<\/a>\s*(?:<\/(?:em|i|cite|small|span)>\s*)*[\s↗⬈➚]*<\/\1>\s*$`, "i");
const SOURCE_TAIL_LINE = new RegExp(String.raw`(?:<br\s*\/?>|\n)\s*(?:<(?:em|i|cite|small)\b[^>]*>\s*)+<a\b[^>]*>${LINK_TEXT}<\/a>\s*(?:<\/(?:em|i|cite|small)>\s*)+[\s↗⬈➚]*(?:<\/p>)?\s*$`, "i");
const sourceText = (linkHtml: string): string => plainText(linkHtml).replace(/[\s↗⬈➚]+$/, "").trim();

/** The inner HTML of a quote without a source line at its end, and that line's words (null when there is none, or when the quote is nothing else). */
function peelSource(inner: string): { body: string; source: string | null } {
  const found = SOURCE_TAIL_BLOCK.exec(inner) ?? SOURCE_TAIL_LINE.exec(inner);
  if (!found) return { body: inner, source: null };
  const body = inner.slice(0, found.index);
  const text = sourceText(found[2] ?? found[1] ?? "");
  return plainText(body) === "" || text === "" ? { body: inner, source: null } : { body, source: text };
}

/** Split a post's HTML into its outermost quotes (inner HTML of each top-level blockquote, nested ones included) and what is left outside them. A quote may hold a quote: only the matching close ends it. The words of each quote's source line come apart too. */
function splitQuotes(html: string): { quotes: string[]; rest: string; sources: string[] } {
  const tag = /<(\/?)blockquote\b[^>]*>/gi;
  const quotes: string[] = [];
  const sources: string[] = [];
  let rest = "";
  let depth = 0;
  let from = 0; // start of the text not yet placed
  let innerStart = 0;
  for (const m of html.matchAll(tag)) {
    const closing = m[1] === "/";
    if (!closing) {
      if (depth === 0) {
        rest += `${html.slice(from, m.index)} `;
        innerStart = m.index + m[0].length;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) {
        const peeled = peelSource(html.slice(innerStart, m.index));
        quotes.push(peeled.body);
        if (peeled.source) sources.push(peeled.source);
        from = m.index + m[0].length;
        // A line of nothing but a link right after the quote is its source, not the author's words.
        const after = SOURCE_AFTER.exec(html.slice(from));
        if (after && plainText(peeled.body) !== "") {
          const text = sourceText(after[2] ?? "");
          if (text !== "") sources.push(text);
          from += after[0].length;
        }
      }
    }
  }
  // A quote that is never closed runs to the end of the post (nothing of it is the author's own words).
  if (depth > 0) quotes.push(html.slice(innerStart));
  else rest += html.slice(from);
  return { quotes, rest, sources };
}

export function cardOf(post: Pick<ReadingPost, "contentHtml">, max = 320): Card {
  const html = post.contentHtml;
  const split = splitQuotes(html);
  const quotes = split.quotes.map((q) => plainText(q)).filter((t) => t !== "");
  const own = plainText(split.rest);
  const cut = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
  const source = [...new Set(split.sources)].join(" · ");
  return { quote: quotes.length ? cut(quotes.join(" … "), 160) : null, ...(source !== "" ? { source: cut(source, 120) } : {}), words: cut(own, max), runs: formattedRuns(split.rest, max), images: (html.match(/<img\b/gi) ?? []).length };
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
export const LENGTH_LABELS: Record<FeedLength, string> = { any: "Length", short: "< 2 min", medium: "2–5 min", long: "> 5 min" };
export const SORT_LABELS: Record<FeedSort, string> = { newest: "Newest", oldest: "Oldest", shortest: "Shortest read", longest: "Longest read" };
export interface FeedFilter {
  sort: FeedSort;
  /** A subscription id, or null for all blygs. */
  source: string | null;
  unreadOnly: boolean;
  length: FeedLength;
  /** Only the posts that answer one of the owner's own items ("Replies to my posts only"); off by default. */
  repliesToMe: boolean;
}
/** The value of `source` that stands for the owner's own posts (not a subscription id). */
export const OWN_SOURCE = "~own";
export const DEFAULT_FILTER: FeedFilter = { sort: "newest", source: null, unreadOnly: false, length: "any", repliesToMe: false };

/** Does this post answer one of the owner's own items (`mine`: the ids of those items)? */
export const isReplyToMine = (p: ReadingPost, mine: ReadonlySet<string>): boolean => p.isReply && p.stubTarget != null && mine.has(p.stubTarget.id);

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
    repliesToMe: o.repliesToMe === true,
  };
}

/** How many of the feed's choices differ from the start (shown on the button that opens them). */
export const activeFilters = (f: FeedFilter): number => (f.sort !== "newest" ? 1 : 0) + (f.source !== null ? 1 : 0) + (f.unreadOnly ? 1 : 0) + (f.repliesToMe ? 1 : 0) + (f.length !== "any" ? 1 : 0);

const inLength = (minutes: number, length: FeedLength): boolean => length === "any" || (length === "short" ? minutes < 2 : length === "medium" ? minutes >= 2 && minutes <= 5 : minutes > 5);

/** The key a post is known by in sets of posts (a hopper's members): the blyg's subscription and the item's id. */
export const postKey = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;

export function arrange(posts: ReadingPost[], f: FeedFilter, mine: ReadonlySet<string> = new Set()): ReadingPost[] {
  const kept = posts.filter((p) => (f.source === null || (f.source === OWN_SOURCE ? p.own === true : p.subscriptionId === f.source)) && (!f.repliesToMe || isReplyToMine(p, mine)) && (!f.unreadOnly || isUnread(p)) && inLength(readingMinutes(p), f.length));
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

/** The post a quote (`blockquote.blyg-transclusion`, `data-blyg-id`) was taken from, when the Studio reads that blyg and holds it. Null otherwise. */
export function postOfQuote(posts: ReadingPost[], itemId: string): ReadingPost | null {
  return itemId === "" ? null : (posts.find((q) => q.remoteId === itemId && !q.withdrawn) ?? posts.find((q) => q.remoteId === itemId) ?? null);
}

/** The blygs in the list, for the source picker: id, title and how many posts, by title. */
export function sourcesOf(posts: ReadingPost[]): Array<{ id: string; title: string; count: number }> {
  const by = new Map<string, { id: string; title: string; count: number }>();
  for (const p of posts) {
    if (p.own) continue; // the owner's own posts are not a blyg read
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
