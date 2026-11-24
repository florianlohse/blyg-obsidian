// The Studio's shelf (SH1): the owner's "saved for later" list, shared by every client of the Studio (this plugin on every device, the Studio's web app).
// Contract 6 only (`getShelf` / `putShelf` in the operations a Studio lists). Pure: nothing here asks a Studio or draws anything.
//
// The one hard fact: `PUT /shelf` REPLACES the whole list (at most 50 entries) and demands `expectedRevision`; a stale revision answers 409 with the
// current list. So a save is a read-modify-write of exactly ONE change: take the list as it is now, add or remove only this post, send it back with
// the revision it came with, and on a 409 start again from the list the Studio answered with (re-apply the one change, at most MAX_TRIES sends).
// Nothing is ever sent without a revision, and a list is never rebuilt from anything but what the Studio said last: another client's change is never undone.
import { isRecord } from "../core/frontmatter";
import { readOwnReadingEntry, type ReadingPost } from "./reading";
import type { StudioFailure, StudioResult } from "./types";

/** The most entries the Studio keeps on the shelf. */
export const SHELF_MAX = 50;
/** The Studio's name for the owner's own items (upstream `OWN_SUBSCRIPTION`). */
export const SHELF_OWN = "~own";
/** How many times one save sends the list before it gives up (a send that loses a race to another client is one try). */
export const MAX_TRIES = 3;
/** The operation ids a Studio lists when it has the shelf. */
export const SHELF_OPERATIONS = { get: "getShelf", put: "putShelf" } as const;

export interface ShelfEntry {
  sub: string;
  remoteId: string;
}
export interface Shelf {
  entries: ShelfEntry[];
  revision: number;
}

const same = (a: ShelfEntry, b: ShelfEntry): boolean => a.sub === b.sub && a.remoteId === b.remoteId;

type PostKey = Pick<ReadingPost, "own" | "subscriptionId" | "remoteId">;
/** The shelf entry that names a post of the feed: a blyg's post by its subscription, the owner's own post as `~own`. Null for a post no subscription holds (a mention's post of a blyg that is not followed): it cannot be shelved. */
export function shelfEntryOf(p: PostKey): ShelfEntry | null {
  if (p.own === true) return { sub: SHELF_OWN, remoteId: p.remoteId };
  return p.subscriptionId === "" ? null : { sub: p.subscriptionId, remoteId: p.remoteId };
}

export const isShelved = (shelf: Shelf | null, p: PostKey): boolean => {
  const e = shelfEntryOf(p);
  return shelf !== null && e !== null && shelf.entries.some((x) => same(x, e));
};

/** `{entries, revision}` as the Studio sends it, read defensively; null when it is not in that form. */
export function readShelf(json: unknown): Shelf | null {
  if (!isRecord(json) || !Array.isArray(json.entries) || typeof json.revision !== "number" || !Number.isInteger(json.revision) || json.revision < 0) return null;
  const entries: ShelfEntry[] = [];
  for (const e of json.entries as unknown[]) {
    if (!isRecord(e) || typeof e.sub !== "string" || typeof e.remoteId !== "string" || e.sub === "" || e.remoteId === "") return null; // an entry that cannot be read: the whole answer is not trusted (a PUT built from it would drop it)
    entries.push({ sub: e.sub, remoteId: e.remoteId });
  }
  return { entries, revision: json.revision };
}

/** A row of `GET /reading?shelf=true` as a post. The Studio's merged list names less than the reading list does (no author, no origin), so the reader prefers the loaded post of the same key when it has one. */
export function readShelvedRow(row: unknown): ReadingPost | null {
  if (!isRecord(row)) return null;
  if (row.source === "own") return readOwnReadingEntry(row);
  const i = row.source === "imported" && isRecord(row.imported) ? row.imported : null;
  if (i === null || typeof i.subscriptionId !== "string" || typeof i.remoteId !== "string" || typeof i.contentHtml !== "string" || typeof i.version !== "number") return null;
  if (i.subscriptionId === "" || (i.kind !== "fragment" && i.kind !== "thread")) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    subscriptionId: i.subscriptionId,
    subscriptionTitle: str(i.subscriptionTitle),
    origin: null,
    remoteId: i.remoteId,
    kind: i.kind,
    withdrawn: i.withdrawn === true,
    version: i.version,
    readVersion: typeof i.readVersion === "number" ? i.readVersion : null,
    observedAt: str(i.observedAt),
    created: str(i.updated) || null,
    isReply: false,
    contentHtml: i.contentHtml,
    contentMd: "",
    authorName: null,
    authorUrl: null,
    sourceUrl: typeof i.sourceUrl === "string" ? i.sourceUrl : null,
  };
}

export type ShelfChange = { kind: "add" | "remove"; entry: ShelfEntry };

