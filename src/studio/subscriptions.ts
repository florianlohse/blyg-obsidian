// The Studio's subscriptions ("blygs I follow"), as the owner API shows them (`/subscriptions`, contract 5). Reading only: the calls are in client.ts.
import type { StudioResult } from "./types";

/** One subscription of the Studio. `status` is the Studio's own word: `active`, `paused` (it fetches nothing), or `degraded` (recent fetches failed). */
export interface StudioFollowed {
  id: string;
  kind: "blyg" | "rss";
  /** The blyg's identity origin (for a feed, the site it belongs to). */
  origin: string;
  feedUrl: string;
  title: string;
  status: "active" | "paused" | "degraded";
  lastPollAt: string | null;
  failCount: number;
  /** True while the title is the source's own and follows it; false once the owner has named it. */
  titleFollowsSource: boolean;
  /** Set when the subscription is one public hopper of a blyg rather than the whole blyg. */
  hopperFeedUrl: string | null;
}

/** What the Studio proposes before it creates a subscription (`POST /subscriptions` without `confirm`, answered 200). */
export interface StudioFollowProposal {
  kind: "blyg" | "rss" | "hopper";
  origin: string;
  feedUrl: string;
  title: string;
  /** For `kind: "hopper"`: the whole blyg's title, for offering to follow the whole blyg instead. */
  blygTitle: string | null;
  hopperTitle: string | null;
}

export type StudioFollowAnswer = { state: "proposal"; proposal: StudioFollowProposal } | { state: "created"; subscription: StudioFollowed };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A subscription row; null when it is not in the expected form (the caller counts or skips it). */
export function readFollowed(json: unknown): StudioFollowed | null {
  if (!isRecord(json)) return null;
  const { id, origin } = json;
  if (typeof id !== "string" || id === "" || typeof origin !== "string") return null;
  const status = json.status === "paused" || json.status === "degraded" ? json.status : "active";
  return {
    id,
    kind: json.kind === "rss" ? "rss" : "blyg",
    origin,
    feedUrl: str(json.feedUrl) ?? "",
    title: str(json.title) ?? "",
    status,
    lastPollAt: str(json.lastPollAt),
    failCount: typeof json.failCount === "number" ? json.failCount : 0,
    titleFollowsSource: json.titleFollowsSource !== false,
    hopperFeedUrl: str(json.hopperFeedUrl),
  };
}

export function readProposal(json: unknown): StudioFollowProposal | null {
  if (!isRecord(json) || json.needsConfirm !== true) return null;
  const kind = json.kind === "rss" || json.kind === "hopper" ? json.kind : json.kind === "blyg" ? "blyg" : null;
  if (kind === null || typeof json.title !== "string") return null;
  return {
    kind,
    origin: str(json.origin) ?? "",
    feedUrl: str(json.feedUrl) ?? "",
    title: json.title,
    blygTitle: str(json.blygTitle),
    hopperTitle: isRecord(json.hopper) ? str(json.hopper.title) : null,
  };
}

/** What the Studio does when a subscription is deleted (Studio 0.51.0 `deleteSubscription`, checked in its source; its docs say "local data only"). */
export const UNFOLLOW_EFFECT = {
  removed: ["imported posts of that blyg", "the owner's hopper memberships of those posts", "thumbs and signals on them", "read state"],
  kept: ["the owner's own items", "notes already in the vault"],
} as const;

export type FollowedResult = StudioResult<StudioFollowed>;
