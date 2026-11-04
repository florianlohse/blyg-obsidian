import { describe, expect, it } from "vitest";
import { contractCacheFor, createContractCache, createStudioClient, readItem } from "../../src/studio/client";
import type { ContractVerdict } from "../../src/studio/version";
import { studioAddress } from "../../src/studio/address";
import { createStudioHttp } from "../../src/studio/http";
import { idleTimers } from "../helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./fake-studio";

function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return { studio, client };
}

describe("studio client", () => {
  it("creates, reads, updates, publishes and withdraws, each command naming the revision it acts on", async () => {
    const { client, studio } = setup();
    const created = await client.createItem({ kind: "fragment", contentMd: "one" });
    expect(created).toMatchObject({ kind: "ok", value: { status: "draft", version: 0, revision: 1, contentMd: "one", dirty: true, kind: "fragment" } });
    const id = created.kind === "ok" ? created.value.id : "";
    const updated = await client.updateItem(id, { contentMd: "two" }, 1);
    expect(updated).toMatchObject({ kind: "ok", value: { contentMd: "two", revision: 2 } });
    expect(await client.publish(id, "first", 2)).toEqual({ kind: "ok", value: { version: 1, revision: 3 } });
    const got = await client.getItem(id);
    expect(got).toMatchObject({ kind: "ok", value: { status: "public", version: 1, revision: 3, dirty: false, published: { version: 1, contentMd: "two", note: "first" } } });
    expect(await client.withdraw(id, undefined, 3)).toEqual({ kind: "ok", value: { version: 2, revision: 4 } });
    expect(await client.getItem(id)).toMatchObject({ kind: "ok", value: { status: "withdrawn", kind: "fragment" } });
    // the wire is contract 5: camelCase, and the revision travels in the body
    expect(studio.writes().map((w) => w.body)).toEqual([
      { mode: "blank", kind: "fragment", contentMd: "one" },
      { contentMd: "two", expectedRevision: 1 },
      { expectedRevision: 2, note: "first" },
      { expectedRevision: 3 },
    ]);
  });

  it("a stale revision is a conflict that names the item and the revision that was sent; nothing is changed", async () => {
    const { client, studio } = setup();
    const item = studio.seed({ content_md: "x" });
    studio.editThere(item.id, "edited in the Studio");
    expect(await client.updateItem(item.id, { contentMd: "mine" }, 1)).toEqual({ kind: "conflict", itemId: item.id, expectedRevision: 1 });
    expect(await client.publish(item.id, undefined, 1)).toEqual({ kind: "conflict", itemId: item.id, expectedRevision: 1 });
    expect(await client.withdraw(item.id, undefined, 1)).toEqual({ kind: "conflict", itemId: item.id, expectedRevision: 1 });
    expect(await client.deleteItem(item.id, 1)).toEqual({ kind: "conflict", itemId: item.id, expectedRevision: 1 });
    expect(studio.items.get(item.id)).toMatchObject({ content_md: "edited in the Studio", version: 0, revision: 2 });
  });

  it("deleting a draft sends a JSON body with the revision (contract 5 requires one on DELETE)", async () => {
    const { client, studio } = setup();
    const item = studio.seed({ content_md: "x" });
    expect(await client.deleteItem(item.id, 1)).toEqual({ kind: "ok", value: null });
    expect(studio.seen.at(-1)).toMatchObject({ method: "DELETE", body: { expectedRevision: 1 } });
    expect(studio.items.has(item.id)).toBe(false);
  });

  it("an item that does not exist is not-found, not an error", async () => {
    const { client } = setup();
    expect(await client.getItem("a0000000000000000000000099")).toEqual({ kind: "not-found" });
  });

  it("maps statuses: 401 unauthorized, 403 forbidden, other 4xx rejected with Studio's words, 5xx error", async () => {
    const { client, studio } = setup();
    studio.forced.set("GET /api/items/summary", { status: 401, text: '{"code":"unauthorized","message":"unauthorized"}' });
    expect((await client.countItems()).kind).toBe("unauthorized");
    studio.forced.set("GET /api/items/summary", { status: 403, text: '{"code":"forbidden","message":"missing scope owner:read"}' });
    expect(await client.countItems()).toEqual({ kind: "forbidden", message: "missing scope owner:read" });
    studio.forced.set("POST /api/items", { status: 400, text: '{"code":"invalid-input","message":"bad body","details":{"errors":[{"directive":"![[x]]","reason":"unknown item"}]}}' });
    expect(await client.createItem({ kind: "fragment", contentMd: "x" })).toEqual({ kind: "rejected", status: 400, message: "bad body", code: "invalid-input", problems: [{ directive: "![[x]]", reason: "unknown item" }] });
    studio.forced.set("GET /api/items/summary", { status: 502, text: "<html>bad gateway</html>" });
    expect(await client.countItems()).toEqual({ kind: "error", status: 502, message: "" });
  });

  it("an answer in an unexpected form is an error, never a guess", async () => {
    const { client, studio } = setup();
    studio.forced.set("GET /api/items/summary", { status: 200, text: '{"all":"many"}' });
    expect(await client.countItems()).toMatchObject({ kind: "error", status: 200 });
    studio.forced.set("POST /api/preview", { status: 200, text: '{"nothtml":1}' });
    expect(await client.preview({ contentMd: "x", kind: "fragment" })).toMatchObject({ kind: "error" });
    studio.forced.set("POST /api/items", { status: 201, text: '{"id":"x"}' });
    expect(await client.createItem({ kind: "fragment", contentMd: "x" })).toMatchObject({ kind: "error" });
    // contract 5 items carry a revision: an item without one (a contract-4 answer) is not an item
    studio.forced.set("POST /api/items", { status: 201, text: JSON.stringify({ id: "x", kind: "fragment", status: "draft", version: 0, contentMd: "x", dirty: true }) });
    expect(await client.createItem({ kind: "fragment", contentMd: "x" })).toMatchObject({ kind: "error" });
  });

  it("previews both shapes: a fragment's linkErrors and a thread's errors", async () => {
    const { client, studio } = setup();
    studio.previewProblems = [{ directive: "[[zz]]", reason: "unknown item" }];
    const frag = await client.preview({ contentMd: "x", kind: "fragment" });
    const thread = await client.preview({ contentMd: "x", kind: "thread", itemId: "a0000000000000000000000001" });
    expect(frag).toMatchObject({ kind: "ok", value: { html: "<p>x</p>", problems: [{ directive: "[[zz]]", reason: "unknown item" }] } });
    expect(thread).toMatchObject({ kind: "ok", value: { problems: [{ directive: "[[zz]]", reason: "unknown item" }] } });
  });

  it("a thread's preview says what it quotes: item, version, passage, and the other blyg for a remote item", async () => {
    const { client, studio } = setup();
    const own = studio.seed({ content_md: "x", status: "public", version: 2 });
    studio.importItem({ remote_id: "095s4h48j67mnbf6hq8vatc2d4", content_md: "y", origin: "https://blog-b.test/" });
    const md = `![[${own.id}]]\n> a part\n\n![[095s4h48j67mnbf6hq8vatc2d4 | label]]\n\n![[a0000000000000000000000099]]`;
    const out = await client.preview({ contentMd: md, kind: "thread" });
    expect(out).toMatchObject({
      kind: "ok",
      value: { quotes: [{ id: own.id, version: 2, passage: "a part", origin: null }, { id: "095s4h48j67mnbf6hq8vatc2d4", version: 1, passage: null, origin: "https://blog-b.test/" }] },
    });
    expect((await client.preview({ contentMd: "x", kind: "fragment" })).kind === "ok" && (await client.preview({ contentMd: "x", kind: "fragment" }))).toMatchObject({ value: { quotes: [] } });
  });

  it("searches, with an empty query listing everything, and reads what it needs of each row", async () => {
    const { client, studio } = setup();
    studio.seed({ content_md: "Own words.", status: "public", version: 1 });
    studio.importItem({ remote_id: "095s4h48j67mnbf6hq8vatc2d4", content_md: "Imported words." });
    const all = await client.search({});
    expect(all).toMatchObject({ kind: "ok", value: { items: [{ source: "mine", subscriptionId: null, sourceTitle: null }, { source: "imported", subscriptionId: "sub1", sourceTitle: "Blog B", kind: "fragment", version: 1 }] } });
    expect(await client.search({ q: "imported", source: "imported", limit: 5 })).toMatchObject({ kind: "ok", value: { items: [{ source: "imported" }] } });
    expect(studio.seen.at(-1)?.path).toBe("/api/search?limit=5&source=imported&q=imported");
  });

  it("skips search rows it cannot read, and refuses an answer that is not a list", async () => {
    const { client, studio } = setup();
    studio.forced.set("GET /api/search", { status: 200, text: JSON.stringify({ items: [{ id: "x" }, { id: "a", kind: "fragment", version: 1, source: "mine" }], page: { limit: 20, nextCursor: null } }) });
    expect(await client.search({})).toMatchObject({ kind: "ok", value: { items: [{ id: "a", label: "", excerpt: "" }] } });
    studio.forced.set("GET /api/search", { status: 200, text: '{"items":"no"}' });
    expect(await client.search({})).toMatchObject({ kind: "error", status: 200 });
    studio.forced.set("GET /api/search", { status: 403, text: '{"code":"forbidden","message":"missing scope owner:read"}' });
    expect((await client.search({})).kind).toBe("forbidden");
  });

  it("reads an imported item, and says not-found for one it does not hold", async () => {
    const { client, studio } = setup();
    studio.importItem({ remote_id: "095s4h48j67mnbf6hq8vatc2d4", content_md: "Imported words.", version: 3 });
    expect(await client.getImported("sub1", "095s4h48j67mnbf6hq8vatc2d4")).toEqual({ kind: "ok", value: { id: "095s4h48j67mnbf6hq8vatc2d4", kind: "fragment", version: 3, state: "current", contentHtml: "<p>Imported words.</p>\n" } });
    expect(await client.getImported("sub1", "a0000000000000000000000099")).toEqual({ kind: "not-found" });
    studio.forced.set("GET /api/imports/sub1/x", { status: 200, text: '{"version":"3"}' });
    expect(await client.getImported("sub1", "x")).toMatchObject({ kind: "error" });
  });

  it("reads the public manifest", async () => {
    const { client } = setup();
    expect(await client.manifest()).toEqual({ kind: "ok", value: { generator: "blygger-studio/0.51.0", protocol: "0.4", site: "https://studio.test/", title: "Test blyg" } });
  });

  it("Studio's words are redacted and shortened before they can reach a notice", async () => {
    const { client, studio } = setup();
    studio.forced.set("GET /api/items/summary", { status: 500, text: JSON.stringify({ code: "internal", message: `trace ${STUDIO_TOKEN} ${"x".repeat(500)}` }) });
    const res = await client.countItems();
    expect(res.kind).toBe("error");
    expect(JSON.stringify(res)).not.toContain(STUDIO_TOKEN);
    expect(res.kind === "error" && res.message.length).toBeLessThanOrEqual(300);
  });
});

