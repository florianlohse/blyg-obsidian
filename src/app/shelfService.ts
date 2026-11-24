// The reader's shelf (SH1): what the reader and the Daily ask of the plugin to save a post for later, built on the Studio's shelf (studio/shelf.ts).
// Keeps a small cache of the shelf (the entries and the revision they came with), read at most once per Feed opening and refreshed by every save the plugin makes
// itself: no timer, no polling. A save is one `PUT /shelf` (the one write; a read costs no write); a conflict is answered by the Studio with the current list, so
// a save normally needs no read of its own. Saves are queued, one after the other, so two taps never race each other for the revision.
import type { StudioClient } from "../studio/client";
import type { ReadingPost } from "../studio/reading";
import { tokenScopes } from "../studio/jwt";
import { changeShelf, isShelved, shelfEntryOf, shelfMessage, SHELF_MAX, type Shelf, type ShelfPort } from "../studio/shelf";

export type ShelfBuild = { ok: true; studio: { client: StudioClient }; token: string } | { ok: false; message: string };
export type ShelfResult = { ok: true; saved: boolean } | { ok: false; message: string };

/** What the reader and the Daily hold. `on()` false (the feature is off): everything below is absent; nothing is asked of the Studio. */
export interface ShelfFacade {
  on(): boolean;
  /** The Studio has a shelf and this session has read it (so `has` and `full` can be believed). */
  ready(): boolean;
  /** Is this post on the shelf, as far as the cache knows (false until read, false for a post that cannot be shelved). */
  has(p: ReadingPost): boolean;
  count(): number;
  full(): boolean;
  /** Called when a Feed opens (the reader, the Daily): reads the shelf once per call that follows a `reset()`; never throws. */
  opening(): Promise<void>;
  /** A new Feed opening: the next `opening()` reads again. */
  reset(): void;
  /** The shelf could not be read for want of a connection (so `ready()` is false for now): Save is still offered, and a tap reads again first. */
  lost?(): boolean;
  /** The shelf has not been read yet this opening and nothing says it is absent: the reader keeps room for the Save button. */
  settling?(): boolean;
  /** Save the post, or take it off the shelf when it is on it. One write; the answer says which state the post is in now. */
  toggle(p: ReadingPost): Promise<ShelfResult>;
  /** The shelved posts in shelf order (one read). `null`: could not be had (the cache is not touched). */
  saved(): Promise<ReadingPost[] | null>;
}

const OFF_MESSAGE = "Saving posts is switched off in Settings → Experimental features.";
/** How long one save may take before it counts as a lost connection (a request on a dropped connection can hang). */
export const SEND_TIMEOUT_MS = 20_000;
const windowAfter = (ms: number, fn: () => void): (() => void) => {
  if (typeof window === "undefined") return () => undefined; // no window (a test without a clock): no limit
  const h = window.setTimeout(fn, ms);
  return () => window.clearTimeout(h);
};
const noConnection = (kind: "add" | "remove"): string => (kind === "add" ? "Could not save, no connection. Tap Save to try again." : "Could not remove, no connection. Tap Saved to try again.");

export function createShelf(deps: { build: () => ShelfBuild; enabled: () => boolean; timeoutMs?: number; after?: (ms: number, fn: () => void) => () => void }): ShelfFacade {
  let shelf: Shelf | null = null;
  let lost = false;
  let fresh = false;
  let queue: Promise<unknown> = Promise.resolve();
  let pending: Promise<void> | null = null;

  const readOnce = async (): Promise<void> => {
    const built = deps.build();
    if (!built.ok) return;
    const got = await built.studio.client.getShelf().catch(() => null);
    if (got?.kind === "ok") shelf = got.value; // a Studio without the shelf: none (nothing is shown as saved)
    lost = got?.kind !== "ok" && shelf === null; // a failure leaves the cache as it was (empty at first: nothing is shown as saved, and Save says so when tapped)
  };
  const portOf = (client: StudioClient): ShelfPort => ({ get: () => client.getShelf(), put: (entries, rev) => client.putShelf(entries, rev) });

  const facade: ShelfFacade = {
    on: () => deps.enabled(),
    ready: () => deps.enabled() && shelf !== null,
    has: (p) => deps.enabled() && isShelved(shelf, p),
    count: () => shelf?.entries.length ?? 0,
    full: () => (shelf?.entries.length ?? 0) >= SHELF_MAX,
    reset: () => {
      fresh = false;
    },
    lost: () => deps.enabled() && shelf === null && lost,
    settling: () => deps.enabled() && shelf === null && !lost && (!fresh || pending !== null),
    opening: () => {
      if (!deps.enabled() || fresh) return pending ?? Promise.resolve();
      fresh = true;
      pending = readOnce().finally(() => {
        pending = null;
      });
      return pending;
    },
    toggle: (p) => {
      const run = async (): Promise<ShelfResult> => {
        if (!deps.enabled()) return { ok: false, message: OFF_MESSAGE };
        const entry = shelfEntryOf(p);
        if (entry === null) return { ok: false, message: "This post is not held by your Studio (its blyg is not followed), so it cannot be saved." };
        const built = deps.build();
        if (!built.ok) return { ok: false, message: built.message };
        const scopes = tokenScopes(built.token);
        if (scopes !== null && !scopes.includes("owner:manage")) return { ok: false, message: shelfMessage({ kind: "no-scope", need: "owner:manage" }) };
        if (shelf === null && lost) fresh = false; // the read that failed is tried again by this tap
        await facade.opening(); // the cache says which way this tap goes: save, or take off
        const kind = isShelved(shelf, p) ? "remove" : "add";
        if (shelf === null && lost) return { ok: false, message: noConnection(kind) }; // still no connection: nothing is sent
        const gone = { kind: "lost" } as const;
        const sending = changeShelf(portOf(built.studio.client), { kind, entry }, shelf).catch(() => gone);
        let cancel = (): void => undefined;
        const timer = new Promise<typeof gone>((r) => void (cancel = (deps.after ?? windowAfter)(deps.timeoutMs ?? SEND_TIMEOUT_MS, () => r(gone))));
        const done = await Promise.race([sending, timer]).finally(cancel);
        if (done.kind === "lost") return { ok: false, message: noConnection(kind) };
        if ("shelf" in done) shelf = done.shelf;
        if (done.kind === "done") return { ok: true, saved: kind === "add" };
        return { ok: false, message: shelfMessage(done, kind) };
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
    saved: async () => {
      if (!deps.enabled()) return null;
      const built = deps.build();
      if (!built.ok) return null;
      const got = await built.studio.client.listShelved().catch(() => null);
      return got?.kind === "ok" && got.value !== null ? got.value.posts : null;
    },
  };
  return facade;
}
