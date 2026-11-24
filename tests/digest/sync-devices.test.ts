// The Daily on two devices (DG16), in memory: each device has its own folder and its own files; they meet only through `ship`. One edition, the same story ids, the same texts,
// one AI request in total, updates that arrive later, a device away for a day, two devices that make the edition at the same time, files that arrive twice, partly or as copies.
process.env.TZ = "Europe/Berlin";
import { describe, expect, it } from "vitest";
import { cachedStories } from "../../src/digest/editionHost";
import { LOCK_TTL_MS } from "../../src/digest/sync/state";
import { defaultLabel, deviceId, deviceLabel, setDeviceLabel } from "../../src/digest/sync/device";
import { syncLines } from "../../src/digest/sync/line";
import { T0, device, mkPost, provider, ship, world, DIR } from "./sync-harness";

const DAY = 24 * 3600_000;
const ids = (g: { clusters: Array<{ id?: string; posts: Array<{ remoteId: string }> }> }): Record<string, string[]> => Object.fromEntries(g.clusters.map((c) => [c.id as string, c.posts.map((p) => p.remoteId).sort()]));

describe("one edition for all devices", () => {
  it("is made once on the device that opens first; the other adopts it, with the same story ids and the same texts, and one AI request in all", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const b = device("devB", "iPad", prov, T0 + 3600_000);
    const ia = await a.editions.open(w.items);
    const oa = await a.write(ia.grouped.clusters, ia.grouped.mixed);
    expect(oa.status).toBe("ok");
    expect(prov.requests.length).toBe(2); // the stories, then the sections: one write
    ship(a, b);
    const ib = await b.editions.open(w.items);
    expect(ib.id).toBe(ia.id);
    expect(ids(ib.grouped)).toEqual(ids(ia.grouped)); // the same story ids
    expect(b.disk.files.has(`${DIR}/ed-${ia.id}.devB.json`)).toBe(false); // nothing to add: no second edition record
    const ta = await cachedStories(a.llm, await a.editions.current(), ia.grouped.clusters);
    const tb = await cachedStories(b.llm, await b.editions.current(), ib.grouped.clusters);
    expect(tb.map((t) => t?.headline)).toEqual(ta.map((t) => t?.headline));
    expect(tb.every((t) => t !== null)).toBe(true);
    const ob = await b.write(ib.grouped.clusters, ib.grouped.mixed); // "Write the digest" on the second device
    expect(ob.status).toBe("ok");
    expect(prov.requests.length).toBe(2); // reused: no request
    expect((await b.history.list()).editions.map((e) => e.id)).toEqual((await a.history.list()).editions.map((e) => e.id));
    expect(await b.editions.current()).toEqual(await a.editions.current()); // the whole record: sections, bylines, lines, texts' keys, usage, creator
    expect((await b.history.list()).editions).toEqual((await a.history.list()).editions);
    expect(b.sync.info(ib.id)).toMatchObject({ made: { label: "iPhone", mine: false }, others: 1 });
    expect(a.sync.info(ia.id)).toMatchObject({ made: { label: "iPhone", mine: true } });
  });

  it("two devices that make the edition at the same time before any file arrives are one edition afterwards, with one creator", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const b = device("devB", "Mac", prov, T0 + 60_000);
    const ia = await a.editions.open(w.items);
    const ib = await b.editions.open(w.items); // neither has seen the other's file
    expect(ia.id).toBe(ib.id);
    ship(a, b);
    ship(b, a);
    const ra = await a.editions.open(w.items);
    const rb = await b.editions.open(w.items);
    expect(ids(ra.grouped)).toEqual(ids(rb.grouped));
    expect(ids(ra.grouped)).toEqual(ids(ia.grouped));
    expect((await a.editions.current())?.createdAt).toBe(T0);
    expect((await b.editions.current())?.createdAt).toBe(T0);
    expect(a.sync.info(ra.id).made?.device).toBe("devA");
    expect(b.sync.info(rb.id).made?.device).toBe("devA");
  });

  it("an update on one device (a new post joins a story, the story is written again) reaches the other the same way", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const b = device("devB", "iPad", prov, T0 + 3600_000);
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    ship(a, b);
    await b.editions.open(w.items);
    const reply = mkPost("Another answer entirely.", { isReply: true, stubTarget: { origin: "https://one.example.com/", id: w.leads[0]!.remoteId }, authorName: "Cy" });
    a.setNow(T0 + 5 * 3600_000);
    const ia2 = await a.editions.open([...w.items, reply]);
    const before = prov.requests.length;
    const o = await a.write(ia2.grouped.clusters, ia2.grouped.mixed);
    expect(o.status).toBe("ok");
    expect(prov.requests.length).toBe(before + 1); // only the updated story
    ship(a, b);
    b.setNow(T0 + 6 * 3600_000);
    const ib2 = await b.editions.open([...w.items, reply]);
    expect(ids(ib2.grouped)).toEqual(ids(ia2.grouped));
    const tb = await cachedStories(b.llm, await b.editions.current(), ib2.grouped.clusters);
    const ta = await cachedStories(a.llm, await a.editions.current(), ia2.grouped.clusters);
    expect(tb.map((t) => [t?.headline, t?.fresh])).toEqual(ta.map((t) => [t?.headline, t?.fresh]));
    expect(prov.requests.length).toBe(before + 1);
    // usage is added up once per device, not twice
    expect((await b.editions.current())?.usage?.tokens).toBe((await a.editions.current())?.usage?.tokens);
    expect(await b.editions.current()).toEqual(await a.editions.current());
  });

  it("a device that was away for a day finds the newer edition, its history and its texts; its own older edition is not lost", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const b = device("devB", "iPad", prov, T0);
    const i1 = await a.editions.open(w.items);
    await a.write(i1.grouped.clusters, i1.grouped.mixed);
    ship(a, b);
    await b.editions.open(w.items);
    a.setNow(T0 + DAY); // day two: only A is used
    const w2 = world();
    const i2 = await a.editions.open(w2.items.map((p) => ({ ...p, observedAt: new Date(T0 + DAY - 3600_000).toISOString() })));
    expect(i2.id).toBe(i1.id + DAY);
    await a.write(i2.grouped.clusters, i2.grouped.mixed);
    b.setNow(T0 + DAY + 3600_000);
    ship(a, b);
    const j2 = await b.editions.open(w2.items.map((p) => ({ ...p, observedAt: new Date(T0 + DAY - 3600_000).toISOString() })));
    expect(j2.id).toBe(i2.id);
    expect(ids(j2.grouped)).toEqual(ids(i2.grouped));
    expect((await b.history.list()).editions.map((e) => e.id)).toEqual([i2.id, i1.id]);
    expect(prov.requests.length).toBe(4);
  });

  it("does not write in parallel: a marker of the other device (younger than two minutes) makes the second wait; an old marker does not", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const b = device("devB", "iPad", prov, T0 + 30_000);
    const ia = await a.editions.open(w.items);
    await a.sync.setLock(ia.id, true);
    ship(a, b);
    const ib = await b.editions.open(w.items);
    const refused = await b.write(ib.grouped.clusters, ib.grouped.mixed);
    expect(refused.status).toBe("cancelled");
    expect(refused.note).toMatch(/iPhone is writing/);
    expect(prov.requests.length).toBe(0);
    b.setNow(T0 + 30_000 + LOCK_TTL_MS + 1);
    const ok = await b.write(ib.grouped.clusters, ib.grouped.mixed);
    expect(ok.status).toBe("ok");
    expect(prov.requests.length).toBe(2);
    // and the marker is cleared when a write ends
    ship(b, a);
    a.setNow(T0 + 30_000 + LOCK_TTL_MS + 5);
    await a.editions.open(w.items);
    expect(a.sync.lock(ia.id)).toBeNull();
  });

  it("files that arrive twice, late, in another order, partly written or as conflict copies change nothing", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const b = device("devB", "iPad", prov, T0 + 3600_000);
    const c = device("devC", "Mac", prov, T0 + 7200_000);
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    ship(a, b, { cut: 40 }); // arrives partly
    const waiting = await b.editions.open(w.items); // B makes its own edition record meanwhile; nothing breaks, nothing is blank
    expect(waiting.grouped.clusters.length).toBe(4);
    expect(b.sync.info(waiting.id).waiting).toBe(true);
    ship(a, b); // the whole file replaces the partial one
    ship(a, b, { names: (n) => n.replace(".json", " 2.json") }); // and a conflict copy of it
    ship(a, b, { names: (n) => n.replace(".json", ".sync-conflict-20300312.json") });
    ship(b, c);
    ship(a, c, { names: (n) => n.replace(".json", " (conflict).json") });
    const rb = await b.editions.open(w.items);
    const rc = await c.editions.open(w.items);
    expect(ids(rb.grouped)).toEqual(ids(ia.grouped));
    expect(ids(rc.grouped)).toEqual(ids(ia.grouped));
    expect(b.sync.info(rb.id).waiting).toBe(false);
    const wb = await cachedStories(b.llm, await b.editions.current(), rb.grouped.clusters);
    const wc = await cachedStories(c.llm, await c.editions.current(), rc.grouped.clusters);
    expect(wc.map((t) => t?.headline)).toEqual(wb.map((t) => t?.headline));
    expect(prov.requests.length).toBe(2);
  });

  it("migrates this device's old files without loss and leaves them in place", async () => {
    const prov = provider();
    const w = world();
    const old = device("devOld", "iPhone", prov, T0); // an older version made the old files; here only to get the legacy shapes
    const first = await old.editions.open(w.items);
    const legacyEditions = { v: 1, editions: [{ id: first.id, createdAt: T0, n: 3, stories: [{ id: "s1", posts: [w.leads[0]!.remoteId, w.items[1]!.remoteId], section: "One", textKey: "k1", textPosts: [w.leads[0]!.remoteId] }, { id: "s2", posts: [w.leads[1]!.remoteId, w.items[3]!.remoteId] }], mixed: [w.items[8]!.remoteId], seen: Object.fromEntries(w.items.map((p) => [p.remoteId, T0 + 1])), sections: ["One"], sectionAbout: { One: "Harbour news" }, usage: { tokens: 150, cost: 0.002 } }] };
    const legacyHistory = { v: 1, editions: [{ id: first.id - DAY, at: T0 - DAY, stories: [{ headline: "Yesterday", summary: "S.", posts: ["pA"] }], singles: [], sections: null, who: { pA: "Ann" } }] };
    const files = { ed: JSON.stringify(legacyEditions), hist: JSON.stringify(legacyHistory) };
    const d = device("devNew", "iPad", prov, T0 + 1000, { legacy: { editions: async () => JSON.parse(files.ed) as unknown, history: async () => JSON.parse(files.hist) as unknown, entries: async () => ({ k1: { headline: "Old text", summary: "Kept.", at: T0, posts: 2 } }) } });
    const info = await d.editions.open(w.items);
    expect(info.id).toBe(first.id);
    const rec = await d.editions.current();
    expect(rec?.createdAt).toBe(T0);
    expect(rec?.usage).toEqual({ tokens: 150, cost: 0.002 });
    expect(rec?.sectionAbout).toEqual({ One: "Harbour news" });
    expect(rec?.stories.find((s) => s.textKey === "k1")?.section).toBe("One");
    expect(rec?.stories.every((s) => /^s[0-9a-z]{6,}$/.test(s.id))).toBe(true); // content ids, not counters
    expect((await d.history.list()).editions.map((e) => e.id)).toEqual([first.id - DAY]);
    expect((await d.llm.load()).entries["k1"]?.headline).toBe("Old text"); // the old text stays usable
    expect(files.ed).toBe(JSON.stringify(legacyEditions)); // never deleted or rewritten
  });

  it("keeps post bodies out of the files (ids, names and the AI's own texts only)", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const i = await a.editions.open(w.items);
    await a.write(i.grouped.clusters, i.grouped.mixed);
    const all = [...a.disk.files.values()].map((f) => f.text).join("\n");
    expect(all).not.toMatch(/Secret0|long walk|lone remark/);
  });
});

