// What the panel learns from the Studio: facts about one item, warnings about the whole Studio, and the cache between them and the panel.
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import { createLiveCache, editedInStudio, loadStudioFacts, loadStudioNotices, loadStudioWarnings, type StudioFacts } from "../../src/studio/live";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { idleTimers } from "../helpers";
import { FAR_FUTURE, FakeStudio, STUDIO_HOST, STUDIO_TOKEN, idOf, makeToken } from "./fake-studio";

const NOW = new Date("2026-10-23T12:00:00Z");
const clock = { now: () => NOW };

function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return { studio, client };
}
const mention = (target: string, over: Partial<FakeStudio["mentions"][number]> = {}): FakeStudio["mentions"][number] => ({
  id: `m${Math.random()}`,
  target_item_id: target,
  status: "verified",
  relation: "transclusion",
  hidden: false,
  ...over,
});

describe("facts about one item", () => {
  it("reads the state, the hash of the working copy, and counts only verified, visible mentions of this item", async () => {
    const { studio, client } = setup();
    const item = studio.seed({ content_md: "Hello.", status: "public", version: 2 });
    studio.mentions.push(mention(item.id), mention(item.id, { relation: null }), mention(item.id, { status: "pending" }), mention(item.id, { hidden: true }), mention(idOf(99)));
    const facts = await loadStudioFacts(client, item.id, clock);
    expect(facts).toEqual({ item: { status: "public", version: 2, workingHash: await contentHash("Hello."), created: item.created, updated: item.updated }, mentions: { count: 2, complete: true }, hoppers: [], at: NOW.getTime() });
  });

  it("names the hoppers the item is in (S13), and says nothing when they cannot be read", async () => {
    const { studio, client } = setup();
    const item = studio.seed({ content_md: "Hello.", status: "public", version: 1 });
    studio.addHopper("A").members.add(item.id);
    studio.addHopper("B");
    expect((await loadStudioFacts(client, item.id, clock)).hoppers).toEqual(["A"]);
    studio.forced.set("GET /api/hoppers", { status: 500, text: "{}" });
    expect((await loadStudioFacts(client, item.id, clock)).hoppers).toBeNull();
  });

  it("pages through the owner's mentions, and says when it stopped before the end", async () => {
    const { studio, client } = setup();
    const item = studio.seed({ content_md: "x", status: "public", version: 1 });
    for (let i = 0; i < 230; i++) studio.mentions.push(mention(i % 2 === 0 ? item.id : idOf(5)));
    expect((await loadStudioFacts(client, item.id, clock)).mentions).toEqual({ count: 115, complete: true });
    for (let i = 0; i < 400; i++) studio.mentions.push(mention(item.id));
    const many = await loadStudioFacts(client, item.id, clock);
    expect(many.mentions?.complete).toBe(false);
    expect(many.mentions?.count).toBeGreaterThan(100);
  });

  it("an item the Studio does not have is 'missing'; a Studio that cannot be asked is 'unreachable', never 'missing'", async () => {
    const { studio, client } = setup();
    expect((await loadStudioFacts(client, idOf(77), clock)).item).toBe("missing");
    const item = studio.seed({ content_md: "x", status: "public", version: 1 });
    studio.forced.set("GET /api/items/" + item.id, { status: 502, text: "bad gateway" });
    expect((await loadStudioFacts(client, item.id, clock)).item).toBe("unreachable");
    studio.forced.set("GET /api/items/" + item.id, new Error("offline"));
    expect((await loadStudioFacts(client, item.id, clock)).item).toBe("unreachable");
  });

  it("a failing mentions list leaves the count out (nothing), not zero", async () => {
    const { studio, client } = setup();
    const item = studio.seed({ content_md: "x", status: "public", version: 1 });
    studio.forced.set("GET /api/mentions", { status: 500, text: "boom" });
    const facts = await loadStudioFacts(client, item.id, clock);
    expect(facts.item).toMatchObject({ status: "public" });
    expect(facts.mentions).toBeNull();
  });
});

describe("edited in the Studio", () => {
  const facts = (workingHash: string): StudioFacts => ({ item: { status: "public", version: 1, workingHash }, mentions: null, at: 0 });
  it("is true when the working copy is neither what the note last sent nor what it says now", () => {
    expect(editedInStudio(facts("h-studio"), { sent: "h-sent", localHash: "h-now" })).toBe(true);
    expect(editedInStudio(facts("h-sent"), { sent: "h-sent", localHash: "h-now" })).toBe(false);
    expect(editedInStudio(facts("h-now"), { sent: "h-sent", localHash: "h-now" })).toBe(false);
    expect(editedInStudio(facts("h-studio"), { sent: null, localHash: null })).toBe(true);
  });
  it("is false when the Studio could not be asked or has no such item", () => {
    expect(editedInStudio({ item: "unreachable", mentions: null, at: 0 }, { sent: "a", localHash: "b" })).toBe(false);
    expect(editedInStudio({ item: "missing", mentions: null, at: 0 }, { sent: "a", localHash: "b" })).toBe(false);
  });
});

