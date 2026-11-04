// A draft the plugin created in the Studio for a note that is not stamped yet. The note changes only after the Studio confirmed a
// publish (CLAUDE.md §3), so between "created" and "published" the only memory of the new item's id is here; without it, a publish
// that fails halfway (network, a refused cap) and is tried again would create a second item. Kept in data.json, keyed by the note's path.
import type { StudioItemKind } from "./types";

export interface PendingDraft {
  /** The Studio the draft lives in (its origin, as stamped into notes). */
  origin: string;
  id: string;
  kind: StudioItemKind;
  /** ISO time it was created: the oldest are dropped first when the record grows. */
  at: string;
}

export interface PendingDrafts {
  get(path: string): Promise<PendingDraft | null>;
  set(path: string, draft: PendingDraft): Promise<void>;
  clear(path: string): Promise<void>;
}

/** Entries kept; far more than anyone has half-published notes. */
export const MAX_PENDING = 100;

export function readPending(raw: unknown): Record<string, PendingDraft> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, PendingDraft> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.origin === "string" && typeof v.id === "string" && (v.kind === "fragment" || v.kind === "thread") && typeof v.at === "string") {
      out[path] = { origin: v.origin, id: v.id, kind: v.kind, at: v.at };
    }
  }
  return out;
}

/** The map with `path` set, and the oldest entries dropped beyond `MAX_PENDING`. */
export function withPending(map: Record<string, PendingDraft>, path: string, draft: PendingDraft): Record<string, PendingDraft> {
  const next = { ...map, [path]: draft };
  const entries = Object.entries(next);
  if (entries.length <= MAX_PENDING) return next;
  entries.sort((a, b) => a[1].at.localeCompare(b[1].at));
  return Object.fromEntries(entries.slice(entries.length - MAX_PENDING));
}

/** The store over `data.json`: `read` returns the stored value fresh from disk, `change` applies an edit to the whole file (see app/dataUpdater.ts). */
export function createPendingDrafts(io: { read(): Promise<unknown>; change(edit: (data: Record<string, unknown>) => void): Promise<void> }): PendingDrafts {
  return {
    async get(path) {
      return readPending(await io.read())[path] ?? null;
    },
    set: (path, draft) => io.change((data) => void (data.studioDrafts = withPending(readPending(data.studioDrafts), path, draft))),
    clear: (path) =>
      io.change((data) => {
        const map = readPending(data.studioDrafts);
        delete map[path];
        data.studioDrafts = map;
      }),
  };
}
