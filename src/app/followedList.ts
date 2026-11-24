// The "Sources" list (the blygs the Studio follows) kept between openings: the last answer of `GET /subscriptions` is shown at once and one read per opening
// of the screen brings it up to date behind it (no polling, no retry, nothing while the screen is closed). Pure: no DOM, no Obsidian; the file is read and
// written by a `FollowedStore` that the plugin hands in. Strangers' words (blyg titles) are kept only in that store (the plugin's own folder, never a note),
// are capped, and nothing read back is trusted: every field is checked and rebuilt.
import type { StudioClient } from "../studio/client";
import type { StudioFollowed } from "../studio/subscriptions";
import { loadFollowed } from "./followFlow";

export const FOLLOWED_ROWS = 200;
const TITLE_MAX = 200;
const URL_MAX = 500;

export interface FollowedCache {
  subscriptions: StudioFollowed[];
  complete: boolean;
  savedAt: number;
}

/** Where the list is kept. `read` is for the Studio the list came from only; `write` never throws. */
export interface FollowedStore {
  read(): Promise<FollowedCache | null>;
  write(subscriptions: StudioFollowed[], complete: boolean): void;
}

export interface FollowedCacheFile {
  v: 1;
  origin: string;
  savedAt: number;
  complete: boolean;
  subscriptions: StudioFollowed[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cap = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

function rowOf(v: unknown): StudioFollowed | null {
  if (!isRecord(v)) return null;
  const id = cap(v.id, URL_MAX);
  const origin = cap(v.origin, URL_MAX);
  if (!id || origin === null) return null;
  const status = v.status === "paused" || v.status === "degraded" ? v.status : "active";
  const poll = cap(v.lastPollAt, 40);
  return {
    id,
    kind: v.kind === "rss" ? "rss" : "blyg",
    origin,
    feedUrl: cap(v.feedUrl, URL_MAX) ?? "",
    title: cap(v.title, TITLE_MAX) ?? "",
    status,
    lastPollAt: poll === "" ? null : poll,
    failCount: typeof v.failCount === "number" && Number.isFinite(v.failCount) ? Math.max(0, Math.floor(v.failCount)) : 0,
    titleFollowsSource: v.titleFollowsSource !== false,
    hopperFeedUrl: cap(v.hopperFeedUrl, URL_MAX),
  };
}

export const followedCacheOf = (subs: StudioFollowed[], complete: boolean, origin: string, now: number): FollowedCacheFile => ({
  v: 1,
  origin,
  savedAt: now,
  complete,
  subscriptions: subs.slice(0, FOLLOWED_ROWS).map((s) => rowOf(s)).filter((s): s is StudioFollowed => s !== null),
});

/** The list from a saved file, or null when the file is not ours or belongs to another Studio. */
export function parseFollowedCache(raw: unknown, origin: string): FollowedCache | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.origin !== origin || typeof raw.savedAt !== "number" || !Array.isArray(raw.subscriptions)) return null;
  const subscriptions = raw.subscriptions.slice(0, FOLLOWED_ROWS).map(rowOf).filter((s): s is StudioFollowed => s !== null);
  return { subscriptions, complete: raw.complete !== false, savedAt: raw.savedAt };
}

/** What the line under the field says about how current the list is. */
export type Freshness =
  | { kind: "idle" }
  | { kind: "updating"; savedAt: number | null }
  | { kind: "updated"; at: number }
  | { kind: "failed"; savedAt: number | null; message: string };

type Op = (list: StudioFollowed[]) => StudioFollowed[];

export interface FollowedListDeps {
  store: FollowedStore;
  /** A Studio client for the settings as they are now, or why there is none. */
  build: () => { ok: true; studio: { client: StudioClient } } | { ok: false; message: string };
  now?: () => number;
  /** Called whenever the list or the freshness changed. */
  onChange: () => void;
}

/** The list of one opening of the screen: the cache first, then one read. */
export class FollowedList {
  subs: StudioFollowed[] | null = null;
  complete = true;
  fresh: Freshness = { kind: "idle" };
  private closed = false;
  private opened = false;
  private inflight = false;
  /** Changes made while the read was on its way: laid over its answer, so a follow or unfollow is not undone by an older list. */
  private meanwhile: Op[] = [];

  constructor(private readonly deps: FollowedListDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Show what was kept, then read once. Only the first call does anything: one read per opening. */
  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    let cached: FollowedCache | null = null;
    try {
      cached = await this.deps.store.read();
    } catch {
      cached = null;
    }
    if (this.closed) return;
    if (cached !== null) {
      this.subs = cached.subscriptions;
      this.complete = cached.complete;
    }
    this.fresh = { kind: "updating", savedAt: cached?.savedAt ?? null };
    this.deps.onChange();
    await this.refresh(cached?.savedAt ?? null);
  }

  private async refresh(savedAt: number | null): Promise<void> {
    const built = this.deps.build();
    if (!built.ok) return this.failed(savedAt, built.message);
    this.inflight = true;
    this.meanwhile = [];
    const got = await loadFollowed(built.studio.client);
    this.inflight = false;
    if (!got.ok) return this.failed(savedAt, got.message);
    let list = got.value.subscriptions.slice(0, FOLLOWED_ROWS);
    for (const op of this.meanwhile) list = op(list);
    this.meanwhile = [];
    this.subs = list;
    this.complete = got.value.complete;
    this.deps.store.write(list, this.complete);
    if (this.closed) return;
    this.fresh = { kind: "updated", at: this.now() };
    this.deps.onChange();
  }

  private failed(savedAt: number | null, message: string): void {
    if (this.closed) return;
    this.fresh = { kind: "failed", savedAt: this.subs !== null ? savedAt : null, message };
    this.deps.onChange();
  }

  /** The screen is closed: a late answer is still kept, but nothing is asked again. */
  close(): void {
    this.closed = true;
  }

  private change(op: Op): void {
    if (this.inflight) this.meanwhile.push(op);
    this.subs = op(this.subs ?? []);
    this.deps.store.write(this.subs, this.complete);
    if (!this.closed) this.deps.onChange();
  }

  /** A blyg was followed, or renamed: the Studio's answer replaces (or adds) its row. */
  upsert(sub: StudioFollowed): void {
    this.change((list) => (list.some((s) => s.id === sub.id) ? list.map((s) => (s.id === sub.id ? sub : s)) : [...list, sub]));
  }

  /** A blyg was unfollowed. */
  remove(id: string): void {
    this.change((list) => list.filter((s) => s.id !== id));
  }
}
