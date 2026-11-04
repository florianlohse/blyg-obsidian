// The plugin's own record of what it last published for plain routes (essays, pages), per branch and repo path.
//
// Why it exists: a Blyg note carries its own stamp (`blyg_hash`), but an essay is copied byte for byte, so a stamp inside it would
// change the published file. The record lives in the plugin's settings file (`data.json`, under the key `published`) instead; the
// note is never touched. It is this device's knowledge (plus whatever Obsidian Sync brings from other devices): the publish itself
// always reads the repo first.
//
// Why `data.json` and not a file of its own: Obsidian Sync carries a plugin's standard files (`data.json`, `main.js`, `manifest.json`,
// `styles.css`) but not other files in the plugin folder. Measured on Florian's iPhone and iPad, 2026-10-09: `published.json` and three
// probe files (.json, .txt, .md) written on one device never arrived on the other, while `data.json` and the plugin code did.
//
// Format of the value: { "version": 1, "records": { "<branch>": { "<repo path>": { "hash": "sha256:…", "at": "<ISO time>" } } } }.
// It holds paths and fingerprints, never text and never the token. Nothing here knows about Obsidian: the plugin supplies the I/O.
import type { Clock } from "../platform/ports";
import { plainSyncHash } from "../core/plain";

export interface PublishedRecord {
  /** `plainSyncHash` of the text that was committed (or found already committed). */
  hash: string;
  /** When the plugin last saw the repo hold that text. */
  at: string;
}

export interface PublishedStore {
  get(branch: string, path: string): Promise<PublishedRecord | null>;
  set(branch: string, path: string, record: PublishedRecord): Promise<void>;
}

/** Where the value lives (the `published` key of `data.json`); supplied by the plugin or a test. `read` returns null when there is none. */
export interface PublishedFileIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export type Records = Record<string, Record<string, PublishedRecord>>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whatever is in the file, as records. A missing, damaged or newer-format file reads as empty: the panel then says "not known", never wrong. */
export function parseRecords(text: string | null): Records {
  if (text === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.records)) return {};
  const out: Records = {};
  for (const [branch, paths] of Object.entries(raw.records)) {
    if (!isObject(paths)) continue;
    for (const [path, rec] of Object.entries(paths)) {
      if (isObject(rec) && typeof rec.hash === "string" && typeof rec.at === "string") {
        (out[branch] ??= {})[path] = { hash: rec.hash, at: rec.at };
      }
    }
  }
  return out;
}

/** True when `text` is valid JSON in this module's own format (so it is safe to treat an empty result as "nothing in it"). */
export function isOwnFormat(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text);
    return isObject(raw) && raw.version === 1 && isObject(raw.records);
  } catch {
    return false;
  }
}

/** Both sets of records, the newer `at` winning per branch and path. */
export function mergeRecords(base: Records, extra: Records): Records {
  const out: Records = {};
  for (const source of [base, extra]) {
    for (const [branch, paths] of Object.entries(source)) {
      for (const [path, rec] of Object.entries(paths)) {
        const have = out[branch]?.[path];
        if (!have || Date.parse(rec.at) > Date.parse(have.at) || Number.isNaN(Date.parse(have.at))) (out[branch] ??= {})[path] = rec;
      }
    }
  }
  return out;
}

/**
 * The value to store after folding an old `published.json` (text) into what `data.json` already holds (`current`, any JSON value).
 * Used once, at startup, by the migration; the old file is deleted only afterwards and only when `isOwnFormat`.
 */
export function foldOldFile(current: unknown, oldFileText: string): { version: 1; records: Records } {
  const have = parseRecords(JSON.stringify(current ?? null));
  return { version: 1, records: mergeRecords(have, parseRecords(oldFileText)) };
}

export function createPublishedStore(io: PublishedFileIo): PublishedStore {
  // One write at a time: two quick publishes must not read the same old file and drop each other's record.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    // Read from the file every time (it is tiny): a record that Obsidian Sync brought from another device shows without a restart.
    get: async (branch, path) => parseRecords(await io.read())[branch]?.[path] ?? null,
    set: (branch, path, record) => {
      const run = async (): Promise<void> => {
        const records = parseRecords(await io.read());
        (records[branch] ??= {})[path] = record;
        await io.write(JSON.stringify({ version: 1, records }, null, 2));
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** The publish services' view of the store: "this text is on the branch now". */
export function createPublishedRecorder(
  store: PublishedStore,
  clock: Clock,
): (branch: string, path: string, text: string) => Promise<void> {
  return async (branch, path, text) => store.set(branch, path, { hash: await plainSyncHash(text), at: clock.now().toISOString() });
}
