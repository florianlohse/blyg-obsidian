// PROOF OF CONCEPT (roadmap S15, reader side): rows of the Studio's reading list and of its mentions list, read defensively.
// Nothing here is shipped or wired into a release; it exists to measure how hard a reader inside the plugin is.
import { isRecord } from "../core/frontmatter";

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
  contentHtml: string;
  contentMd: string;
  authorName: string | null;
  /** The origin's public page for the item, when it declares one (a hand-off target: "open on the web"). */
  sourceUrl: string | null;
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
    contentHtml,
    contentMd: str(row.contentMd) ?? "",
    authorName: author,
    sourceUrl: str(row.sourceUrl) ?? str(row.page),
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