describe("this device's name and the lines under the masthead", () => {
  const mem = (): { load: (k: string) => unknown; save: (k: string, v: string | null) => void; data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, load: (k) => data.get(k) ?? null, save: (k, v) => void (v === null ? data.delete(k) : data.set(k, v)) };
  };
  it("makes an id once and keeps it on this device; the label is the platform's until the person sets one", () => {
    const m = mem();
    const id = deviceId(m, (n) => new Uint8Array(n).fill(171));
    expect(id).toBe("abababababab");
    expect(deviceId(m, () => new Uint8Array(6))).toBe(id);
    expect(deviceLabel(m, { isIosApp: true, isTablet: true })).toBe("iPad");
    setDeviceLabel(m, "  Kitchen   iPad ");
    expect(deviceLabel(m, { isMacOS: true })).toBe("Kitchen iPad");
    setDeviceLabel(m, "");
    expect(deviceLabel(m, { isMacOS: true })).toBe("Mac");
    expect([defaultLabel({ isIosApp: true }), defaultLabel({ isWin: true }), defaultLabel({})]).toEqual(["iPhone", "Windows PC", "Device"]);
  });
  it("says who made the edition, from how many devices it is synced, and when a file is still arriving", () => {
    const made = { device: "d", label: "iPad", at: T0, mine: false };
    expect(syncLines({ made, others: 2, waiting: false }, T0)[0]).toMatch(/^Edition of .+, made on iPad at .+ · Synced from 2 devices$/);
    expect(syncLines({ made: { ...made, mine: true }, others: 0, waiting: false }, T0)[0]).not.toMatch(/Synced/);
    expect(syncLines({ made: null, others: 0, waiting: true }, null)).toEqual(["Waiting for sync: a file from another device is still arriving."]);
    expect(syncLines({ made: null, others: 0, waiting: false }, null)).toEqual([]);
  });
});

