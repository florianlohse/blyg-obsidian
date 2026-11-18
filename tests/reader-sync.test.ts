// S15: how the reader keeps its list current without reading more than it must (ui/readerSync.ts).
import { describe, expect, it } from "vitest";
import type { ReadingPost } from "../src/studio/reading";
import { backoffDelay, changedCount, chooseWalk, FULL_GAP_MS, keepOwnPosts, knownOf, mergeFresh, reachedKnown, SAFETY_MS, signature } from "../src/ui/readerSync";

const post = (id: string, over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "S", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2026-11-10T00:00:00Z", created: null, isReply: false, contentHtml: "<p>x</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });

describe("a page that ends in known territory", () => {
  const held = [post("a", { observedAt: "2026-11-03T00:00:00Z" }), post("b", { observedAt: "2026-11-02T00:00:00Z" }), post("c", { observedAt: "2026-11-01T00:00:00Z" })];
  const known = knownOf(held);
  it("stops the walk when the oldest row of the page is held, unchanged", () => {
    expect(reachedKnown([post("n", { observedAt: "2026-11-04T00:00:00Z" }), held[0] as ReadingPost, held[1] as ReadingPost], known)).toBe(true);
    expect(reachedKnown([], known)).toBe(false);
  });
  it("goes on when the oldest row is new, a newer version, or has a different read mark or was withdrawn", () => {
    expect(reachedKnown([post("n")], known)).toBe(false);
    expect(reachedKnown([post("c", { version: 2 })], known)).toBe(false);
    expect(reachedKnown([post("c", { readVersion: 1 })], known)).toBe(false);
    expect(reachedKnown([post("c", { withdrawn: true })], known)).toBe(false);
    expect(signature(post("c"))).not.toBe(signature(post("c", { readVersion: 1 })));
  });
  it("counts what is new or changed", () => {
    expect(changedCount([post("n"), post("a", { observedAt: "2026-11-03T00:00:00Z" }), post("b", { version: 2 })], known)).toBe(2);
  });
});

describe("mergeFresh", () => {
  it("lets the fresh row win, keeps the rest, newest first", () => {
    const held = [post("a", { observedAt: "2026-11-03T00:00:00Z" }), post("b", { observedAt: "2026-11-02T00:00:00Z" })];
    const fresh = [post("n", { observedAt: "2026-11-05T00:00:00Z" }), post("b", { observedAt: "2026-11-04T00:00:00Z", version: 2 })];
    const got = mergeFresh(held, fresh);
    expect(got.map((p) => p.remoteId)).toEqual(["n", "b", "a"]);
    expect(got[1]?.version).toBe(2);
  });
  it("keeps at most the given number, the newest", () => {
    const held = Array.from({ length: 10 }, (_, i) => post(`p${i}`, { observedAt: `2026-11-${String(10 + i).padStart(2, "0")}T00:00:00Z` }));
    expect(mergeFresh(held, [], 3).map((p) => p.remoteId)).toEqual(["p9", "p8", "p7"]);
  });
  it("copes with rows that have no date", () => {
    expect(mergeFresh([post("a", { observedAt: "" })], [post("b", { observedAt: "" })]).map((p) => p.remoteId).sort()).toEqual(["a", "b"]);
  });
});

describe("chooseWalk", () => {
  const m = (over: Partial<{ lastFullAt: number; readingMoved: boolean; movedWithoutNew: boolean }> = {}) => ({ lastFullAt: 1_000_000, readingMoved: false, movedWithoutNew: false, ...over });
  const now = 1_000_000 + 5 * 60_000;
  it("reads the whole window when nothing is held", () => expect(chooseWalk(m({ lastFullAt: 0 }), now, false)).toBe("full"));
  it("reads only the newest rows otherwise", () => expect(chooseWalk(m(), now, true)).toBe("incremental"));
  it("reads the whole window as a safety net, once something has moved and ten minutes have passed", () => {
    expect(chooseWalk(m({ readingMoved: true }), 1_000_000 + SAFETY_MS - 1, true)).toBe("incremental");
    expect(chooseWalk(m({ readingMoved: true }), 1_000_000 + SAFETY_MS, true)).toBe("full");
    expect(chooseWalk(m(), 1_000_000 + 10 * SAFETY_MS, true)).toBe("incremental"); // nothing moved: no reason
  });
  it("reads the whole window when only read marks seem to have moved, at most once a minute", () => {
    expect(chooseWalk(m({ movedWithoutNew: true }), 1_000_000 + FULL_GAP_MS - 1, true)).toBe("incremental");
    expect(chooseWalk(m({ movedWithoutNew: true }), 1_000_000 + FULL_GAP_MS, true)).toBe("full");
  });
  it("honours a person's Refresh, but not more than once a minute", () => {
    expect(chooseWalk(m(), 1_000_000 + 10_000, true, true)).toBe("incremental");
    expect(chooseWalk(m(), 1_000_000 + FULL_GAP_MS, true, true)).toBe("full");
  });
});

describe("backoffDelay", () => {
  it("is 30 s, doubling, at most 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(backoffDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
    expect(backoffDelay(0)).toBe(30_000);
  });
});

describe("keepOwnPosts (a quick read must not drop the owner's own posts)", () => {
  const mine = post("m1", { own: true, subscriptionId: "" });
  it("adds the held own posts to a fresh list that has none", () => {
    expect(keepOwnPosts([post("a"), mine], [post("b")]).map((p) => p.remoteId)).toEqual(["b", "m1"]);
  });
  it("leaves a fresh list that brings its own posts as it is", () => {
    const fresh = [post("b"), { ...mine, remoteId: "m2" }];
    expect(keepOwnPosts([mine], fresh)).toBe(fresh);
  });
  it("changes nothing when none are held", () => {
    const fresh = [post("b")];
    expect(keepOwnPosts([post("a")], fresh)).toBe(fresh);
  });
});
