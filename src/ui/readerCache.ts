// S15: the reader's list kept between sessions, so the feed shows at once and is brought up to date behind it. Pure: main.ts reads and writes the file.
//
// It holds other people's posts, so the rules of 2026-10-06 apply: it lives in the plugin's own folder (inside the vault's configuration folder), never in a note;
// it is only used for the Studio it came from, and only while it is fresh; the Markdown of the posts (which the reader never shows) is left out; and nothing
// read back from the file is trusted: every field is checked and rebuilt.
import type { InboundMention, ReadingPost } from "../studio/reading";

export const CACHE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
export const CACHE_POSTS = 200;
const CACHE_MENTIONS = 200;
const RELATIONS = ["stub", "transclusion", "fork", "source"] as const;
const STATUSES = ["pending", "verified", "failed", "gone"] as const;

export interface ReaderCacheFile {
  v: 1;
  origin: string;
  savedAt: number;
  posts: ReadingPost[];
  mentions: InboundMention[];
}

const time = (p: ReadingPost): number => Date.parse(p.observedAt) || 0;

/** What to write: the newest posts without their Markdown, and the mentions. */
export function readerCacheOf(posts: ReadingPost[], mentions: InboundMention[], origin: string, now: number): ReaderCacheFile {
  const newest = [...posts].sort((a, b) => time(b) - time(a)).slice(0, CACHE_POSTS).map((p) => ({ ...p, contentMd: "" }));
  return { v: 1, origin, savedAt: now, posts: newest, mentions: mentions.slice(0, CACHE_MENTIONS) };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function postFromCache(row: unknown): ReadingPost | null {
  if (!isRecord(row)) return null;
  const subscriptionId = str(row.subscriptionId);
  const remoteId = str(row.remoteId);
  const contentHtml = str(row.contentHtml);
  if (!subscriptionId || !remoteId || contentHtml === null || (row.kind !== "fragment" && row.kind !== "thread") || typeof row.version !== "number") return null;
  const stub = isRecord(row.stubTarget) && typeof row.stubTarget.origin === "string" && typeof row.stubTarget.id === "string" ? { origin: row.stubTarget.origin, id: row.stubTarget.id } : null;
  return {
    subscriptionId,
    subscriptionTitle: str(row.subscriptionTitle) ?? "",
    origin: str(row.origin),
    remoteId,
    kind: row.kind,
    withdrawn: row.withdrawn === true,
    version: row.version,
    readVersion: typeof row.readVersion === "number" ? row.readVersion : null,
    observedAt: str(row.observedAt) ?? "",
    created: str(row.created),
    isReply: row.isReply === true,
    stubTarget: stub,
    contentHtml,
    contentMd: "",
    authorName: str(row.authorName),
    authorUrl: str(row.authorUrl),
    sourceUrl: str(row.sourceUrl),
  };
}

function mentionFromCache(row: unknown): InboundMention | null {
  if (!isRecord(row)) return null;
  const id = str(row.id);
  const targetItemId = str(row.targetItemId);
  const status = STATUSES.find((s) => s === row.status);
  if (!id || !targetItemId || !status) return null;
  return { id, targetItemId, relation: RELATIONS.find((r) => r === row.relation) ?? null, status, hidden: row.hidden === true, sourceOrigin: str(row.sourceOrigin), sourceId: str(row.sourceId), sourcePage: str(row.sourcePage), sourceAuthorName: str(row.sourceAuthorName), firstSeen: str(row.firstSeen) ?? "" };
}

/** What was read from the file, or null when it is not usable: not ours, another Studio's, or too old. */
export function parseReaderCache(raw: unknown, origin: string, now: number): { posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number; studioOrigin: string } | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.origin !== origin || typeof raw.savedAt !== "number" || !Array.isArray(raw.posts)) return null;
  if (now - raw.savedAt > CACHE_MAX_AGE_MS || raw.savedAt > now + 60_000) return null;
  const posts = raw.posts.slice(0, CACHE_POSTS).map(postFromCache).filter((p): p is ReadingPost => p !== null);
  const mentions = (Array.isArray(raw.mentions) ? raw.mentions.slice(0, CACHE_MENTIONS) : []).map(mentionFromCache).filter((m): m is InboundMention => m !== null);
  return posts.length === 0 ? null : { posts, mentions, savedAt: raw.savedAt, studioOrigin: origin };
}
