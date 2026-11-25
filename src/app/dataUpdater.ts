// Changes to the plugin's settings file (data.json), one at a time, each read fresh from disk and written back whole.
//
// Three things share that file: the settings (saved by the settings screen), the published records (written after a publish, and
// brought in by Obsidian Sync from other devices) and the Daily's per-device sync keys `digestSync_<device>` (src/digest/sync/dataKey.ts).
// The settings object lives in memory for the whole session, so saving it by itself would erase records that arrived meanwhile; saving a
// record by itself would erase settings changed meanwhile. Every writer therefore goes through here: load what is on disk now, apply its
// change to that, write. This is the ONLY caller of the plugin's saveData (tests/app/dataUpdater.test.ts scans src/ for it).
//   - A sync key of another device is put back exactly as it was read, whatever the change did to it. Only the key named in `opts.own` may change.
//   - A file that cannot be read or parsed (loadData throws) is not written (fail closed); the caller retries later.
import { keepForeign } from "../digest/sync/dataKey";

export interface DataIo {
  load(): Promise<unknown>;
  save(data: Record<string, unknown>): Promise<void>;
}

export function createDataUpdater(io: DataIo, isLocked: () => boolean): (change: (data: Record<string, unknown>) => void, opts?: { own?: string }) => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  return (change, opts) => {
    const run = async (): Promise<void> => {
      // Data written by a newer plugin version must not be rewritten by an older one.
      if (isLocked()) throw new Error("the settings were written by a newer plugin version; not writing");
      const disk = await io.load(); // throws on a damaged file: nothing is written
      // Not an object (empty file, a bare value): nothing in it to keep, as before.
      const before: Record<string, unknown> = typeof disk === "object" && disk !== null && !Array.isArray(disk) ? (disk as Record<string, unknown>) : {};
      const data: Record<string, unknown> = { ...before };
      change(data);
      await io.save(keepForeign(before, data, opts?.own ?? null));
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
}
