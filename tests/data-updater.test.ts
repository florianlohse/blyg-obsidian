import { describe, expect, it } from "vitest";
import { createDataUpdater } from "../src/app/dataUpdater";
import { createPublishedStore, foldOldFile, isOwnFormat, mergeRecords, parseRecords } from "../src/app/publishedStore";

/** A data.json on a fake disk. `onLoad` lets a test change the disk behind the plugin's back (Obsidian Sync arriving). */
function fakeDisk(initial: unknown = null) {
  const disk = { data: initial, loads: 0, saves: 0, onLoad: null as null | (() => void) };
  const io = {
    load: () => {
      disk.loads++;
      disk.onLoad?.();
      return Promise.resolve(structuredClone(disk.data));
    },
    save: (d: Record<string, unknown>) => {
      disk.saves++;
      disk.data = structuredClone(d);
      return Promise.resolve();
    },
  };
  return { disk, io };
}

const rec = (hash: string, at: string) => ({ hash, at });
const published = (records: Record<string, Record<string, { hash: string; at: string }>>) => ({ version: 1, records });

describe("data.json updater", () => {
  it("saving settings keeps the published records that are on disk", async () => {
    const { disk, io } = fakeDisk({ schemaVersion: 1, github: { owner: "old" }, published: published({ main: { "a.md": rec("h", "t") } }) });
    const update = createDataUpdater(io, () => false);
    const inMemorySettings = { schemaVersion: 1, github: { owner: "new" } }; // what the session holds: no records
    await update((data) => void Object.assign(data, inMemorySettings));
    expect(disk.data).toMatchObject({ github: { owner: "new" }, published: published({ main: { "a.md": rec("h", "t") } }) });
  });

  it("a record that Sync brought in after the session started is not erased by the next settings save", async () => {
    const { disk, io } = fakeDisk({ schemaVersion: 1, github: { owner: "o" } });
    const update = createDataUpdater(io, () => false);
    disk.onLoad = () => {
      // The other device's records arrive just before our read.
      disk.data = { schemaVersion: 1, github: { owner: "o" }, published: published({ main: { "from-other-device.md": rec("h", "t") } }) };
      disk.onLoad = null;
    };
    await update((data) => void Object.assign(data, { schemaVersion: 1, github: { owner: "o2" } }));
    expect(parseRecords(JSON.stringify((disk.data as { published: unknown }).published))).toEqual({ main: { "from-other-device.md": rec("h", "t") } });
  });

  it("writing a record keeps the settings", async () => {
    const { disk, io } = fakeDisk({ schemaVersion: 1, github: { owner: "o" }, routes: [{ vaultPrefix: "a/" }] });
    const update = createDataUpdater(io, () => false);
    const store = createPublishedStore({
      read: async () => {
        const d = (await io.load()) as { published?: unknown };
        return d.published === undefined ? null : JSON.stringify(d.published);
      },
      write: (text) => update((d) => void (d.published = JSON.parse(text) as unknown)),
    });
    await store.set("main", "x.md", rec("h", "t"));
    expect(disk.data).toMatchObject({ github: { owner: "o" }, routes: [{ vaultPrefix: "a/" }], published: published({ main: { "x.md": rec("h", "t") } }) });
  });

  it("a settings save and a record write started together both land", async () => {
    const { disk, io } = fakeDisk({ schemaVersion: 1, github: { owner: "o" } });
    const update = createDataUpdater(io, () => false);
    await Promise.all([
      update((d) => void Object.assign(d, { github: { owner: "changed" } })),
      update((d) => void (d.published = published({ main: { "y.md": rec("h", "t") } }))),
    ]);
    expect(disk.data).toMatchObject({ github: { owner: "changed" }, published: published({ main: { "y.md": rec("h", "t") } }) });
  });

  it("writes nothing while the settings belong to a newer plugin version", async () => {
    const { disk, io } = fakeDisk({ schemaVersion: 99 });
    const update = createDataUpdater(io, () => true);
    await expect(update((d) => void (d.x = 1))).rejects.toThrow(/newer plugin version/);
    expect(disk.saves).toBe(0);
  });

  it("a failed write does not block the next one", async () => {
    const { disk, io } = fakeDisk({});
    let fail = true;
    const update = createDataUpdater({ load: io.load, save: (d) => (fail ? Promise.reject(new Error("disk full")) : io.save(d)) }, () => false);
    await expect(update((d) => void (d.a = 1))).rejects.toThrow("disk full");
    fail = false;
    await update((d) => void (d.b = 2));
    expect(disk.data).toEqual({ b: 2 });
  });

  it("an empty or odd data.json is treated as an empty object", async () => {
    for (const odd of [null, undefined, "text", 5, []]) {
      const { disk, io } = fakeDisk(odd);
      await createDataUpdater(io, () => false)((d) => void (d.k = 1));
      expect(disk.data).toEqual({ k: 1 });
    }
  });
});

describe("folding the old published.json into data.json", () => {
  const old = JSON.stringify(published({ main: { "a.md": rec("old", "2026-10-07T10:00:00.000Z"), "b.md": rec("b", "2026-10-07T10:00:00.000Z") }, preview: { "a.md": rec("p", "2026-10-07T10:00:00.000Z") } }));

  it("an empty data.json simply takes the old records", () => {
    expect(foldOldFile(undefined, old).records).toEqual(parseRecords(old));
    expect(foldOldFile(undefined, old).version).toBe(1);
  });

  it("per branch and path the newer record wins, and neither side loses the rest", () => {
    const current = published({ main: { "a.md": rec("new", "2026-10-08T10:00:00.000Z"), "c.md": rec("c", "2026-10-08T10:00:00.000Z") } });
    const folded = foldOldFile(current, old).records;
    expect(folded.main?.["a.md"]?.hash).toBe("new");
    expect(folded.main?.["b.md"]?.hash).toBe("b");
    expect(folded.main?.["c.md"]?.hash).toBe("c");
    expect(folded.preview?.["a.md"]?.hash).toBe("p");
  });

  it("an older record in data.json loses to the file's newer one", () => {
    const current = published({ main: { "a.md": rec("stale", "2026-10-01T10:00:00.000Z") } });
    expect(foldOldFile(current, old).records.main?.["a.md"]?.hash).toBe("old");
  });

  it("mergeRecords keeps a record whose time cannot be read rather than dropping data", () => {
    const merged = mergeRecords({ main: { "a.md": rec("x", "not a date") } }, { main: { "a.md": rec("y", "2026-10-07T10:00:00.000Z") } });
    expect(merged.main?.["a.md"]?.hash).toBe("y");
  });

  it("only text in the plugin's own format may be deleted after folding", () => {
    expect(isOwnFormat(old)).toBe(true);
    expect(isOwnFormat("garbage")).toBe(false);
    expect(isOwnFormat('{"version":2,"records":{}}')).toBe(false);
    expect(isOwnFormat("[]")).toBe(false);
  });
});
