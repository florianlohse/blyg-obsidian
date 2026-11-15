// S15: the reader's list kept between sessions: what is written, and how little of what is read back is trusted.
import { describe, expect, it } from "vitest";
import type { InboundMention, ReadingPost } from "../src/studio/reading";
import { CACHE_MAX_AGE_MS, CACHE_POSTS, parseReaderCache, readerCacheOf } from "../src/ui/readerCache";

const post = (i: number, over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "S", origin: "https://b.example", remoteId: `r${i}`, kind: "fragment", withdrawn: false, version: 1, readVersion: i % 2 ? 1 : null, observedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), created: null, isReply: false, stubTarget: { origin: "https://b.example", id: "x" }, contentHtml: `<p>${i}</p>`, contentMd: "secret markdown", authorName: "A", authorUrl: null, sourceUrl: null, ...over });
const mention: InboundMention = { id: "m1", targetItemId: "t1", relation: "stub", status: "verified", hidden: false, sourceOrigin: "https://far.example", sourceId: "z", sourcePage: null, sourceAuthorName: "Far", firstSeen: "2026-11-10T00:00:00Z" };
const NOW = Date.UTC(2026, 10, 15);
const ORIGIN = "https://studio.example";

describe("what is written", () => {
  it("is the newest posts without their Markdown, and the mentions", () => {
    const file = readerCacheOf(Array.from({ length: 300 }, (_, i) => post(i)), [mention], ORIGIN, NOW);
    expect(file.posts).toHaveLength(CACHE_POSTS);
    expect(file.posts[0]?.remoteId).toBe("r299");
    expect(file.posts.every((p) => p.contentMd === "")).toBe(true);
    expect(file.mentions).toEqual([mention]);
    expect(JSON.stringify(file)).not.toContain("secret markdown");
  });
});

describe("what is read back", () => {
  const file = (over: Record<string, unknown> = {}): unknown => ({ ...readerCacheOf([post(1), post(2)], [mention], ORIGIN, NOW), ...over });
  it("round-trips through JSON, as far as the reader uses it", () => {
    const got = parseReaderCache(JSON.parse(JSON.stringify(file())), ORIGIN, NOW + 1000);
    expect(got?.posts.map((p) => [p.remoteId, p.readVersion, p.stubTarget])).toEqual([["r2", null, { origin: "https://b.example", id: "x" }], ["r1", 1, { origin: "https://b.example", id: "x" }]]);
    expect(got?.mentions).toEqual([mention]);
  });
  it("is refused for another Studio, when too old, from the future, or not ours", () => {
    expect(parseReaderCache(file(), "https://other.example", NOW)).toBeNull();
    expect(parseReaderCache(file(), ORIGIN, NOW + CACHE_MAX_AGE_MS + 1)).toBeNull();
    expect(parseReaderCache(file({ savedAt: NOW + 10 * 60_000 }), ORIGIN, NOW)).toBeNull();
    for (const bad of [null, undefined, "x", 3, [], {}, { v: 2 }, { v: 1, origin: ORIGIN, savedAt: NOW, posts: "no" }, file({ posts: [] })]) expect(parseReaderCache(bad, ORIGIN, NOW), JSON.stringify(bad)).toBeNull();
  });
  it("drops rows that are not posts, and rebuilds the rest from checked fields only", () => {
    const rows = [{ subscriptionId: "s", remoteId: "ok", kind: "thread", version: 2, contentHtml: "<p>x</p>", unknownField: "<script>", contentMd: "should not survive" }, { remoteId: "no-sub", kind: "fragment", version: 1, contentHtml: "" }, null, 7, { subscriptionId: "s", remoteId: "bad-kind", kind: "essay", version: 1, contentHtml: "" }];
    const got = parseReaderCache({ v: 1, origin: ORIGIN, savedAt: NOW, posts: rows, mentions: [{ id: "m", targetItemId: "t", status: "verified" }, { id: "x" }, "no"] }, ORIGIN, NOW);
    expect(got?.posts).toHaveLength(1);
    expect(got?.posts[0]).toMatchObject({ remoteId: "ok", kind: "thread", version: 2, contentMd: "", readVersion: null, withdrawn: false, subscriptionTitle: "" });
    expect(JSON.stringify(got)).not.toContain("<script>");
    expect(got?.mentions).toHaveLength(1);
  });
});
