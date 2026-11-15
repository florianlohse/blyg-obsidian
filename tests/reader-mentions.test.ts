// S15 chunk 2b: mentions shown like posts.
import { describe, expect, it } from "vitest";
import type { InboundMention, ReadingPost } from "../src/studio/reading";
import { limiter, mentionLead, postFromPeek, postOfMention, sameOrigin, visibleMentions } from "../src/ui/readerMentions";

const m = (over: Partial<InboundMention> = {}): InboundMention => ({ id: "m1", targetItemId: "t1", relation: "stub", status: "verified", hidden: false, sourceOrigin: "https://B.example/", sourceId: "x1", sourcePage: "https://b.example/x1/", sourceAuthorName: "Bea", firstSeen: "2026-11-10T10:00:00Z", ...over });
const post = (over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s1", subscriptionTitle: "B", origin: "https://b.example", remoteId: "x1", kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "<p>hi</p>", contentMd: "hi", authorName: null, authorUrl: null, sourceUrl: null, ...over });

describe("mentions as posts", () => {
  it("the same blyg is found whatever the case of the host or a closing slash", () => {
    expect(sameOrigin("https://B.example/", "https://b.example")).toBe(true);
    expect(sameOrigin("https://b.example", "https://c.example")).toBe(false);
    expect(sameOrigin(null, "https://b.example")).toBe(false);
  });
  it("a mention's post comes from the list when the Studio reads that blyg", () => {
    expect(postOfMention([post({ remoteId: "other" }), post()], m())?.remoteId).toBe("x1");
    expect(postOfMention([post({ origin: "https://c.example" })], m())).toBeNull();
    expect(postOfMention([post()], m({ sourceId: null }))).toBeNull();
  });
  it("a peek becomes a post; with no subscription it has no read mark's home, and a withdrawn one has no text", () => {
    const got = postFromPeek(m(), { origin: "https://b.example", id: "x1", kind: "thread", version: 2, contentHtml: "<p>t</p>", url: "https://b.example/x1/", subscriptionId: null });
    expect(got).toMatchObject({ subscriptionId: "", kind: "thread", version: 2, isReply: true, authorName: "Bea", sourceUrl: "https://b.example/x1/", withdrawn: false });
    const gone = postFromPeek(m(), { origin: "https://b.example", id: "x1", kind: "withdrawn", version: 3, contentHtml: "<p>secret</p>", url: "", subscriptionId: "s9" });
    expect(gone).toMatchObject({ withdrawn: true, contentHtml: "", subscriptionId: "s9", sourceUrl: "https://b.example/x1/" });
  });
  it("says in plain words who did what", () => {
    expect(mentionLead(m())).toBe("Bea replied to your item");
    expect(mentionLead(m({ relation: "transclusion", sourceAuthorName: null }))).toBe("b.example quoted your item");
    expect(mentionLead(m({ relation: null, sourceAuthorName: null, sourceOrigin: null }))).toBe("Someone mentioned your item");
  });
  it("shows verified and pending mentions the owner has not hidden, newest first", () => {
    const list = [m({ id: "a", firstSeen: "2026-11-01T00:00:00Z" }), m({ id: "b", hidden: true }), m({ id: "c", status: "failed" }), m({ id: "d", status: "gone" }), m({ id: "e", status: "pending", firstSeen: "2026-11-12T00:00:00Z" })];
    expect(visibleMentions(list).map((x) => x.id)).toEqual(["e", "a"]);
  });
  it("the limiter runs at most the given number of jobs at once and finishes them all", async () => {
    const run = limiter(2);
    let now = 0;
    let peak = 0;
    const job = async (): Promise<number> => {
      now++;
      peak = Math.max(peak, now);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      now--;
      return 1;
    };
    const done = await Promise.all(Array.from({ length: 7 }, () => run(job)));
    expect(done).toHaveLength(7);
    expect(peak).toBe(2);
  });
});
