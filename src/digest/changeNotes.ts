// The change note of a revised post of a blyg the person reads (digest, Corrections). The reading rows carry only `version`; the note is read lazily from the
// Studio's `GET /imports/{sub}/{id}/history` (a read, no Studio write), once per (item, version), and kept in plugin storage (`digest-notes.json`), never in the vault.
// The text is a stranger's: plain text only (no markup is interpreted, the view uses textContent), control and direction marks removed, whitespace collapsed, capped.
import type { ReadingPost } from "../studio/reading";
import type { StudioResult } from "../studio/types";

export const NOTE_MAX_CHARS = 280;
export const NOTES_KEPT = 300;
export const NOTES_PER_DRAW = 10;
const FETCH_TIMEOUT_MS = 8000;

/** Control characters, zero-width and direction marks, and the byte-order mark: not text a person reads. */
const isHidden = (c: number): boolean => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;

/** A note as shown: one plain line, at most `NOTE_MAX_CHARS`; "" when nothing readable is left. */
export function cleanNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = Array.from(raw.slice(0, NOTE_MAX_CHARS * 4), (ch) => (isHidden(ch.codePointAt(0) ?? 0) ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS - 1).trimEnd()}…` : text;
}

export interface NoteDeps {
  fetch(subscriptionId: string, remoteId: string): Promise<StudioResult<{ notes: Array<{ version: number; note: string }> }>>;
  load(): Promise<unknown>;
  save(text: string): Promise<void>;
  timeoutMs?: number;
}

const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}@${p.version}`;

export class ChangeNotes {
  private known: Record<string, string> | null = null;
  private readonly asked = new Map<string, Promise<string>>();
  private readonly failed = new Set<string>();
  constructor(private readonly deps: NoteDeps) {}

  private async cache(): Promise<Record<string, string>> {
    if (this.known) return this.known;
    const out: Record<string, string> = {};
    try {
      const raw = await this.deps.load();
      const notes = typeof raw === "object" && raw !== null ? (raw as { notes?: unknown }).notes : null;
      if (typeof notes === "object" && notes !== null) for (const [k, v] of Object.entries(notes)) if (typeof v === "string") out[k] = cleanNote(v);
    } catch {
      /* an unreadable file is an empty cache */
    }
    return (this.known = out);
  }

  /** The note of this post's current version, or "" (none, or not reachable). A revised post only: version 1 has no note and asks nothing. At most one request per (item, version). */
  get(post: ReadingPost): Promise<string> {
    if (post.version <= 1 || post.withdrawn) return Promise.resolve("");
    const key = keyOf(post);
    const running = this.asked.get(key);
    if (running) return running;
    const run = this.fetchOnce(post, key).finally(() => this.asked.delete(key)); // in flight only: afterwards the cache or the failure memo answers
    this.asked.set(key, run);
    return run;
  }

  private async fetchOnce(post: ReadingPost, key: string): Promise<string> {
    const cache = await this.cache();
    if (key in cache) return cache[key] ?? "";
    if (this.failed.has(key)) return "";
    try {
      let timer: number | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("timeout")), this.deps.timeoutMs ?? FETCH_TIMEOUT_MS);
      });
      const res = await Promise.race([this.deps.fetch(post.subscriptionId, post.remoteId), timeout]).finally(() => window.clearTimeout(timer));
      if (res.kind !== "ok") {
        if (!("status" in res) || res.status !== 0) this.failed.add(key); // status 0: no Studio set up yet, nothing was asked, so a later draw may try
        return "";
      }
      const note = cleanNote(res.value.notes.find((n) => n.version === post.version)?.note);
      cache[key] = note; // "" is kept too: the item has no note for this version, so it is not asked again
      const keys = Object.keys(cache);
      for (const old of keys.slice(0, Math.max(0, keys.length - NOTES_KEPT))) delete cache[old];
      await this.deps.save(JSON.stringify({ v: 1, notes: cache })).catch(() => undefined);
      return note;
    } catch {
      this.failed.add(key); // not stored: asked again in a later session, not again in this one
      return "";
    }
  }
}
