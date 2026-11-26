// HK3 stage 1: the lookup against a fake source reader and a fake parser (the real parser lives in src/core/quoteRefs.ts).
import { describe, expect, it } from "vitest";
import { MarginaliaLookup, quotingMentions, type FoundQuote, type MarginaliaMention, type QuoteParser, type SourcePost, type SourceReader } from "../../src/marginalia/lookup";

const m = (over: Partial<MarginaliaMention> = {}): MarginaliaMention => ({ id: "m1", targetItemId: "t1", relation: "transclusion", status: "verified", hidden: false, sourceOrigin: "https://b.example/", sourceId: "x1", sourcePage: null, sourceAuthorName: "Bea", firstSeen: "2026-11-10T10:00:00Z", ...over });
// Fake parser: a line "Q:<text>" is a passage, "WHOLE" is a whole-post quote.
const parse: QuoteParser = (md) => md.split("\n").flatMap((l): FoundQuote[] => (l === "WHOLE" ? [{ kind: "whole" }] : l.startsWith("Q:") ? [{ kind: "passage", text: l.slice(2) }] : []));
const post = (markdown: string | null, over: Partial<SourcePost> = {}): SourcePost => ({ version: 1, markdown, withdrawn: false, ...over });

function fake(posts: Record<string, SourcePost | null | "throw">): { read: SourceReader; calls: string[] } {
  const calls: string[] = [];
  const read: SourceReader = async (x) => {
    calls.push(x.sourceId ?? "");
    const p = posts[x.sourceId ?? ""];
    if (p === "throw") throw new Error("boom");
    return p ?? null;
  };
  return { read, calls };
}

describe("quotingMentions", () => {
  it("keeps verified, visible quotes and replies of the item, newest first", () => {
    const got = quotingMentions([m({ id: "a", firstSeen: "2026-01-01" }), m({ id: "b", firstSeen: "2026-03-01" }), m({ id: "c", relation: "stub", firstSeen: "2026-02-01" }), m({ id: "d", hidden: true }), m({ id: "e", status: "failed" }), m({ id: "f", targetItemId: "other" }), m({ id: "g", sourceId: null })], "t1");
    expect(got.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
  // Measured on a real Studio 0.51.0 (2026-11-26): a thread with `stub_of` is a `stub` mention even when its text also quotes the item with a directive.
  it("a reply (relation stub) is looked up: its text may quote the item", () => {
    expect(quotingMentions([m({ relation: "stub" })], "t1")).toHaveLength(1);
  });
  it("forks, sources and a relation the Studio did not give are not quotes", () => {
    expect(quotingMentions([m({ relation: "fork" }), m({ relation: "source" }), m({ relation: null })], "t1")).toEqual([]);
  });
});

describe("MarginaliaLookup", () => {
  it("parses passages and whole-post quotes from the source post", async () => {
    const { read } = fake({ x1: post("intro\nQ:a line\nWHOLE") });
    const [e] = await new MarginaliaLookup(read, parse).lookup([m()], "t1");
    expect(e!.result).toMatchObject({ kind: "quotes", version: 1, quotes: [{ kind: "passage", text: "a line" }, { kind: "whole" }] });
  });
  it("a reply whose text quotes a passage gives the passage; a reply with no quote gives no quotes (it is a reply, not an unknown)", async () => {
    const { read } = fake({ x1: post("Q:a line"), x2: post("just my answer") });
    const got = await new MarginaliaLookup(read, parse).lookup([m({ relation: "stub", firstSeen: "2" }), m({ id: "m2", relation: "stub", sourceId: "x2", firstSeen: "1" })], "t1");
    expect(got.map((e) => e.result)).toMatchObject([{ kind: "quotes", version: 1, quotes: [{ kind: "passage", text: "a line" }] }, { kind: "quotes", version: 1, quotes: [] }]);
  });
  it("a quote (relation transclusion) whose text shows no quote stays unknown: the Studio said it quoted", async () => {
    const { read } = fake({ x1: post("just words") });
    const [e] = await new MarginaliaLookup(read, parse).lookup([m()], "t1");
    expect(e!.result).toEqual({ kind: "unknown", reason: "no-text" });
  });
  it("a failed read is unknown, never an empty list", async () => {
    const { read } = fake({ x1: null, x2: "throw" });
    const got = await new MarginaliaLookup(read, parse).lookup([m(), m({ id: "m2", sourceId: "x2" })], "t1");
    expect(got).toHaveLength(2);
    expect(got.map((e) => e.result)).toEqual([{ kind: "unknown", reason: "unreadable" }, { kind: "unknown", reason: "unreadable" }]);
  });
  it("no Markdown (a peek has HTML only), a withdrawn post and a text that shows no quote are unknown too", async () => {
    const { read } = fake({ x1: post(null), x2: post("Q:x", { withdrawn: true }), x3: post("nothing here") });
    const got = await new MarginaliaLookup(read, parse).lookup([m({ firstSeen: "3" }), m({ id: "m2", sourceId: "x2", firstSeen: "2" }), m({ id: "m3", sourceId: "x3", firstSeen: "1" })], "t1");
    expect(got.map((e) => e.result)).toEqual([{ kind: "unknown", reason: "no-text" }, { kind: "unknown", reason: "withdrawn" }, { kind: "unknown", reason: "no-text" }]);
  });
  it("a parser that throws is unknown", async () => {
    const { read } = fake({ x1: post("Q:x") });
    const [e] = await new MarginaliaLookup(read, () => { throw new Error("bad"); }).lookup([m()], "t1");
    expect(e!.result).toEqual({ kind: "unknown", reason: "no-text" });
  });
  it("looks up at most `cap` posts; the rest are listed as unknown, not dropped", async () => {
    const { read, calls } = fake({ a: post("Q:1"), b: post("Q:2"), c: post("Q:3") });
    const ms = ["a", "b", "c"].map((id, i) => m({ id, sourceId: id, firstSeen: `2026-01-0${3 - i}` }));
    const got = await new MarginaliaLookup(read, parse).lookup(ms, "t1", { cap: 2 });
    expect(calls.sort()).toEqual(["a", "b"]);
    expect(got.map((e) => e.result.kind)).toEqual(["quotes", "quotes", "unknown"]);
    expect(got[2]!.result).toEqual({ kind: "unknown", reason: "over-cap" });
  });
  it("remembers an answer per (post, version): known version means no request; a new version is read again", async () => {
    const { read, calls } = fake({ x1: post("Q:v1") });
    const l = new MarginaliaLookup(read, parse);
    await l.lookup([m()], "t1");
    await l.lookup([m({ sourceVersion: 1 })], "t1");
    expect(calls).toEqual(["x1"]);
    await l.lookup([m({ sourceVersion: 2 })], "t1");
    expect(calls).toEqual(["x1", "x1"]);
  });
  it("does not cache a failure", async () => {
    const posts: Record<string, SourcePost | null> = { x1: null };
    const { read, calls } = fake(posts);
    const l = new MarginaliaLookup(read, parse);
    await l.lookup([m({ sourceVersion: 1 })], "t1");
    posts.x1 = post("Q:ok");
    const [e] = await l.lookup([m({ sourceVersion: 1 })], "t1");
    expect(calls).toHaveLength(2);
    expect(e!.result.kind).toBe("quotes");
  });
});
