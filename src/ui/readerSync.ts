// S15: how the reader keeps its list up to date without reading more than it must. Pure.
//
// Credit where it is due: the approach follows Burrow (https://github.com/aneeshsathe/blygger-desktop, by Aneesh Sathe), whose release 0.21 "Sync reads less from
// the blyg" showed the way: look at the Studio's change counters first and read the list again only when something moved, never in a tight loop; walk
// the whole list only now and then as a safety net; back off when the Studio answers 5xx instead of asking again at once; pages of the API's maximum size.
// The Studio has no "changed since" read of the reading list (Burrow's docs say so too), so a client has to be careful how often it asks.
// What was measured, and why: projects "refresh scaling" investigation (2026-11-15), recorded in the maintainer's notes.
import type { ReadingPost } from "../studio/reading";

/** The API's maximum page of the reading list. */
export const READER_PAGE = 100;
/** How many pages one walk reads: 2 x 100 = the newest 200 posts. A larger window ("load older") is planned, not built. */
export const READER_PAGES = 2;
/** How many posts the reader keeps in memory when newer pages are merged into what it has. */
export const READER_KEEP = 600;
/** A walk of the whole window is repeated at least this often when only read marks moved (Burrow: 60 s). */
export const FULL_GAP_MS = 60_000;
/** A walk of the whole window happens at least this often while anything moved at all: the safety net (Burrow's starts at 10 min). */
export const SAFETY_MS = 10 * 60_000;

export const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;
/** What makes a row "the same" as one already held: its version and the read mark on it. */
export const signature = (p: ReadingPost): string => `${p.version}/${p.readVersion ?? "-"}/${p.withdrawn ? "w" : ""}`;

export function knownOf(posts: ReadingPost[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of posts) m.set(keyOf(p), signature(p));
  return m;
}

/**
 * True when the oldest row of this page is held already, unchanged. The list comes newest first and an edited post moves to the top, so a page that ends in
 * known territory has nothing new behind it: the walk can stop there. (A read mark made elsewhere on an old row is caught by the periodic full walk.)
 */
export function reachedKnown(page: ReadingPost[], known: Map<string, string>): boolean {
  const last = page[page.length - 1];
  return last !== undefined && known.get(keyOf(last)) === signature(last);
}

/** How many of these rows are new or changed against what is held. */
export function changedCount(fresh: ReadingPost[], known: Map<string, string>): number {
  let n = 0;
  for (const p of fresh) if (known.get(keyOf(p)) !== signature(p)) n++;
  return n;
}

/** The newest rows merged into the list held: the fresh row wins, the rest stays, newest first, at most `keep`. */
export function mergeFresh(held: ReadingPost[], fresh: ReadingPost[], keep: number = READER_KEEP): ReadingPost[] {
  const byKey = new Map<string, ReadingPost>();
  for (const p of held) byKey.set(keyOf(p), p);
  for (const p of fresh) byKey.set(keyOf(p), p);
  const time = (p: ReadingPost): number => Date.parse(p.observedAt) || 0;
  return [...byKey.values()].sort((a, b) => time(b) - time(a)).slice(0, keep);
}

/**
 * A read of the list that did not ask for the owner's own posts (a quick look: they come with a whole read only) must not make them vanish: the ones held
 * stay, unless the fresh list brings them itself.
 */
export function keepOwnPosts(held: ReadingPost[], fresh: ReadingPost[]): ReadingPost[] {
  if (fresh.some((p) => p.own === true)) return fresh;
  const own = held.filter((p) => p.own === true);
  return own.length === 0 ? fresh : [...fresh, ...own];
}

export interface SyncMemory {
  /** When the whole window was last read (0: never). */
  lastFullAt: number;
  /** The Studio's reading counter moved since the last whole walk. */
  readingMoved: boolean;
  /** The last partial walk, run because the counter moved, found nothing new: a read mark elsewhere, most likely. */
  movedWithoutNew: boolean;
}

/**
 * Walk the whole window, or only the newest rows? The whole window when nothing is held, as a safety net now and then while anything moved, and when only
 * read marks seem to have moved (at most once a minute); the newest rows otherwise. `force`: the person asked (Refresh): the whole window if the last was over a minute ago.
 */
export function chooseWalk(m: SyncMemory, now: number, haveData: boolean, force = false): "full" | "incremental" {
  if (!haveData) return "full";
  const since = now - m.lastFullAt;
  if (force && since >= FULL_GAP_MS) return "full";
  if (m.readingMoved && since >= SAFETY_MS) return "full";
  if (m.movedWithoutNew && since >= FULL_GAP_MS) return "full";
  return "incremental";
}

/** How long to leave the Studio alone after its `n`th failure in a row: 30 s, doubling, at most 30 min (Burrow's numbers). */
export function backoffDelay(failures: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}
