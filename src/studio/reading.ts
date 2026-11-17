// PROOF OF CONCEPT (roadmap S15, reader side): rows of the Studio's reading list and of its mentions list, read defensively.
// Nothing here is shipped or wired into a release; it exists to measure how hard a reader inside the plugin is.
import { isRecord } from "../core/frontmatter";
import { isBlygStub, readWireStub } from "./stub";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One post the owner reads: a row of `GET /api/reading/imported` (contract 5.x). Foreign content: `contentHtml` is the Studio's sanitised markup, `contentMd` the origin's Markdown. */
export interface ReadingPost {
  subscriptionId: string;
  subscriptionTitle: string;
  /** The blyg the post belongs to (its origin address). */
  origin: string | null;
  remoteId: string;
  kind: "fragment" | "thread";
  withdrawn: boolean;
  version: number;
  /** Highest version marked read; null = unread. A readVersion below `version` means a newer version arrived after it was read. */
  readVersion: number | null;
  observedAt: string;
  /** When the author made it (the origin's own date), when known. */
  created: string | null;
  /** True when the post answers another item (`stubOf`). */
  isReply: boolean;
  /** What the post answers, when that is an item of a blyg (its origin and id): so a post can show the replies to it that the reader can see. */
  stubTarget?: { origin: string; id: string } | null;
  contentHtml: string;
  contentMd: string;
  authorName: string | null;
  /** The author's own page, when the post declares one. */
  authorUrl: string | null;
  /** The origin's public page for the item, when it declares one (a hand-off target: "open on the web"). */
  sourceUrl: string | null;
  /** One of the owner's own posts (from the Studio's `/reading`, `source: "own"`), not a post of a blyg read: never unread, no read mark, no Reply from here. */
  own?: boolean;
}

export const isUnread = (p: ReadingPost): boolean => !p.withdrawn && (p.readVersion === null || p.readVersion < p.version);

export function readReadingPost(row: unknown): ReadingPost | null {
  if (!isRecord(row)) return null;
  const subscriptionId = str(row.subscriptionId);
  const remoteId = str(row.remoteId);
  const contentHtml = str(row.contentHtml);
  if (!subscriptionId || !remoteId || contentHtml === null) return null;
  if (row.kind !== "fragment" && row.kind !== "thread") return null;
  if (typeof row.version !== "number") return null;
  const author = isRecord(row.author) ? str(row.author.name) : null;
  const authorUrl = isRecord(row.author) ? str(row.author.url) : null;
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
    isReply: isRecord(row.stubOf),
    stubTarget: ((t) => (t && isBlygStub(t) ? { origin: t.origin, id: t.id } : null))(readWireStub(row.stubOf)),
    contentHtml,
    contentMd: str(row.contentMd) ?? "",
    authorName: author,
    authorUrl,
    sourceUrl: str(row.sourceUrl) ?? str(row.page),
  };
}

/** An entry of the Studio's merged reading list (`GET /reading`) that is the owner's own post, as a post of the feed; anything else is null. */
export function readOwnReadingEntry(row: unknown): ReadingPost | null {
  if (!isRecord(row) || row.source !== "own" || !isRecord(row.own)) return null;
  const own = row.own;
  const id = str(own.id);
  const contentHtml = str(own.contentHtml) ?? str(row.contentHtml);
  if (!id || contentHtml === null) return null;
  const kind = own.kind === "thread" ? "thread" : own.kind === "fragment" ? "fragment" : null;
  if (kind === null) return null;
  const when = str(row.displayAt) ?? str(own.updated) ?? "";
  return {
    subscriptionId: "",
    subscriptionTitle: "Your blyg",
    origin: null,
    remoteId: id,
    kind,
    withdrawn: own.withdrawn === true,
    version: 1,
    readVersion: 1, // never unread
    observedAt: when,
    created: str(own.updated) ?? (when || null),
    isReply: false,
    contentHtml,
    contentMd: "",
    authorName: null,
    authorUrl: null,
    sourceUrl: null,
    own: true,
  };
}

/** One inbound mention of an item of the owner's: a row of `GET /api/mentions?direction=inbound`. */
export interface InboundMention {
  id: string;
  targetItemId: string;
  relation: "stub" | "transclusion" | "fork" | "source" | null;
  status: "pending" | "verified" | "failed" | "gone";
  hidden: boolean;
  /** Where the mentioning item lives, so the reader can open it. */
  sourceOrigin: string | null;
  sourceId: string | null;
  sourcePage: string | null;
  sourceAuthorName: string | null;
  firstSeen: string;
}

const RELATIONS = ["stub", "transclusion", "fork", "source"] as const;
const STATUSES = ["pending", "verified", "failed", "gone"] as const;

export function readInboundMention(row: unknown): InboundMention | null {
  if (!isRecord(row)) return null;
  const id = str(row.id);
  const targetItemId = str(row.targetItemId);
  const status = STATUSES.find((s) => s === row.status);
  if (!id || !targetItemId || !status) return null;
  const relation = RELATIONS.find((r) => r === row.relation) ?? null;
  const author = isRecord(row.sourceAuthor) ? str(row.sourceAuthor.name) : null;
  return { id, targetItemId, relation, status, hidden: row.hidden === true, sourceOrigin: str(row.sourceOrigin), sourceId: str(row.sourceId), sourcePage: str(row.sourcePage), sourceAuthorName: author, firstSeen: str(row.firstSeen) ?? "" };
}

/** What a mention says in plain words (the relation, as the Studio reports it). */
export function relationWords(r: InboundMention["relation"]): string {
  switch (r) {
    case "stub": return "replied to";
    case "transclusion": return "quoted";
    case "fork": return "forked";
    case "source": return "cited";
    default: return "mentioned";
  }
}
