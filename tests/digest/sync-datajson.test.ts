// The Daily's second transport (DG20): each device's editions in its own top-level key of data.json. In memory: each device has its own data.json (a fake disk) and its own digest folder,
// and the two meet only through `arrive` (what Obsidian Sync would do to the file). The hazard under test: a write of data.json must never drop another device's key.
process.env.TZ = "Europe/Berlin";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDataUpdater } from "../../src/app/dataUpdater";
import { KEY_EDITIONS, MAX_KEY_BYTES, buildPayload, keepForeign, keyOf, readKeys } from "../../src/digest/sync/dataKey";
import { dataPort } from "../../src/digest/sync/dataPort";
import { checkLines } from "../../src/digest/sync/line";
import { emptyState, setReg, type EdState } from "../../src/digest/sync/state";
import { DataJson, T0, device, mkPost, provider, world } from "./sync-harness";

const DAY = 24 * 3600_000;

/** A device that has no folder files shared with the other (the folder transport is not used): only data.json carries. */
const pair = () => {
  const prov = provider();
  const da = new DataJson();
  const db = new DataJson();
  const a = device("devAaaa", "iPhone", prov, T0, { data: da });
  const b = device("devBbbb", "iPad", prov, T0 + 3600_000, { data: db });
  return { prov, da, db, a, b };
};

describe("the key", () => {
  it("is named per device, holds the newest three editions, and carries no secret", async () => {
    const { a, da } = pair();
    const w = world();
    await a.editions.open(w.items);
    const keys = Object.keys(da.json).filter((k) => k.startsWith("digestSync_"));
    expect(keys).toEqual([keyOf("devAaaa")]);
    expect(JSON.stringify(da.json)).not.toMatch(/sk-|token|secret|Bearer/i);
    expect(JSON.stringify(da.json[keyOf("devAaaa")])).not.toMatch(/Secret\d notes/); // no post body
  });
  it("is pruned to the newest three editions, by this device only", () => {
    const states: EdState[] = [1, 2, 3, 4, 5].map((i) => emptyState(i * DAY, "devAaaa", "iPhone", i));
    const built = buildPayload(states, "devAaaa", "iPhone");
    expect(built?.payload.editions.map((e) => e.id)).toEqual([5, 4, 3].map((i) => i * DAY));
    expect(built?.payload.editions.length).toBe(KEY_EDITIONS);
    expect(buildPayload([emptyState(1, "devBbbb", "x", 1)], "devAaaa", "iPhone")).toBeNull(); // states of other devices are never put in this device's key
  });
  it("keeps its size under the cap: old editions are thinned first, the newest stays whole", () => {
    const big = (id: number): EdState => {
      const s = emptyState(id, "devAaaa", "iPhone", id);
      for (let i = 0; i < 600; i++) setReg(s, `ai/k${id}-${i}`, { headline: "h".repeat(40), summary: "s".repeat(120), at: 1, posts: 2 }, i + 1);
      return s;
    };
    const eds = [big(1), big(2), big(3)];
    const built = buildPayload(eds, "devAaaa", "iPhone");
    expect(built).not.toBeNull();
    expect(built?.bytes).toBeLessThanOrEqual(MAX_KEY_BYTES);
    expect(built?.payload.editions[0]?.id).toBe(3);
    expect(Object.keys(built?.payload.editions[0]?.regs ?? {}).length).toBe(600); // the newest is whole
    const huge = emptyState(9, "devAaaa", "iPhone", 9);
    for (let i = 0; i < 20_000; i++) setReg(huge, `ai/k${i}`, { headline: "h".repeat(40), summary: "s".repeat(120), at: 1, posts: 2 }, i + 1);
    expect(buildPayload([huge], "devAaaa", "iPhone")).toBeNull(); // too big alone: not written
  });
});