/** The list with this one change applied, or why not: `same` (already so: nothing to send) or `full` (adding to a shelf that holds SHELF_MAX). A new entry goes first: what you saved last is on top. */
export function applyChange(entries: readonly ShelfEntry[], change: ShelfChange): { kind: "next"; entries: ShelfEntry[] } | { kind: "same" } | { kind: "full" } {
  const has = entries.some((e) => same(e, change.entry));
  if (change.kind === "remove") return has ? { kind: "next", entries: entries.filter((e) => !same(e, change.entry)) } : { kind: "same" };
  if (has) return { kind: "same" };
  if (entries.length >= SHELF_MAX) return { kind: "full" };
  return { kind: "next", entries: [change.entry, ...entries] };
}

/** What a PUT answers: the stored list, a 409 with the list as it is now (`stale`), or a Studio without the shelf (`absent`). */
export type ShelfPutResult = { kind: "ok"; value: Shelf } | { kind: "stale"; current: Shelf } | { kind: "absent" } | StudioFailure;
/** The two requests a save needs. `get` answers null when the Studio has no shelf. */
export interface ShelfPort {
  get(): Promise<StudioResult<Shelf | null>>;
  put(entries: ShelfEntry[], expectedRevision: number): Promise<ShelfPutResult>;
}

export type ShelfOutcome =
  /** Saved (or removed), or it already was so. `shelf` is what the Studio holds now; `sent` is false when nothing needed sending. */
  | { kind: "done"; shelf: Shelf; sent: boolean }
  /** Adding, but the Studio's shelf already holds SHELF_MAX: nothing was sent and nothing was dropped. */
  | { kind: "full"; shelf: Shelf }
  /** The Studio accepted the list but did not keep the new entry (it does not hold that post, or it is withdrawn). */
  | { kind: "dropped"; shelf: Shelf }
  /** Another client changed the shelf every time we tried, MAX_TRIES times. Nothing was overwritten. */
  | { kind: "busy"; shelf: Shelf }
  /** This Studio has no shelf (it does not list the operations). */
  | { kind: "absent" }
  /** The token cannot read (`owner:read`) or change (`owner:manage`) the shelf. */
  | { kind: "no-scope"; need: "owner:read" | "owner:manage" }
  | { kind: "failed"; message: string };

const failedWith = (f: StudioFailure): ShelfOutcome => {
  if (f.kind === "forbidden") return { kind: "no-scope", need: "owner:manage" };
  if (f.kind === "incompatible") return { kind: "failed", message: f.message };
  if (f.kind === "unauthorized") return { kind: "failed", message: "The Studio does not accept the token. Make a new token and paste it into the keychain entry." };
  if (f.kind === "conflict") return { kind: "failed", message: "The Studio answered with a conflict the plugin cannot read. Try again." };
  return { kind: "failed", message: "message" in f && f.message !== "" ? f.message : "The Studio could not be reached, so the shelf was not changed." };
};

/**
 * Add or remove ONE post, never anything else. Starts from `known` (the list the caller holds, with its revision) or, without one, from `GET /shelf`.
 * Each send carries the revision of the list it was made from; a 409 hands over the current list, the one change is applied to that, and it is sent again
 * (at most `tries` sends; then `busy`). Nothing is sent when the change is already so, or when adding to a full shelf.
 */
export async function changeShelf(port: ShelfPort, change: ShelfChange, known: Shelf | null, tries = MAX_TRIES): Promise<ShelfOutcome> {
  let current = known;
  if (current === null) {
    const got = await port.get();
    if (got.kind !== "ok") return got.kind === "forbidden" ? { kind: "no-scope", need: "owner:read" } : failedWith(got);
    if (got.value === null) return { kind: "absent" };
    current = got.value;
  }
  for (let attempt = 0; attempt < tries; attempt++) {
    const next = applyChange(current.entries, change);
    if (next.kind === "same") return { kind: "done", shelf: current, sent: false };
    if (next.kind === "full") return { kind: "full", shelf: current };
    const put = await port.put(next.entries, current.revision);
    if (put.kind === "ok") {
      if (change.kind === "add" && !put.value.entries.some((e) => same(e, change.entry))) return { kind: "dropped", shelf: put.value };
      return { kind: "done", shelf: put.value, sent: true };
    }
    if (put.kind === "stale") {
      current = put.current; // the answer to the race: re-apply the one change to what the other client left
      continue;
    }
    if (put.kind === "absent") return { kind: "absent" };
    return failedWith(put);
  }
  return { kind: "busy", shelf: current };
}

/** One plain line for an outcome that is not a success (shown in the reader's status line). Never mentions a token's value. */
export function shelfMessage(o: Exclude<ShelfOutcome, { kind: "done" }>, change: ShelfChange["kind"] = "add"): string {
  switch (o.kind) {
    case "full": return `Your shelf is full (${SHELF_MAX} posts). Remove one from Saved first; nothing was dropped.`;
    case "dropped": return "Your Studio did not keep this post on the shelf (it does not hold it any more).";
    case "busy": return "The shelf kept changing on another device. Nothing was overwritten: try again.";
    case "absent": return "This Studio has no shelf yet. Update the Studio to save posts.";
    case "no-scope": return `Your token cannot ${o.need === "owner:read" ? "read" : "change"} the shelf. It needs the permission “${o.need}”: make a new token with every permission.`;
    case "failed": return change === "add" ? `Not saved: ${o.message}` : `Not removed: ${o.message}`;
  }
}
