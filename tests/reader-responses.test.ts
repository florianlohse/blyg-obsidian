// S15: the replies to a post that the reader can see (the owner's own, and posts of blygs the Studio reads).
import { describe, expect, it } from "vitest";
import { readReadingPost, type ReadingPost } from "../src/studio/reading";
import type { StudioListedItem } from "../src/studio/types";
import { responseChip, responsesTo } from "../src/ui/readerResponses";

const post = (over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s1", subscriptionTitle: "B", origin: "https://b.example", remoteId: "p1", kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2026-11-01T00:00:00Z", created: "2026-11-01T00:00:00Z", isReply: false, contentHtml: "<p>x</p>", contentMd: "x", authorName: null, authorUrl: null, sourceUrl: null, ...over });
const mine = (id: string, stub: unknown, when = "2026-11-05T00:00:00Z", status: "draft" | "public" = "public"): StudioListedItem => ({ id, revision: 1, kind: "thread", status, version: status === "draft" ? 0 : 1, contentMd: `my words ${id}`, dirty: false, stubOf: stub as StudioListedItem["stubOf"], published: null, created: when });
const target = post();

describe("responsesTo", () => {
  it("finds the owner's replies by the stub's origin and id (case and a closing slash of the origin do not matter)", () => {
    const items = [mine("m1", { origin: "https://B.example/", id: "p1", version: 1 }), mine("m2", { origin: "https://b.example", id: "other", version: 1 }), mine("m3", null), mine("m4", { url: "https://web.example/x" })];
    expect(responsesTo(target, items, []).map((e) => (e.kind === "mine" ? e.itemId : ""))).toEqual(["m1"]);
  });
  it("finds posts of blygs the Studio reads that answer it, but not the post itself or a withdrawn one", () => {
    const a = post({ subscriptionId: "s2", remoteId: "r1", stubTarget: { origin: "https://b.example", id: "p1" } });
    const gone = post({ subscriptionId: "s2", remoteId: "r2", withdrawn: true, stubTarget: { origin: "https://b.example", id: "p1" } });
    const self = post({ stubTarget: { origin: "https://b.example", id: "p1" } });
    const elsewhere = post({ subscriptionId: "s3", remoteId: "r3", stubTarget: { origin: "https://c.example", id: "p1" } });
    expect(responsesTo(target, [], [a, gone, self, elsewhere, target]).map((e) => (e.kind === "read" ? e.post.remoteId : ""))).toEqual(["r1"]);
  });
  it("needs the post's origin to match anything, and lists the newest first, yours among them", () => {
    expect(responsesTo(post({ origin: null }), [mine("m1", { origin: "https://b.example", id: "p1", version: 1 })], [])).toEqual([]);
    const a = post({ subscriptionId: "s2", remoteId: "r1", created: "2026-11-09T00:00:00Z", stubTarget: { origin: "https://b.example", id: "p1" } });
    const got = responsesTo(target, [mine("m1", { origin: "https://b.example", id: "p1", version: 1 }, "2026-11-05T00:00:00Z", "draft")], [a]);
    expect(got.map((e) => e.kind)).toEqual(["read", "mine"]);
    expect(got[1]).toMatchObject({ kind: "mine", draft: true });
  });
});

describe("responseChip", () => {
  const m = { kind: "mine", itemId: "m", text: "", when: "", draft: false } as const;
  const r = { kind: "read", post: post(), when: "" } as const;
  it("is nothing when there is nothing to see", () => expect(responseChip([])).toBeNull());
  it("is green and says \"You\" when the owner replied, with how many more there are", () => {
    expect(responseChip([m])).toMatchObject({ text: "You replied", mine: true });
    expect(responseChip([m, m])).toMatchObject({ text: "You replied ×2", mine: true });
    expect(responseChip([m, r, r])).toMatchObject({ text: "You + 2", mine: true });
  });
  it("is a plain count of replies in blygs you read otherwise", () => {
    expect(responseChip([r])).toMatchObject({ text: "1 reply", mine: false });
    expect(responseChip([r, r, r])).toMatchObject({ text: "3 replies", mine: false });
  });
});

describe("a reading row's stub", () => {
  const row = (stubOf: unknown): unknown => ({ subscriptionId: "s", remoteId: "r", kind: "fragment", version: 1, contentHtml: "<p>x</p>", stubOf });
  it("keeps what a reply answers when it is an item of a blyg, and nothing for the plain web or no stub", () => {
    expect(readReadingPost(row({ origin: "https://b.example", id: "p1", version: 2 }))?.stubTarget).toEqual({ origin: "https://b.example", id: "p1" });
    expect(readReadingPost(row({ url: "https://web.example/x" }))?.stubTarget).toBeNull();
    expect(readReadingPost(row(null))?.stubTarget).toBeNull();
    expect(readReadingPost(row({ origin: "https://b.example", id: "p1", version: 2 }))?.isReply).toBe(true);
  });
});