describe("the hazard: no write of data.json drops another device's key", () => {
  const foreignKey = { v: 1, device: "devBbbb", label: "iPad", at: 5, editions: [] };
  it("the updater puts a foreign key back exactly as found, even when the change removes or edits it", async () => {
    let disk: Record<string, unknown> = { a: 1, [keyOf("devBbbb")]: foreignKey, [keyOf("devAaaa")]: { v: 1, device: "devAaaa", editions: [] } };
    const up = createDataUpdater({ load: async () => structuredClone(disk), save: async (d) => void (disk = structuredClone(d)) }, () => false);
    await up((d) => void (d.a = 2)); // the settings save
    await up((d) => void (delete d[keyOf("devBbbb")])); // a careless change
    await up((d) => void (d[keyOf("devBbbb")] = { evil: true }), { own: keyOf("devAaaa") }); // a change that names only its own key
    await up((d) => void (d[keyOf("devAaaa")] = { v: 1, device: "devAaaa", editions: [], mine: true }), { own: keyOf("devAaaa") });
    expect(disk[keyOf("devBbbb")]).toEqual(foreignKey);
    expect(disk[keyOf("devAaaa")]).toMatchObject({ mine: true }); // the own key can change
    expect(disk.a).toBe(2);
  });
  it("a foreign key that arrived on disk after the plugin loaded survives a settings save and an own write", async () => {
    const { a, da, db, b } = pair();
    const w = world();
    await b.editions.open(w.items);
    await a.editions.open(w.items);
    da.arrive(db, "devBbbb"); // Sync brings B's key while A runs; A's memory has never seen it
    await da.saveSettings({ github: { owner: "changed" } });
    expect(da.json[keyOf("devBbbb")]).toEqual(db.json[keyOf("devBbbb")]);
    expect(da.json.github).toEqual({ owner: "changed" });
    const writes = da.writes;
    a.setNow(T0 + 1000);
    await a.editions.open([...w.items, mkPost("A new remark arrives later.", { at: T0 + 500 })]); // the edition changes: A writes its own key again
    expect(da.writes).toBeGreaterThan(writes);
    expect(a.sync.ownKeyBytes()).toBeGreaterThan(0);
    expect(da.json[keyOf("devBbbb")]).toEqual(db.json[keyOf("devBbbb")]); // still there, as Sync brought it
  });
  it("keepForeign: pure, restores every foreign key, leaves the own key to the caller", () => {
    const disk = { x: 1, [keyOf("d1")]: { a: 1 }, [keyOf("d2")]: { a: 2 } };
    expect(keepForeign(disk, { x: 2 }, keyOf("d1"))).toEqual({ x: 2, [keyOf("d2")]: { a: 2 } });
    expect(keepForeign(disk, { x: 2, [keyOf("d1")]: { a: 9 } }, keyOf("d1"))).toEqual({ x: 2, [keyOf("d1")]: { a: 9 }, [keyOf("d2")]: { a: 2 } });
  });
  it("invalid JSON on disk (mid-write): nothing is written, the read says unknown, a later write succeeds", async () => {
    const { a, da } = pair();
    const w = world();
    da.text = '{"schemaVersion":1,"digestSync_devBbbb":{"v":1,"dev'; // cut off
    const before = da.text;
    await expect(da.saveSettings()).rejects.toThrow();
    await a.editions.open(w.items); // the Daily still works; its key is not written now
    expect(da.text).toBe(before);
    expect(await da.port().read()).toBeNull();
    da.text = JSON.stringify({ schemaVersion: 1, [keyOf("devBbbb")]: foreignKey }); // the file is whole again
    await a.sync.refresh(); // retried at the next read
    expect(da.json[keyOf("devAaaa")]).toBeDefined();
    expect(da.json[keyOf("devBbbb")]).toEqual(foreignKey);
  });
  it("the shared token ceiling fails closed while data.json cannot be read", async () => {
    const { a, da } = pair();
    await a.editions.open(world().items);
    expect(await a.sync.usedToday(T0)).not.toBeNull();
    da.text = "{ not json";
    expect(await a.sync.usedToday(T0)).toBeNull();
  });
  it("no source file calls saveData except the one updater, and the digest never writes data.json by another path", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));
    const hits = walk("src").flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((l, i) => (!l.trim().startsWith("//") && /\bsaveData\s*\(|\.saveData\b/.test(l) ? [`${f}:${i + 1}`] : [])));
    expect(hits).toEqual([expect.stringMatching(/^src\/main\.ts:\d+$/)]); // the updater's io.save in main.ts (a comment mentioning it does not count)
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toMatch(/createDataUpdater\(\s*\{ load: \(\) => this\.loadData\(\) as Promise<unknown>, save: \(data\) => this\.saveData\(data\) \}/);
    const adopt = main.slice(main.indexOf("adoptOldInstall({"), main.indexOf("adoptOldInstall({") + 500);
    expect(adopt).not.toMatch(/saveData/); // the adoption goes through the updater too
  });
});