describe("readItem", () => {
  const base = { id: "a0000000000000000000000001", revision: 4, kind: "fragment", status: "public", version: 2, contentMd: "x", dirty: false };
  it("takes the kind and the revision as they are", () => {
    expect(readItem({ ...base, kind: "thread" })).toMatchObject({ kind: "thread", revision: 4 });
    expect(readItem({ ...base })).toMatchObject({ kind: "fragment", revision: 4, status: "public" });
  });
  it("rejects anything that is not an item", () => {
    for (const bad of [null, [], "x", {}, { ...base, status: "weird" }, { ...base, version: "2" }, { ...base, dirty: 0 }, { ...base, contentMd: 5 }, { ...base, id: 3 }, { ...base, kind: "withdrawn" }, { ...base, revision: 0 }, { ...base, revision: 1.5 }, { ...base, revision: undefined }]) {
      expect(readItem(bad)).toBeNull();
    }
  });
  it("ignores a published block it cannot read", () => {
    expect(readItem({ ...base, published: { version: 1 } })?.published).toBeNull();
  });
});

describe("cursor walks", () => {
  it("follows the cursor to the end and stops at the page cap with complete: false", async () => {
    const { client, studio } = setup();
    for (let i = 0; i < 230; i++) studio.seed({ content_md: `n${i}` });
    const listed = await client.listItems();
    expect(listed.kind === "ok" && listed.value.items.length).toBe(230);
    expect(listed).toMatchObject({ value: { complete: true, unreadable: 0 } });
    // three requests of 100, each after the first carrying the cursor of the one before; never an offset
    const paths = studio.seen.filter((s) => s.path.startsWith("/api/items?")).map((s) => s.path);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe("/api/items?limit=100");
    expect(paths.slice(1).every((p) => p.includes("cursor=") && !p.includes("offset"))).toBe(true);
  });

  it("starts again from page 1 when the Studio says the cursor expired, and never appends to the old pages", async () => {
    const { client, studio } = setup();
    for (let i = 0; i < 150; i++) studio.seed({ content_md: `n${i}` });
    // the first request is answered as it is; a new item appears just before the second (page 2 of 2)
    studio.onNext("GET", /^\/api\/items$/, () => undefined);
    studio.onNext("GET", /^\/api\/items$/, () => void studio.seed({ content_md: "arrived mid-walk" }));
    const listed = await client.listItems();
    // the walk was thrown away and read again from page 1, so the new item is in it exactly once
    expect(listed).toMatchObject({ kind: "ok", value: { complete: true } });
    const ids = listed.kind === "ok" ? listed.value.items.map((i) => i.id) : [];
    expect(ids).toHaveLength(151);
    expect(new Set(ids).size).toBe(151);
    expect(studio.seen.filter((s) => s.path.startsWith("/api/items?")).map((s) => s.path.includes("cursor="))).toEqual([false, true, false, true]);
  });

  it("gives up with a plain error when the list keeps changing", async () => {
    const { studio } = setup();
    for (let i = 0; i < 150; i++) studio.seed({ content_md: `n${i}` });
    // every follow-up page is preceded by a change, so both walks expire
    const original = studio.transport;
    let arrivals = 0;
    const flaky = (req: Parameters<typeof original>[0]) => {
      if (req.url.includes("cursor=")) studio.seed({ content_md: `again ${arrivals++}` });
      return original(req);
    };
    const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
    if (!address) throw new Error("address");
    const client = createStudioClient({ http: createStudioHttp({ transport: flaky, timers: idleTimers, address }), token: STUDIO_TOKEN });
    expect(await client.listItems()).toMatchObject({ kind: "error", status: 409 });
    expect(arrivals).toBe(2);
  });

  it("counts a mention only when it is verified, visible, and for this item; asks for this item's rows", async () => {
    const { client, studio } = setup();
    studio.mentions.push(
      { id: "m1", target_item_id: "A", status: "verified", relation: "transclusion", hidden: false },
      { id: "m2", target_item_id: "A", status: "pending", relation: null, hidden: false },
      { id: "m3", target_item_id: "A", status: "verified", relation: null, hidden: true },
      { id: "m4", target_item_id: "B", status: "verified", relation: null, hidden: false },
    );
    expect(await client.countMentions("A")).toEqual({ kind: "ok", value: { count: 1, complete: true } });
    expect(studio.seen.at(-1)?.path).toBe("/api/mentions?direction=inbound&targetItemId=A&limit=100");
  });

  it("lists the owner's members of a hopper from the memberships route", async () => {
    const { client, studio } = setup();
    const a = studio.seed({ content_md: "a" });
    const hopper = studio.addHopper("Reading");
    hopper.members.add(a.id);
    expect(await client.hopperMembers(hopper.id)).toEqual({ kind: "ok", value: { ids: [a.id], complete: true } });
    expect(studio.seen.at(-1)?.path).toBe(`/api/hoppers/${hopper.id}/memberships?limit=100`);
    expect(await client.listHoppers()).toMatchObject({ kind: "ok", value: [{ id: hopper.id, name: "Reading" }] });
  });

  it("says when the membership walk was cut off at its page cap, instead of passing a partial list off as the whole (review P6)", async () => {
    const { client, studio } = setup();
    const hopper = studio.addHopper("Big");
    for (let i = 0; i < 1005; i++) hopper.members.add(`m${i}`);
    const got = await client.hopperMembers(hopper.id);
    expect(got.kind).toBe("ok");
    if (got.kind === "ok") {
      expect(got.value.complete).toBe(false);
      expect(got.value.ids).toHaveLength(1000);
    }
  });
});

