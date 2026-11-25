// The Daily sync's access to data.json (DG20). `io` is the plugin's loadData and its read-modify-write updater (src/app/dataUpdater.ts), so a write here re-reads the file first and keeps
// every other device's key. A file that cannot be read or parsed gives null (fail closed: nothing is written, the caller tries again later).
export interface DataPort {
  /** data.json as it is on disk now; {} when there is none; null when it cannot be read or is not a JSON object (mid-write, damaged). */
  read(): Promise<Record<string, unknown> | null>;
  /** Replace this device's own top-level key (and nothing else). Rejects when data.json could not be read or written. */
  writeOwn(key: string, value: unknown): Promise<void>;
}

export interface DataIo {
  load(): Promise<unknown>;
  update(change: (data: Record<string, unknown>) => void, opts: { own: string }): Promise<void>;
}

export function dataPort(io: DataIo): DataPort {
  return {
    read: async () => {
      try {
        const d = await io.load();
        if (d === null || d === undefined) return {};
        return typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    writeOwn: (key, value) => io.update((data) => void (data[key] = value), { own: key }),
  };
}
