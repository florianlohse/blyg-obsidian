// RC1: a quote of one of your own items opens that item in the reader as your own post; Back keeps the place in the post you left.
import { describe, expect, it } from "vitest";
import { ownPostOfItem, ownSourceText } from "../src/ui/readerOwnPost";
import { Trail } from "../src/ui/readerTrail";
import type { StudioItem } from "../src/studio/types";
import type { ReadingPost } from "../src/studio/reading";

const item = (patch: Partial<StudioItem> = {}): StudioItem => ({ id: "7c2d9fqk3m8x5r1n6t0vbhwy4z", revision: 2, kind: "fragment", status: "public", version: 3, contentMd: "Working copy.", dirty: false, stubOf: null, created: "2026-11-01T10:00:00Z", updated: "2026-11-02T10:00:00Z", published: { version: 3, contentMd: "Published.", contentHtml: "<p>Published.</p>", contentHash: "h", note: null }, ...patch });

describe("ownPostOfItem", () => {
  it("is your own post (the one the detail view gives an Open note button) with the published text", () => {
    const p = ownPostOfItem(item());
    expect(p).toMatchObject({ own: true, remoteId: "7c2d9fqk3m8x5r1n6t0vbhwy4z", subscriptionId: "", origin: null, contentHtml: "<p>Published.</p>", withdrawn: false, kind: "fragment" });
    expect(p?.readVersion).toBe(p?.version); // never unread
  });
  it("falls back to the working copy, escaped, as paragraphs", () => {
    const p = ownPostOfItem(item({ published: null, status: "draft", version: 0, contentMd: "One <b>&</b>\n\nTwo" }));
    expect(p?.contentHtml).toBe("<p>One &lt;b&gt;&amp;&lt;/b&gt;</p><p>Two</p>");
    expect(p?.version).toBe(1);
  });
  it("is null when there is nothing to show, and marks a withdrawn item", () => {
    expect(ownPostOfItem(item({ published: null, contentMd: "  " }))).toBeNull();
    expect(ownPostOfItem(item({ status: "withdrawn" }))?.withdrawn).toBe(true);
  });
});

describe("ownSourceText", () => {
  it("names you, with the author's label when there is one", () => {
    expect(ownSourceText("")).toBe("You, in your own item");
    expect(ownSourceText("my words")).toBe("You, in your own item · my words");
  });
});

describe("Trail", () => {
  const post = (id: string) => ({ remoteId: id }) as ReadingPost;
  it("gives back the last post with the place you left it, then the one before", () => {
    const t = new Trail();
    t.push(post("a"), 120); t.push(post("b"), -5);
    expect(t.length).toBe(2);
    expect(t.pop()).toMatchObject({ post: { remoteId: "b" }, top: 0 });
    expect(t.pop()).toMatchObject({ post: { remoteId: "a" }, top: 120 });
    expect(t.pop()).toBeUndefined();
  });
  it("clears", () => {
    const t = new Trail(); t.push(post("a"), 1); t.clear();
    expect(t.length).toBe(0);
  });
});
