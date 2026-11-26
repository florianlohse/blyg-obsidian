// HK3 Marginalia, lookup part (read-only): who quoted an item of the owner's, and what. A mention says THAT a post quoted the item; the quoted passage
// is only in the mentioning post's own text. So: mention -> source post -> parse its quote of the item. Nothing is written anywhere, and a failure is never
// shown as "nobody quoted this": a mention whose post cannot be read comes back as `unknown`.
// The quote parser (src/core/quoteRefs.ts) and the passage matcher are written elsewhere; this file knows them only through `QuoteParser`.
import type { InboundMention } from "../studio/reading";

/** What one post quotes of the item: a passage (the `>` lines under the directive) or the whole item (the directive with no `>` lines). */
export type FoundQuote = { kind: "passage"; text: string } | { kind: "whole" };

/** The parser's side of the contract: the quotes of `itemId` in a post's Markdown, in the order they stand. Empty when the post does not quote it. */
export type QuoteParser = (markdown: string, itemId: string) => FoundQuote[];

/** The source post as the lookup needs it. `markdown` is null when only rendered text could be had (a peek has HTML only): the quote cannot be parsed then. */
export interface SourcePost {
  version: number;
  markdown: string | null;
  /** The post's rendered HTML (a peek has it for any blyg), read when there is no Markdown. */
  html?: string | null;
  withdrawn: boolean;
}

/** Reads a mention's source post (held copy first, then a peek); null when it could not be had. Must not throw; a throw counts as "could not be had". */
export type SourceReader = (m: MarginaliaMention) => Promise<SourcePost | null>;

export type MarginaliaMention = Pick<InboundMention, "id" | "targetItemId" | "relation" | "status" | "hidden" | "sourceOrigin" | "sourceId" | "sourcePage" | "sourceAuthorName" | "firstSeen"> & {
  sourceVersion?: number | null;
};

export type UnknownReason = "unreadable" | "no-text" | "over-cap" | "withdrawn";

export type MentionQuotes =
  | { kind: "quotes"; quotes: FoundQuote[]; version: number }
  /** The mention says it quoted, but what was quoted is not known: never to be shown as an empty list. */
  | { kind: "unknown"; reason: UnknownReason };

export interface MarginaliaEntry {
  mention: MarginaliaMention;
  result: MentionQuotes;
}

export interface LookupOptions {
  /** At most this many source posts are looked up per call; the rest come back `unknown` / `over-cap`. */
  cap?: number;
  /** How many lookups run at once. */
  parallel?: number;
}

export const DEFAULT_CAP = 20;
const DEFAULT_PARALLEL = 3;
const CACHE_MAX = 300;

/**
 * Mentions of the item whose post may hold a quote of it: verified, not hidden, with an address to read. Newest first.
 * Two relations: `transclusion` (a post that quotes it) and `stub` (a reply; measured on a real Studio 0.51.0 on 2026-11-26: a reply whose text quotes the item with a
 * directive is recorded as `stub`, never as `transclusion`, one relation per post and item). Forks, sources and links carry no quote.
 */
export function quotingMentions(all: MarginaliaMention[], itemId: string): MarginaliaMention[] {
  return all
    .filter((m) => m.targetItemId === itemId && (m.relation === "transclusion" || m.relation === "stub") && m.status === "verified" && !m.hidden && !!m.sourceOrigin && !!m.sourceId)
    .sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0));
}

const keyOf = (m: MarginaliaMention, version: number): string => `${(m.sourceOrigin ?? "").replace(/\/+$/, "").toLowerCase()}\n${m.sourceId}\n${version}\n${m.targetItemId}`;

/** Looks quotes up and remembers the answers per (source post, its version, item): a post's version changes when its text does, so an answer stays right. */
export class MarginaliaLookup {
  private readonly cache = new Map<string, FoundQuote[]>();

  constructor(private readonly read: SourceReader, private readonly parse: QuoteParser, private readonly parseHtml?: QuoteParser) {}

  /** For every quoting mention of `itemId` in `mentions`, in order, what it quoted. Never throws; a failed lookup is an `unknown` entry. */
  async lookup(mentions: MarginaliaMention[], itemId: string, opts: LookupOptions = {}): Promise<MarginaliaEntry[]> {
    const cap = Math.max(0, opts.cap ?? DEFAULT_CAP);
    const parallel = Math.max(1, opts.parallel ?? DEFAULT_PARALLEL);
    const list = quotingMentions(mentions, itemId);
    const out: MarginaliaEntry[] = new Array<MarginaliaEntry>(list.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        const mention = list[i]!;
        out[i] = { mention, result: i >= cap ? { kind: "unknown", reason: "over-cap" } : await this.one(mention) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, worker));
    return out;
  }

  private async one(m: MarginaliaMention): Promise<MentionQuotes> {
    // The Studio often says which version of the post it saw: then a held answer needs no request at all.
    if (typeof m.sourceVersion === "number") {
      const hit = this.cache.get(keyOf(m, m.sourceVersion));
      if (hit) return { kind: "quotes", quotes: hit, version: m.sourceVersion };
    }
    let post: SourcePost | null;
    try {
      post = await this.read(m);
    } catch {
      post = null;
    }
    if (!post) return { kind: "unknown", reason: "unreadable" };
    if (post.withdrawn) return { kind: "unknown", reason: "withdrawn" };
    const held = this.cache.get(keyOf(m, post.version));
    if (held) return { kind: "quotes", quotes: held, version: post.version };
    const html = post.markdown === null && this.parseHtml && post.html ? post.html : null;
    if (post.markdown === null && html === null) return { kind: "unknown", reason: "no-text" };
    let quotes: FoundQuote[];
    try {
      quotes = html !== null ? this.parseHtml!(html, m.targetItemId) : this.parse(post.markdown as string, m.targetItemId);
    } catch {
      return { kind: "unknown", reason: "no-text" };
    }
    // A reply may quote nothing: then it is a reply and says so (no quotes). A post the Studio said it QUOTED but whose text shows no quote may be a different
    // version than the mention saw: that is not "no quote", it is unknown.
    if (quotes.length === 0 && m.relation !== "stub") return { kind: "unknown", reason: "no-text" };
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(keyOf(m, post.version), quotes);
    return { kind: "quotes", quotes, version: post.version };
  }
}
