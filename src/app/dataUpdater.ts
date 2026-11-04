// Changes to the plugin's settings file (data.json), one at a time, each read fresh from disk and written back whole.
//
// Two things share that file: the settings (saved by the settings screen) and the published records (written after a publish, and
// brought in by Obsidian Sync from other devices). The settings object lives in memory for the whole session, so saving it by
// itself would erase records that arrived meanwhile; saving a record by itself would erase settings changed meanwhile. Every
// writer therefore goes through here: load what is on disk now, apply its change to that, write.
export interface DataIo {
  load(): Promise<unknown>;
  save(data: Record<string, unknown>): Promise<void>;
}

export function createDataUpdater(io: DataIo, isLocked: () => boolean): (change: (data: Record<string, unknown>) => void) => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  return (change) => {
    const run = async (): Promise<void> => {
      // Data written by a newer plugin version must not be rewritten by an older one.
      if (isLocked()) throw new Error("the settings were written by a newer plugin version; not writing");
      const disk = await io.load();
      const data: Record<string, unknown> = typeof disk === "object" && disk !== null && !Array.isArray(disk) ? { ...(disk as Record<string, unknown>) } : {};
      change(data);
      await io.save(data);
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
}