describe("the contract gate", () => {
  it("lets contract 5 through, and asks only once per session", async () => {
    const { client, studio } = setup();
    await client.countItems();
    await client.countItems();
    expect(studio.seen.filter((s) => s.path === "/api/capabilities")).toHaveLength(1);
  });

  it("accepts a higher minor of contract 5", async () => {
    const { client, studio } = setup();
    studio.contractVersion = "5.9.0";
    expect((await client.countItems()).kind).toBe("ok");
  });

  it("refuses every call, with nothing sent but the capabilities question, for an older contract", async () => {
    const { client, studio } = setup();
    studio.contractVersion = "4.0.0";
    const refused = await client.createItem({ kind: "fragment", contentMd: "x" });
    expect(refused).toMatchObject({ kind: "incompatible", which: "studio-older" });
    expect(refused.kind === "incompatible" && refused.message).toContain("0.51.0");
    expect((await client.getItem("a0000000000000000000000001")).kind).toBe("incompatible");
    expect(studio.seen.map((s) => s.path)).toEqual(["/api/capabilities"]);
  });

  it("treats a Studio with no /capabilities (before 0.49.7) as an older contract", async () => {
    const { client, studio } = setup();
    studio.contractVersion = null;
    expect(await client.publish("a0000000000000000000000001", undefined, 1)).toMatchObject({ kind: "incompatible", which: "studio-older" });
    expect(studio.writes()).toEqual([]);
  });

  it("refuses a newer major with 'update the plugin'", async () => {
    const { client, studio } = setup();
    studio.contractVersion = "6.0.0";
    const refused = await client.countItems();
    expect(refused).toMatchObject({ kind: "incompatible", which: "plugin-older" });
    expect(refused.kind === "incompatible" && refused.message).toContain("Update the plugin");
  });

  it("a bad token is the token's problem, not a contract problem, and is not remembered", async () => {
    const studio = new FakeStudio();
    const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" })!;
    const cache = createContractCache();
    const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: "wrong", gate: cache });
    expect((await client.countItems()).kind).toBe("unauthorized");
    expect(cache.get()).toBeUndefined();
  });

  it("keeps one verdict per Studio address in a shared store", () => {
    const store = new Map<string, ContractVerdict>();
    const a = contractCacheFor(store, "https://a.test/api");
    const b = contractCacheFor(store, "https://b.test/api");
    a.set({ kind: "ok", contract: "5.2.0", newerMinor: false });
    expect(b.get()).toBeUndefined();
    a.set(undefined);
    expect(a.get()).toBeUndefined();
  });
});
