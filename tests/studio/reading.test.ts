// PROOF OF CONCEPT (S15): the reader's row parsing: shapes the Studio sends (contract 5.x), and what is refused without guessing.
import { describe, expect, it } from "vitest";
import { isUnread, readInboundMention, readReadingPost, relationWords } from "../../src/studio/reading";

const row = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  subscriptionId: "sub1", subscriptionTitle: "Blog B", origin: "https://b.example/", remoteId: "abc", kind: "fragment", withdrawn: false, version: 2, readVersion: null,
  observedAt: "2026-11-12T10:00:00Z", contentHtml: "<p>hi</p>", contentMd: "hi", author: { name: "B", url: null }, sourceUrl: "https://b.example/f/abc", ...patch,
});

describe("readReadingPost", () => {
  it("reads a row of the reading list", () => {
    const p = readReadingPost(row());
    expect(p).toMatchObject({ subscriptionId: "sub1", remoteId: "abc", kind: "fragment", version: 2, authorName: "B", sourceUrl: "https://b.example/f/abc", origin: "https://b.example/" });
  });
  it("refuses rows that are not in the expected form, never guessing", () => {
    expect(readReadingPost(null)).toBeNull();
    expect(readReadingPost(row({ kind: "essay" }))).toBeNull();
    expect(readReadingPost(row({ version: "2" }))).toBeNull();
    expect(readReadingPost(row({ contentHtml: undefined }))).toBeNull();
    expect(readReadingPost(row({ remoteId: "" }))).toBeNull();
  });
  it("copes with missing optional parts", () => {
    const p = readReadingPost(row({ author: null, sourceUrl: null, page: null, contentMd: undefined, subscriptionTitle: undefined, origin: undefined }));
    expect(p).toMatchObject({ authorName: null, sourceUrl: null, contentMd: "", subscriptionTitle: "", origin: null });
  });
  it("unread means no read mark, or a newer version than the one read; a withdrawn post is never unread", () => {
    const at = (patch: Record<string, unknown>) => readReadingPost(row(patch))!;
    expect(isUnread(at({ readVersion: null }))).toBe(true);
    expect(isUnread(at({ readVersion: 1, version: 2 }))).toBe(true);
    expect(isUnread(at({ readVersion: 2, version: 2 }))).toBe(false);
    expect(isUnread(at({ withdrawn: true }))).toBe(false);
  });
});

describe("readInboundMention", () => {
  const m = (patch: Record<string, unknown> = {}) => ({ id: "m1", targetItemId: "t1", status: "verified", relation: "stub", hidden: false, sourceOrigin: "https://x.example/", sourceId: "s1", sourcePage: "https://x.example/f/s1", sourceAuthor: { name: "X" }, firstSeen: "2026-11-12T09:00:00Z", ...patch });
  it("reads the fields a 'who answered what' inbox needs", () => {
    expect(readInboundMention(m())).toMatchObject({ id: "m1", relation: "stub", status: "verified", hidden: false, sourceAuthorName: "X", sourcePage: "https://x.example/f/s1" });
  });
  it("an unknown relation reads as null (said as 'mentioned'), an unknown status is refused", () => {
    expect(readInboundMention(m({ relation: "echo" }))?.relation).toBeNull();
    expect(readInboundMention(m({ status: "weird" }))).toBeNull();
    expect(readInboundMention(m({ id: undefined }))).toBeNull();
  });
  it("says the relation in plain words", () => {
    expect(["stub", "transclusion", "fork", "source", null].map((r) => relationWords(r as never))).toEqual(["replied to", "quoted", "forked", "cited", "mentioned"]);
  });
});
