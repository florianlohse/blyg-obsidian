// S15 chunk 2b: what the reader needs to show a mention like a post. A mention row says who mentioned one of the owner's items and where; the TEXT of the
// mentioning item comes from the reading list when the Studio reads that blyg, otherwise from a peek at it by address (no subscription needed).
import type { StudioPeek } from "../studio/types";
import type { InboundMention, ReadingPost } from "../studio/reading";

/** Two addresses of the same blyg: case of the host and a closing slash do not matter. */
export function sameOrigin(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (u: string): string => u.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** The post a mention comes from, when the Studio already reads that blyg and holds it. */
export function postOfMention(posts: ReadingPost[], m: InboundMention): ReadingPost | null {
  if (!m.sourceId) return null;
  return posts.find((p) => p.remoteId === m.sourceId && sameOrigin(p.origin, m.sourceOrigin)) ?? null;
}

/**
 * A post made from a peek, to open like any post. `subscriptionId` is "" when the Studio does not read that blyg: such a post has no read mark and
 * cannot be replied to from here (there is nothing to quote it from), and the view says so.
 */
export function postFromPeek(m: InboundMention, peek: StudioPeek): ReadingPost {
  return {
    subscriptionId: peek.subscriptionId ?? "",
    subscriptionTitle: m.sourceAuthorName ?? "",
    origin: peek.origin,
    remoteId: peek.id,
    kind: peek.kind === "thread" ? "thread" : "fragment",
    withdrawn: peek.kind === "withdrawn",
    version: peek.version,
    readVersion: null,
    observedAt: m.firstSeen,
    created: m.firstSeen || null,
    isReply: m.relation === "stub",
    contentHtml: peek.kind === "withdrawn" ? "" : peek.contentHtml,
    contentMd: "",
    authorName: m.sourceAuthorName,
    authorUrl: null,
    sourceUrl: peek.url || m.sourcePage,
  };
}

/** What the mention is, in one line: "Name replied to". The item it is about follows on its own line. */
export const mentionLead = (m: InboundMention): string => `${m.sourceAuthorName ?? hostOf(m.sourceOrigin) ?? "Someone"} ${mentionVerb(m.relation)}`;

/** The badge a mention card carries: what the post did to your item, in a few words ("replied to you"). */
export function mentionBadge(r: InboundMention["relation"]): string {
  switch (r) {
    case "stub": return "replied to you";
    case "transclusion": return "quoted you";
    case "fork": return "forked yours";
    case "source": return "cited you";
    default: return "mentioned you";
  }
}

function mentionVerb(r: InboundMention["relation"]): string {
  switch (r) {
    case "stub": return "replied to your item";
    case "transclusion": return "quoted your item";
    case "fork": return "forked your item";
    case "source": return "cited your item";
    default: return "mentioned your item";
  }
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Mentions worth showing: not hidden by the owner, not failed or gone; the newest first. */
export function visibleMentions(all: InboundMention[]): InboundMention[] {
  return all
    .filter((m) => !m.hidden && (m.status === "verified" || m.status === "pending"))
    .map((m, i) => ({ m, i, t: Date.parse(m.firstSeen) }))
    .sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? b.t - a.t : a.i - b.i))
    .map((x) => x.m);
}

/** Run `jobs` with at most `limit` at a time (the peeks go to other people's blygs through the Studio: a long list must not flood it). */
export function limiter(limit: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  const next = (): void => {
    const go = waiting.shift();
    if (go) go();
  };
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await job();
    } finally {
      running--;
      next();
    }
  };
}
