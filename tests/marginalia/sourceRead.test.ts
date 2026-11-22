// HK3: the two-step read of a source post's Markdown (peek -> imported item), against the fake Studio, through the lookup's cap and cache.
import { describe, expect, it } from "vitest";
import { MarginaliaLookup, type MarginaliaMention } from "../../src/marginalia/lookup";
import { parseQuotesOf } from "../../src/marginalia/reception";
import { makeSourceReader } from "../../src/marginalia/sourceRead";
import { createStudioClient } from "../../src/studio/client";
import { studioAddress } from "../../src/studio/address";
import { createStudioHttp } from "../../src/studio/http";
import { idleTimers } from "../helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "../studio/fake-studio";

const ITEM = "01hq0000000000000000000000".replace(/0/g, "a").slice(0, 26);
const SRC = "095s4h48j67mnbf6hq8vatc2d4";
const ORIGIN = "https://blog-b.test/";
const quote = `Intro.\n\n![[${ITEM}]]\n> the quoted words here\n`;

function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  const lookup = new MarginaliaLookup(makeSourceReader({ client: () => client, heldPost: () => Promise.resolve(null) }), parseQuotesOf);
  const imports = () => studio.seen.filter((s) => s.path.startsWith("/api/imports/"));
  return { studio, lookup, imports };
}
const mention = (over: Partial<MarginaliaMention> = {}): MarginaliaMention => ({ id: "m1", targetItemId: ITEM, relation: "transclusion", status: "verified", hidden: false, sourceOrigin: ORIGIN, sourceId: SRC, sourcePage: null, sourceAuthorName: "Teo", firstSeen: "2026-11-10T10:00:00Z", ...over });

describe("reading a source's Markdown from the Studio", () => {
  it("ok: the imported item's Markdown reaches the parser", async () => {
    const { studio, lookup } = setup();
    studio.importItem({ remote_id: SRC, content_md: quote, version: 2 });
    const [e] = await lookup.lookup([mention()], ITEM);
    expect(e!.result).toEqual({ kind: "quotes", version: 2, quotes: [{ kind: "passage", text: "the quoted words here" }] });
  });
  it("a blyg the Studio does not import is unknown, not an empty list", async () => {
    const { studio, lookup } = setup();
    studio.peekable.push({ origin: ORIGIN, id: SRC, kind: "fragment", version: 1, content_html: "<p>x</p>" });
    const [e] = await lookup.lookup([mention()], ITEM);
    expect(e!.result).toEqual({ kind: "unknown", reason: "unreadable" });
  });
  it("a withdrawn post is unknown (withdrawn), by its peek and by its tombstone", async () => {
    const a = setup();
    a.studio.peekable.push({ origin: ORIGIN, id: SRC, kind: "withdrawn", version: 3, content_html: "" });
    expect((await a.lookup.lookup([mention()], ITEM))[0]!.result).toEqual({ kind: "unknown", reason: "withdrawn" });
    const b = setup();
    b.studio.importItem({ remote_id: SRC, content_md: quote, state: "tombstone" });
    expect((await b.lookup.lookup([mention()], ITEM))[0]!.result).toEqual({ kind: "unknown", reason: "withdrawn" });
  });
  it("a 403 on the imported-item read is unknown", async () => {
    const { studio, lookup } = setup();
    studio.importItem({ remote_id: SRC, content_md: quote });
    studio.forced.set(`GET /api/imports/sub1/${SRC}`, { status: 403, text: "{}" });
    expect((await lookup.lookup([mention()], ITEM))[0]!.result).toEqual({ kind: "unknown", reason: "unreadable" });
  });
  it("counts against the cap of lookups, and is cached per (source, version)", async () => {
    const { studio, lookup, imports } = setup();
    const ids = ["095s4h48j67mnbf6hq8vatc2d1", "095s4h48j67mnbf6hq8vatc2d2", "095s4h48j67mnbf6hq8vatc2d3"];
    ids.forEach((id) => studio.importItem({ remote_id: id, content_md: quote, version: 1 }));
    const ms = ids.map((id, i) => mention({ id: `m${i}`, sourceId: id, firstSeen: `2026-11-0${3 - i}T00:00:00Z`, sourceVersion: 1 }));
    const first = await lookup.lookup(ms, ITEM, { cap: 2 });
    expect(first.map((e) => e.result.kind)).toEqual(["quotes", "quotes", "unknown"]);
    expect(first[2]!.result).toEqual({ kind: "unknown", reason: "over-cap" });
    expect(imports()).toHaveLength(2);
    await lookup.lookup(ms, ITEM, { cap: 2 });
    expect(imports()).toHaveLength(2); // the same versions: answered from the cache, no request
    studio.importItem({ remote_id: ids[0]!, content_md: quote, version: 2 });
    await lookup.lookup([{ ...ms[0]!, sourceVersion: 2 }], ITEM);
    expect(imports().length).toBeGreaterThan(2); // a new version is read again
  });
});