describe("warnings about the whole Studio", () => {
  const warn = async (token: string, generator?: string) => {
    const { studio, client } = setup();
    if (generator) studio.generator = generator;
    return loadStudioWarnings(client, token, clock);
  };
  const days = (n: number): number => Math.floor(NOW.getTime() / 1000) + n * 86400 + 3600;

  it("none for a fresh token and a tested release", async () => {
    expect(await warn(makeToken({ expSeconds: FAR_FUTURE }))).toEqual([]);
  });
  it("the token is about to expire, or has", async () => {
    expect(await warn(makeToken({ expSeconds: days(3) }))).toEqual([expect.stringMatching(/token expires in 3 days/)]);
    expect(await warn(makeToken({ expSeconds: days(-2) }))).toEqual([expect.stringMatching(/token has expired/)]);
  });
  it("a newer minor of the contract, an older or newer contract, or an address that is not a Studio", async () => {
    const tok = makeToken({ expSeconds: FAR_FUTURE });
    const withContract = async (contractVersion: string | null) => {
      const { studio, client } = setup();
      studio.contractVersion = contractVersion;
      return loadStudioWarnings(client, tok, clock);
    };
    // (b) a newer minor is not a warning: it is a muted note
    expect(await withContract("5.9.0")).toEqual([]);
    expect(await withContract("5.5.0")).toEqual([]);
    for (const tested of ["5.2.0", "5.3.0", "5.4.0"]) expect(await withContract(tested), tested).toEqual([]);
    expect(await withContract("4.1.0")).toEqual([expect.stringMatching(/older API.*0\.51\.0/)]);
    expect(await withContract(null)).toEqual([expect.stringMatching(/older API/)]);
    expect(await withContract("6.0.0")).toEqual([expect.stringMatching(/Update the plugin/)]);
    expect(await warn(tok, "someone-else/1.0")).toEqual([expect.stringMatching(/does not announce a Blygger Studio/)]);
  });
  it("a newer minor contract is a note, never a warning; same or older minor says nothing; a newer major is refused", async () => {
    const tok = makeToken({ expSeconds: FAR_FUTURE });
    const notices = async (contractVersion: string) => {
      const { studio, client } = setup();
      studio.contractVersion = contractVersion;
      return loadStudioNotices(client, tok, clock);
    };
    expect(await notices("5.5.0")).toEqual({ warnings: [], notes: [expect.stringMatching(/Studio API 5\.5\.0 is newer than the 5\.4 this plugin was tested with\. Newer minor versions only add things and are accepted/)] });
    for (const v of ["5.4.0", "5.3.0", "5.2.0"]) expect(await notices(v), v).toEqual({ warnings: [], notes: [] });
    const major = await notices("6.0.0");
    expect(major.notes).toEqual([]);
    expect(major.warnings).toEqual([expect.stringMatching(/Update the plugin/)]);
  });
  it("an unreachable Studio adds no version warning (the panel says it is unreachable by itself)", async () => {
    const { studio, client } = setup();
    studio.forced.set("GET /blyg.json", new Error("offline"));
    expect(await loadStudioWarnings(client, makeToken({ expSeconds: FAR_FUTURE }), clock)).toEqual([]);
  });
});

describe("the cache", () => {
  function cache(over: { ttl?: number } = {}) {
    let now = 0;
    const loads: string[] = [];
    let release: (() => void) | null = null;
    const c = createLiveCache<string>({
      load: async (key) => {
        loads.push(key);
        await new Promise<void>((r) => (release = r));
        return `value of ${key} #${loads.length}`;
      },
      now: () => now,
      ttlMs: () => over.ttl ?? 1000,
    });
    return { c, loads, advance: (ms: number) => (now += ms), finish: () => release?.() };
  }
  const flush = () => new Promise<void>((r) => queueMicrotask(r)).then(() => Promise.resolve()).then(() => Promise.resolve());

  it("answers instantly with what it has, asks once at a time, and tells when the answer arrived", async () => {
    const { c, loads, finish } = cache();
    let changes = 0;
    expect(c.peek("a")).toBeUndefined();
    c.request("a", () => changes++);
    c.request("a", () => changes++);
    expect(loads).toEqual(["a"]);
    finish();
    await flush();
    expect(changes).toBe(1);
    expect(c.peek("a")).toBe("value of a #1");
  });

  it("does not ask again while fresh, and asks again once the lifetime is over (still serving the old value meanwhile)", async () => {
    const { c, loads, advance, finish } = cache();
    c.request("a", () => {});
    finish();
    await flush();
    advance(500);
    c.request("a", () => {});
    expect(loads).toHaveLength(1);
    advance(600);
    c.request("a", () => {});
    expect(loads).toHaveLength(2);
    expect(c.peek("a")).toBe("value of a #1");
  });

  it("an answer that was on its way when something changed is dropped", async () => {
    const { c, finish } = cache();
    let changes = 0;
    c.request("a", () => changes++);
    c.invalidate();
    finish();
    await flush();
    expect(c.peek("a")).toBeUndefined();
    expect(changes).toBe(1); // told, so the panel asks again with the new situation
  });

  it("lists what has aged out, so a periodic refresh can ask again while the old answer stays on screen", async () => {
    const { c, advance, finish } = cache();
    c.request("a", () => {});
    finish();
    await flush();
    expect(c.expired()).toEqual([]);
    advance(1500);
    expect(c.expired()).toEqual(["a"]);
    expect(c.peek("a")).toBe("value of a #1");
    c.request("a", () => {});
    expect(c.peek("a")).toBe("value of a #1");
  });

  it("invalidates one key or all, and a load that fails stores nothing and does not call back (no endless redraw)", async () => {
    let calls = 0;
    const c = createLiveCache<string>({ load: () => (calls++ === 0 ? Promise.reject(new Error("x")) : Promise.resolve("ok")), now: () => 0, ttlMs: () => 1000 });
    let changes = 0;
    c.request("a", () => changes++);
    await flush();
    expect([c.peek("a"), changes]).toEqual([undefined, 0]);
    c.request("a", () => changes++);
    await flush();
    expect([c.peek("a"), changes]).toEqual(["ok", 1]);
    c.request("b", () => {});
    await flush();
    c.invalidate("a");
    expect([c.peek("a"), c.peek("b")]).toEqual([undefined, "ok"]);
    c.invalidate();
    expect(c.peek("b")).toBeUndefined();
  });
});