describe("two devices through data.json only", () => {
  it("A makes the edition and writes; B reads data.json from disk and shows the same edition; the join is equal both ways", async () => {
    const { prov, a, b, da, db } = pair();
    const w = world();
    const ia = await a.editions.open(w.items);
    expect((await a.write(ia.grouped.clusters, ia.grouped.mixed)).status).toBe("ok");
    expect(prov.requests.length).toBe(2);
    expect(await b.sync.devicesSeen().then((d) => d.length)).toBe(1); // nothing yet
    db.arrive(da, "devAaaa");
    const ib = await b.editions.open(w.items);
    expect(ib.id).toBe(ia.id);
    expect(b.sync.info(ia.id).made?.label).toBe("iPhone");
    expect(b.sync.info(ia.id).others).toBe(1);
    expect((await b.write(ib.grouped.clusters, ib.grouped.mixed)).status).toBe("ok");
    expect(prov.requests.length).toBe(2); // the texts came through data.json: reused
    da.arrive(db, "devBbbb");
    await a.sync.refresh();
    expect(await b.editions.current()).toEqual(await a.editions.current());
    const seen = await b.sync.devicesSeen();
    expect(seen.map((d) => [d.label, d.mine, d.via])).toEqual([["iPad", true, ["folder", "settings"]], ["iPhone", false, ["settings"]]]);
    const lines = checkLines(seen, b.sync.ownKeyBytes());
    expect(lines.join("\n")).toMatch(/iPhone · via settings file/);
    expect(lines.join("\n")).toMatch(/This device's key in the settings file: \d+\.\d KB/);
    expect(lines.join("\n")).not.toMatch(/No other device/);
  });
  it("seeing an edition both ways (folder and data.json) is harmless: the join is idempotent", async () => {
    const { a, b, da, db } = pair();
    const w = world();
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    db.arrive(da, "devAaaa");
    for (const [path, f] of a.disk.files) b.disk.put(path, f.text); // the folder carries it too
    const ib = await b.editions.open(w.items);
    expect(ib.id).toBe(ia.id);
    expect(ib.grouped.clusters.map((c) => c.id)).toEqual(ia.grouped.clusters.map((c) => c.id));
    expect((await b.sync.devicesSeen()).find((d) => !d.mine)?.via.sort()).toEqual(["folder", "settings"]);
    expect(b.disk.files.has(`plugin/digest/ed-${ia.id}.devBbbb.json`)).toBe(false); // adopted, no second edition record
  });
  it("a device's own key is pruned only by that device: a foreign key with five editions stays whole", async () => {
    const { a, da } = pair();
    const old = Array.from({ length: 5 }, (_, i) => emptyState((i + 1) * DAY, "devBbbb", "iPad", i + 1));
    const foreign = { v: 1, device: "devBbbb", label: "iPad", at: 9, editions: old };
    da.text = JSON.stringify({ [keyOf("devBbbb")]: foreign });
    const w = world();
    await a.editions.open(w.items);
    await da.saveSettings();
    expect(da.json[keyOf("devBbbb")]).toEqual(foreign);
    expect(readKeys(da.json).find((k) => k.device === "devAaaa")?.states.length).toBeLessThanOrEqual(KEY_EDITIONS);
  });
  it("an edition update reaches the other device through data.json (a changed story, a new post)", async () => {
    const { a, b, da, db } = pair();
    const w = world();
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    db.arrive(da, "devAaaa");
    await b.editions.open(w.items);
    a.setNow(T0 + 1000);
    const more = [...w.items, mkPost("A new remark arrives later in the morning.", { at: T0 + 500 })];
    await a.editions.open(more);
    da.arrive(da, "devAaaa");
    db.arrive(da, "devAaaa");
    const ib = await b.editions.open(more);
    const ia2 = await a.editions.open(more);
    expect(ib.grouped.mixed.map((p) => p.remoteId).sort()).toEqual(ia2.grouped.mixed.map((p) => p.remoteId).sort());
  });
  it("this device's own key is read back after a restart (own states from data.json)", async () => {
    const prov = provider();
    const da = new DataJson();
    const a = device("devAaaa", "iPhone", prov, T0, { data: da });
    const w = world();
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    const restarted = device("devAaaa", "iPhone", prov, T0 + 100, { data: da }); // same data.json, empty folder
    expect((await restarted.editions.open(w.items)).id).toBe(ia.id);
    expect(prov.requests.length).toBe(2);
  });
});

describe("the size of the key", () => {
  it("a 120-post edition stays well under the cap (the numbers are printed for the report)", async () => {
    const prov = provider();
    const da = new DataJson();
    const a = device("devAaaa", "iPhone", prov, T0, { data: da });
    const items = Array.from({ length: 120 }, (_, i) => mkPost(`Post ${i} about subject number ${i % 30} with enough words to be one.`, { at: T0 - 3_600_000 - i * 1000 }));
    const ia = await a.editions.open(items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    const bytes = JSON.stringify(da.json[keyOf("devAaaa")]).length;
    process.stderr.write(`120 posts: ${ia.grouped.clusters.length} stories, own key ${bytes} bytes (1 edition)\n`);
    expect(bytes).toBeLessThan(MAX_KEY_BYTES);
    expect(a.sync.ownKeyBytes()).toBe(bytes);
  });
  it("dataPort: absent file is {}, damaged is null", async () => {
    expect(await dataPort({ load: async () => null, update: async () => undefined }).read()).toEqual({});
    expect(await dataPort({ load: async () => [1], update: async () => undefined }).read()).toBeNull();
    expect(await dataPort({ load: async () => Promise.reject(new Error("x")), update: async () => undefined }).read()).toBeNull();
  });
});
