// SH1: Save for later, on the Studio's shelf. The one rule under test: PUT /shelf replaces the whole list, so a save is a read-modify-write of exactly ONE change,
// sent with the revision it was made from, re-applied to the Studio's own answer on a 409, bounded, and never blind. Against the fake Studio (contract 6.2.0) and a scripted port.
import { describe, expect, it } from "vitest";
import { studioAddress } from "../../src/studio/address";
import { createShelf } from "../../src/app/shelfService";
import { createStudioClient, type StudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { applyChange, changeShelf, isShelved, MAX_TRIES, readShelf, readShelvedRow, shelfEntryOf, shelfMessage, SHELF_MAX, type ShelfEntry, type ShelfPort } from "../../src/studio/shelf";
import type { ReadingPost } from "../../src/studio/reading";
import { idleTimers } from "../helpers";
import { FAR_FUTURE, FakeStudio, makeToken, STUDIO_HOST } from "./fake-studio";

const TOKEN = makeToken({ expSeconds: FAR_FUTURE, scope: "owner:read owner:draft owner:publish owner:manage" });
const READ_ONLY = makeToken({ expSeconds: FAR_FUTURE, scope: "owner:read owner:draft owner:publish" });

function setup(opts: { contract?: string; token?: string } = {}) {
  const studio = new FakeStudio();
  studio.contractVersion = opts.contract ?? "6.2.0";
  studio.token = opts.token ?? TOKEN;
  for (const id of ["a", "b", "c", "d"]) studio.importItem({ remote_id: id, content_md: `Post ${id}.` });
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: studio.token });
  return { studio, client };
}
const portOf = (client: StudioClient): ShelfPort => ({ get: () => client.getShelf(), put: (e, r) => client.putShelf(e, r) });
const E = (remoteId: string, sub = "sub1"): ShelfEntry => ({ sub, remoteId });
const shelfWrites = (studio: FakeStudio) => studio.seen.filter((s) => s.method === "PUT" && s.path === "/api/shelf");
const post = (remoteId: string, over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "sub1", subscriptionTitle: "Blog B", origin: "https://blog-b.test/", remoteId, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "<p>x</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });

describe("the pure rules", () => {
  it("adds to the front, removes only that entry, and says when nothing needs sending", () => {
    expect(applyChange([E("a")], { kind: "add", entry: E("b") })).toEqual({ kind: "next", entries: [E("b"), E("a")] });
    expect(applyChange([E("a"), E("b")], { kind: "remove", entry: E("a") })).toEqual({ kind: "next", entries: [E("b")] });
    expect(applyChange([E("a")], { kind: "add", entry: E("a") })).toEqual({ kind: "same" });
    expect(applyChange([E("a")], { kind: "remove", entry: E("zz") })).toEqual({ kind: "same" });
  });
  it("a full shelf refuses an add and drops nothing; a remove is still possible", () => {
    const full = Array.from({ length: SHELF_MAX }, (_, i) => E(`p${i}`));
    expect(applyChange(full, { kind: "add", entry: E("new") })).toEqual({ kind: "full" });
    expect(applyChange(full, { kind: "remove", entry: E("p3") }).kind).toBe("next");
  });
  it("names a post by its subscription, an own post as ~own, and a post no subscription holds as nothing", () => {
    expect(shelfEntryOf(post("a"))).toEqual(E("a"));
    expect(shelfEntryOf(post("o1", { own: true, subscriptionId: "" }))).toEqual({ sub: "~own", remoteId: "o1" });
    expect(shelfEntryOf(post("x", { subscriptionId: "" }))).toBeNull();
    expect(isShelved({ entries: [E("a")], revision: 1 }, post("a"))).toBe(true);
    expect(isShelved(null, post("a"))).toBe(false);
    expect(isShelved({ entries: [E("a")], revision: 1 }, post("x", { subscriptionId: "" }))).toBe(false);
  });
  it("reads the Studio's shelf defensively: one unreadable entry and the whole answer is not trusted", () => {
    expect(readShelf({ entries: [{ sub: "s", remoteId: "r" }], revision: 3 })).toEqual({ entries: [E("r", "s")], revision: 3 });
    expect(readShelf({ entries: [{ sub: "s" }], revision: 3 })).toBeNull();
    expect(readShelf({ entries: [], revision: -1 })).toBeNull();
    expect(readShelf({ entries: [], revision: "3" })).toBeNull();
    expect(readShelf(null)).toBeNull();
  });
  it("reads a row of GET /reading?shelf=true as a post", () => {
    const row = { source: "imported", kind: "fragment", imported: { subscriptionId: "s", subscriptionTitle: "T", remoteId: "r", kind: "fragment", withdrawn: false, updated: "2026-11-01T00:00:00Z", observedAt: "2026-11-02T00:00:00Z", contentHtml: "<p>hi</p>", sourceUrl: null, version: 2, readVersion: 1 } };
    expect(readShelvedRow(row)).toMatchObject({ subscriptionId: "s", remoteId: "r", version: 2, readVersion: 1, contentHtml: "<p>hi</p>", authorName: null });
    expect(readShelvedRow({ ...row, imported: { ...row.imported, contentHtml: undefined } })).toBeNull();
    expect(readShelvedRow("x")).toBeNull();
  });
});

describe("a save is one change, read-modify-write, against the Studio", () => {
  it("saves with one GET and one PUT that carries the revision; a second device sees it", async () => {
    const { studio, client } = setup();
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null);
    expect(out).toMatchObject({ kind: "done", sent: true, shelf: { entries: [E("a")], revision: 1 } });
    expect(studio.seen.filter((s) => s.path === "/api/shelf").map((s) => s.method)).toEqual(["GET", "PUT"]);
    expect(shelfWrites(studio)[0]?.body).toEqual({ entries: [E("a")], expectedRevision: 0 });
    expect(studio.shelf).toEqual([E("a")]);
  });
  it("with the cache it holds, a save is the one PUT and nothing else", async () => {
    const { studio, client } = setup();
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, { entries: [], revision: 0 });
    expect(out.kind).toBe("done");
    expect(studio.seen.filter((s) => s.path.startsWith("/api/shelf")).map((s) => s.method)).toEqual(["PUT"]);
  });
  it("removing takes out only that post", async () => {
    const { studio, client } = setup();
    studio.shelf = [E("a"), E("b"), E("c")];
    studio.shelfRevision = 4;
    const out = await changeShelf(portOf(client), { kind: "remove", entry: E("b") }, null);
    expect(out).toMatchObject({ kind: "done", shelf: { entries: [E("a"), E("c")], revision: 5 } });
  });
  it("a post already saved, or already gone, sends nothing", async () => {
    const { studio, client } = setup();
    studio.shelf = [E("a")];
    studio.shelfRevision = 1;
    expect(await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null)).toMatchObject({ kind: "done", sent: false });
    expect(await changeShelf(portOf(client), { kind: "remove", entry: E("b") }, null)).toMatchObject({ kind: "done", sent: false });
    expect(shelfWrites(studio)).toEqual([]);
  });

  it("two clients racing: the stale PUT is answered with the current list, the one change is re-applied to it, and the other client's entry survives", async () => {
    const { studio, client } = setup();
    // This client believes the shelf is empty at revision 0. Just before its PUT lands, another client saves "b".
    studio.onNext("PUT", /^\/api\/shelf$/, () => {
      studio.shelf = [E("b")];
      studio.shelfRevision = 1;
    });
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, { entries: [], revision: 0 });
    expect(out).toMatchObject({ kind: "done", sent: true, shelf: { entries: [E("a"), E("b")], revision: 2 } });
    expect(studio.shelf).toEqual([E("a"), E("b")]);
    const puts = shelfWrites(studio);
    expect(puts.map((p) => (p.body as { expectedRevision: number }).expectedRevision)).toEqual([0, 1]); // the second send carries the revision the 409 handed over
    expect(puts.map((p) => p.status)).toEqual([409, 200]);
  });
  it("the other client already made the same change: nothing more is sent", async () => {
    const { studio, client } = setup();
    studio.onNext("PUT", /^\/api\/shelf$/, () => {
      studio.shelf = [E("a")];
      studio.shelfRevision = 1;
    });
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, { entries: [], revision: 0 });
    expect(out).toMatchObject({ kind: "done", sent: false });
    expect(shelfWrites(studio)).toHaveLength(1);
  });
  it("another client wins every time: it stops after MAX_TRIES sends, says so, and overwrote nothing", async () => {
    const { studio, client } = setup();
    let n = 0;
    const lose = (): void => {
      n++;
      studio.shelf = [E(n % 2 ? "b" : "c")];
      studio.shelfRevision++;
      studio.onNext("PUT", /^\/api\/shelf$/, lose);
    };
    studio.onNext("PUT", /^\/api\/shelf$/, lose);
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, { entries: [], revision: 0 });
    expect(out.kind).toBe("busy");
    expect(shelfWrites(studio)).toHaveLength(MAX_TRIES);
    expect(shelfWrites(studio).every((p) => p.status === 409)).toBe(true);
    expect(studio.shelf).not.toContainEqual(E("a")); // never forced in
    expect(shelfMessage(out as Exclude<typeof out, { kind: "done" }>)).toMatch(/Nothing was overwritten/);
  });
  it("every send names a revision: there is no way to send without one", async () => {
    const { studio, client } = setup();
    await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null);
    await changeShelf(portOf(client), { kind: "add", entry: E("b") }, null);
    for (const p of shelfWrites(studio)) expect(Number.isInteger((p.body as { expectedRevision: unknown }).expectedRevision)).toBe(true);
  });

  it("a full shelf: says so, sends nothing, drops no entry", async () => {
    const { studio, client } = setup();
    studio.shelf = Array.from({ length: SHELF_MAX }, (_, i) => E(`p${i}`));
    studio.shelfRevision = 7;
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null);
    expect(out.kind).toBe("full");
    expect(shelfMessage(out as Exclude<typeof out, { kind: "done" }>)).toMatch(/shelf is full \(50 posts\).*nothing was dropped/i);
    expect(shelfWrites(studio)).toEqual([]);
    expect(studio.shelf).toHaveLength(SHELF_MAX);
  });
  it("the shelf fills up while this client is saving: the re-applied add is refused as full, not forced in", async () => {
    const { studio, client } = setup();
    studio.onNext("PUT", /^\/api\/shelf$/, () => {
      studio.shelf = Array.from({ length: SHELF_MAX }, (_, i) => E(`p${i}`));
      studio.shelfRevision = 1;
    });
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, { entries: [], revision: 0 });
    expect(out.kind).toBe("full");
    expect(studio.shelf).toHaveLength(SHELF_MAX);
  });
  it("a post the Studio does not hold is dropped by it: said, not shown as saved", async () => {
    const { client } = setup();
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("nope") }, null);
    expect(out.kind).toBe("dropped");
    expect(shelfMessage(out as Exclude<typeof out, { kind: "done" }>)).toMatch(/did not keep/);
  });

  it("a token without owner:manage: the Studio does not even list putShelf, so no PUT is sent and the message names the permission", async () => {
    const { studio, client } = setup({ token: READ_ONLY });
    studio.manage = false;
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null);
    expect(out).toEqual({ kind: "no-scope", need: "owner:manage" });
    expect(shelfWrites(studio)).toEqual([]);
    expect(shelfMessage(out as Exclude<typeof out, { kind: "done" }>)).toBe("Your token cannot change the shelf. It needs the permission “owner:manage”: make a new token with every permission.");
  });
  it("a Studio that lists the operation but answers 403 is the same message", async () => {
    const { studio, client } = setup();
    studio.operationsListed = ["getCapabilities", "getShelf", "putShelf"];
    studio.forced.set("PUT /api/shelf", { status: 403, text: JSON.stringify({ code: "forbidden", message: "insufficient_scope" }) });
    expect(await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null)).toEqual({ kind: "no-scope", need: "owner:manage" });
  });
  it("an old Studio (contract 5, or contract 6 without the operations): never asked, 'no shelf yet'", async () => {
    for (const variant of [{ contract: "5.2.0" }, { contract: "6.0.0" }]) {
      const { studio, client } = setup(variant);
      if (variant.contract === "6.0.0") studio.hasShelf = false;
      const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null);
      expect(out).toEqual({ kind: "absent" });
      expect(studio.seen.filter((s) => s.path.startsWith("/api/shelf"))).toEqual([]);
      expect(shelfMessage(out as Exclude<typeof out, { kind: "done" }>)).toMatch(/no shelf yet\. Update the Studio/);
    }
  });
  it("a Studio that lists no operations at all is treated as having no shelf (fail closed)", async () => {
    const { studio, client } = setup();
    studio.operationsListed = [];
    expect(await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null)).toEqual({ kind: "absent" });
  });
  it("a Studio that is down says so in its own words and changes nothing", async () => {
    const { studio, client } = setup();
    studio.forced.set("GET /api/shelf", { status: 502, text: "{}" });
    const out = await changeShelf(portOf(client), { kind: "add", entry: E("a") }, null);
    expect(out.kind).toBe("failed");
    expect(shelfWrites(studio)).toEqual([]);
  });
});

