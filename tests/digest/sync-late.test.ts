// The Daily on a SECOND device before Obsidian Sync has delivered the first device's key (dev49/dev58 report). In memory, two devices, data.json only.
process.env.TZ = "Europe/Berlin";
import { describe, expect, it } from "vitest";
import { keyOf } from "../../src/digest/sync/dataKey";
import { DataJson, T0, device, provider, world } from "./sync-harness";

const setup = () => {
  const prov = provider();
  const da = new DataJson();
  const db = new DataJson();
  const a = device("devAaaa", "x", prov, T0, { data: da });
  const b = device("devBbbb", "x", prov, T0 + 3_600_000, { data: db, hold: true });
  return { prov, da, db, a, b };
};

describe("a foreign key that arrives after this device opened the Daily", () => {
  it("the second device holds, makes nothing, and adopts A's edition when its key arrives", async () => {
    const { a, b, da, db } = setup();
    const w = world();
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    const ib = await b.editions.open(w.items); // Sync has not delivered A's key yet
    expect(ib.checking).toBe(true); // held: nothing is made or written
    expect(Object.keys(db.json).filter((k) => k.startsWith("digestSync_"))).toEqual([]);
    expect(b.sync.holding()).toBe(true);
    db.arrive(da, "devAaaa");
    const ib2 = await b.editions.open(w.items);
    expect(ib2.checking).toBeUndefined();
    expect(b.sync.info(ia.id).made?.device).toBe("devAaaa");
    expect(ib2.grouped.clusters.map((c) => c.id)).toEqual(ia.grouped.clusters.map((c) => c.id));
    expect(Object.keys(db.json)).not.toContain(keyOf("devBbbb")); // nothing of its own was written over the foreign edition
  });
  it("fails open after the bound: the edition is made locally, and the late foreign key is joined in place", async () => {
    const { a, b, da, db } = setup();
    const w = world();
    const ia = await a.editions.open(w.items);
    const first = await b.editions.open(w.items);
    expect(first.checking).toBe(true);
    b.setNow(T0 + 3_600_000 + 9_000);
    const second = await b.editions.open(w.items);
    expect(second.checking).toBeUndefined();
    expect(b.sync.holding()).toBe(false);
    expect(db.json[keyOf("devBbbb")]).toBeDefined();
    db.arrive(da, "devAaaa");
    const third = await b.editions.open(w.items);
    expect(third.id).toBe(ia.id);
    expect(b.sync.info(ia.id).others).toBe(1);
    expect(b.sync.info(ia.id).made?.device).toBe("devAaaa"); // the earlier creator wins
  });
  it("a device alone with its history is never held (a single-device user waits for nothing)", async () => {
    const prov = provider();
    const da = new DataJson();
    const a = device("devAaaa", "x", prov, T0, { data: da, hold: true });
    const w = world();
    expect((await a.editions.open(w.items)).checking).toBe(true); // first ever: held once, then made after the bound
    a.setNow(T0 + 9_000);
    expect((await a.editions.open(w.items)).checking).toBeUndefined();
    a.setNow(T0 + 24 * 3_600_000);
    const next = await a.editions.open(w.items);
    expect(next.checking).toBeUndefined();
  });
  it("an unreadable data.json holds, bounded", async () => {
    const { b, db } = setup();
    db.text = "{ not json";
    expect((await b.editions.open(world().items)).checking).toBe(true);
    b.setNow(T0 + 3_600_000 + 9_000);
    expect((await b.editions.open(world().items)).checking).toBeUndefined();
  });
  it("without data.json transport nothing is held", async () => {
    const prov = provider();
    const a = device("devAaaa", "x", prov, T0, { hold: true });
    expect((await a.editions.open(world().items)).checking).toBeUndefined();
  });
});