describe("the editor (DG7) is carried by the sync", () => {
  it("the edition keeps the editor that wrote it on every device: the record, the history and the reused texts are in that voice; the other device's own setting does not change it", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0, { editor: "harbour-master" });
    const b = device("devB", "iPad", prov, T0 + 3600_000, { editor: "neutral" });
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    expect((await a.editions.current())?.editor).toBe("harbour-master");
    ship(a, b);
    const ib = await b.editions.open(w.items);
    expect(ib.editor).toBe("harbour-master"); // "Today's editor" line: from the merged record
    expect((await b.editions.current())?.editor).toBe("harbour-master");
    expect((await b.history.list()).editions[0]?.editor).toBe("harbour-master");
    const n = prov.requests.length;
    const ob = await b.write(ib.grouped.clusters, ib.grouped.mixed); // B's setting is neutral, but the edition keeps its editor: the same keys, so reused
    expect(ob.status).toBe("ok");
    expect(prov.requests.length).toBe(n);
    expect((await b.editions.current())?.editor).toBe("harbour-master");
  });
  it("a manual re-sort on the other device in another voice changes the editor for both, once the file arrives", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0, { editor: "harbour-master" });
    const b = device("devB", "iPad", prov, T0 + 3600_000, { editor: "neutral" });
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    ship(a, b);
    const ib = await b.editions.open(w.items);
    await b.write(ib.grouped.clusters, ib.grouped.mixed, { resort: true });
    expect((await b.editions.current())?.editor).toBeUndefined();
    ship(b, a);
    a.setNow(T0 + 7200_000);
    const ra = await a.editions.open(w.items);
    expect(ra.editor).toBeUndefined();
    expect((await a.history.list()).editions[0]?.editor).toBeUndefined();
  });
});

describe("a change in another device's file is noticed", () => {
  it("tells the listeners when the joined state changed, also when a value changed and no counter did, and not for a re-read of the same files", async () => {
    const prov = provider();
    const w = world();
    const a = device("devA", "iPhone", prov, T0);
    const b = device("devB", "iPad", prov, T0 + 3600_000);
    const ia = await a.editions.open(w.items);
    await a.write(ia.grouped.clusters, ia.grouped.mixed);
    ship(a, b);
    await b.editions.open(w.items);
    let n = 0;
    b.sync.onChange(() => n++);
    await b.sync.refresh();
    expect(n).toBe(0);
    const file = `${DIR}/ed-${ia.id}.devA.json`;
    const st = JSON.parse(a.disk.files.get(file)?.text ?? "{}") as { regs: Record<string, { v: unknown }> };
    const key = Object.keys(st.regs).find((k) => k.startsWith("ai/")) as string;
    (st.regs[key] as { v: { headline: string } }).v.headline = "Changed on the other device";
    b.disk.put(file, JSON.stringify(st)); // same counters, a different value
    await b.sync.refresh();
    expect(n).toBe(1);
    expect((await b.sync.cache()).entries[key.slice(3)]?.headline).toBe("Changed on the other device");
  });
});