describe("the Saved list: one read, no write", () => {
  it("asks GET /reading?shelf=true (order=newest on 6.2) and returns the posts in shelf order", async () => {
    const { studio, client } = setup();
    studio.shelf = [E("c"), E("a")];
    studio.shelfRevision = 2;
    const got = await client.listShelved();
    expect(got.kind === "ok" && got.value?.posts.map((p) => p.remoteId)).toEqual(["c", "a"]);
    const asked = studio.seen.filter((s) => s.path.startsWith("/api/reading"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toContain("shelf=true");
    expect(asked[0]?.path).toContain("order=newest");
    expect(studio.writes().filter((s) => s.method !== "GET")).toEqual([]);
  });
  it("an old Studio is not asked", async () => {
    const { studio, client } = setup({ contract: "5.2.0" });
    expect(await client.listShelved()).toEqual({ kind: "ok", value: null });
    expect(studio.seen.filter((s) => s.path.startsWith("/api/reading"))).toEqual([]);
  });
});

describe("the service the reader holds", () => {
  const build = (_studio: FakeStudio, client: StudioClient, token = TOKEN) => () => ({ ok: true as const, studio: { client }, token });
  it("reads the shelf once per Feed opening (no polling), and a save is one PUT with no read of its own", async () => {
    const { studio, client } = setup();
    studio.shelf = [E("b")];
    studio.shelfRevision = 1;
    const shelf = createShelf({ build: build(studio, client), enabled: () => true });
    expect(shelf.has(post("b"))).toBe(false); // not read yet: nothing is shown as saved
    shelf.reset();
    await shelf.opening();
    await shelf.opening(); // the same opening: no second read
    await shelf.opening();
    expect(studio.seen.filter((s) => s.method === "GET" && s.path === "/api/shelf")).toHaveLength(1);
    expect(shelf.ready() && shelf.has(post("b")) && !shelf.has(post("a"))).toBe(true);
    expect(await shelf.toggle(post("a"))).toEqual({ ok: true, saved: true });
    expect(studio.seen.filter((s) => s.path === "/api/shelf").map((s) => s.method)).toEqual(["GET", "PUT"]);
    expect(shelf.has(post("a"))).toBe(true);
    expect(shelf.count()).toBe(2);
    shelf.reset();
    await shelf.opening(); // a new opening reads again
    expect(studio.seen.filter((s) => s.method === "GET" && s.path === "/api/shelf")).toHaveLength(2);
  });
  it("tapping a saved post takes it off; two quick taps are queued, not raced", async () => {
    const { studio, client } = setup();
    const shelf = createShelf({ build: build(studio, client), enabled: () => true });
    await shelf.opening();
    const results = await Promise.all([shelf.toggle(post("a")), shelf.toggle(post("b")), shelf.toggle(post("a"))]);
    expect(results).toEqual([{ ok: true, saved: true }, { ok: true, saved: true }, { ok: true, saved: false }]);
    expect(studio.shelf).toEqual([E("b")]);
    expect(shelfWrites(studio).every((p) => p.status === 200)).toBe(true); // one at a time: no 409 against itself
  });
  it("a second device's change is not undone: the save lands on top of it", async () => {
    const { studio, client } = setup();
    const shelf = createShelf({ build: build(studio, client), enabled: () => true });
    await shelf.opening();
    studio.shelf = [E("c")]; // the other device saved "c" after this device read the shelf
    studio.shelfRevision = 1;
    expect(await shelf.toggle(post("a"))).toEqual({ ok: true, saved: true });
    expect(studio.shelf).toEqual([E("a"), E("c")]);
  });
  it("a token whose scopes lack owner:manage is refused before any request, with the message", async () => {
    const { studio, client } = setup({ token: READ_ONLY });
    const shelf = createShelf({ build: build(studio, client, READ_ONLY), enabled: () => true });
    const out = await shelf.toggle(post("a"));
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/owner:manage/);
    expect(studio.seen.filter((s) => s.path.startsWith("/api/shelf"))).toEqual([]);
  });
  it("switched off: nothing is asked, nothing is shown, a save is refused", async () => {
    const { studio, client } = setup();
    const shelf = createShelf({ build: build(studio, client), enabled: () => false });
    await shelf.opening();
    expect(shelf.ready()).toBe(false);
    expect(shelf.has(post("a"))).toBe(false);
    expect((await shelf.toggle(post("a"))).ok).toBe(false);
    expect(await shelf.saved()).toBeNull();
    expect(studio.seen.filter((s) => s.path.startsWith("/api/"))).toEqual([]);
  });
  it("a post no subscription holds cannot be saved, and the message says why", async () => {
    const { studio, client } = setup();
    const shelf = createShelf({ build: build(studio, client), enabled: () => true });
    const out = await shelf.toggle(post("x", { subscriptionId: "" }));
    expect(!out.ok && out.message).toMatch(/not followed/);
    expect(shelfWrites(studio)).toEqual([]);
  });
  it("an old Studio: the cache stays empty, not ready, and a tap says 'no shelf yet'", async () => {
    const { studio, client } = setup({ contract: "5.2.0" });
    const shelf = createShelf({ build: build(studio, client), enabled: () => true });
    await shelf.opening();
    expect(shelf.ready()).toBe(false);
    const out = await shelf.toggle(post("a"));
    expect(!out.ok && out.message).toMatch(/no shelf yet/);
  });
});
