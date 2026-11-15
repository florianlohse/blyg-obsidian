// S15, the reader's feed: cards, order and filters, and whether a post's page may be shown inside Obsidian. Pure functions.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readReadingPost, type ReadingPost } from "../src/studio/reading";
import { activeFilters, arrange, cardOf, DEFAULT_FILTER, framePolicy, frameable, nextAfter, readingMinutes, readingTimeLabel, relativeTime, sourcesOf } from "../src/ui/readerFeed";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/studio/reader/${name}-0.51.0.html`, import.meta.url), "utf8");
const post = (patch: Record<string, unknown>): ReadingPost =>
  readReadingPost({ subscriptionId: "s1", subscriptionTitle: "Blog A", origin: "https://a.example/", remoteId: "r1", kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2026-11-10T10:00:00Z", created: null, contentHtml: "<p>x</p>", ...patch })!;

describe("cardOf", () => {
  it("a thread: the quoted words apart from the author's own, from real Studio output", () => {
    expect(cardOf({ contentHtml: fixture("imported-thread-partial") })).toEqual({ quote: "It has a quotable sentence.", words: "My own words under a partial quote, with a link.", images: 0 });
  });
  it("a fragment with an image: its words, and the image counted, not loaded", () => {
    expect(cardOf({ contentHtml: fixture("imported-image") })).toEqual({ quote: null, words: "A post with a picture.", images: 1 });
  });
  it("long words are cut with an ellipsis", () => {
    const c = cardOf({ contentHtml: `<p>${"word ".repeat(200)}</p>` }, 50);
    expect(c.words.length).toBeLessThanOrEqual(50);
    expect(c.words.endsWith("…")).toBe(true);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  it.each([
    ["2026-11-13T11:59:30Z", "just now"], ["2026-11-13T11:55:00Z", "5 min ago"], ["2026-11-13T09:00:00Z", "3 h ago"],
    ["2026-11-12T10:00:00Z", "yesterday"], ["2026-11-09T12:00:00Z", "4 days ago"], ["2026-10-01T12:00:00Z", "2026-10-01"],
  ])("%s → %s", (iso, want) => expect(relativeTime(iso, now)).toBe(want));
  it("an unknown or broken date says nothing", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("arrange", () => {
  const a = post({ remoteId: "a", created: "2026-11-01T00:00:00Z" });
  const b = post({ remoteId: "b", created: null, observedAt: "2026-11-05T00:00:00Z", subscriptionId: "s2", subscriptionTitle: "Blog B" });
  const c = post({ remoteId: "c", created: "2026-11-03T00:00:00Z", readVersion: 1 });
  it("newest first by the author's date, else when the Studio saw it", () => {
    expect(arrange([a, b, c], DEFAULT_FILTER).map((p) => p.remoteId)).toEqual(["b", "c", "a"]);
  });
  it("oldest first", () => {
    expect(arrange([a, b, c], { ...DEFAULT_FILTER, sort: "oldest" }).map((p) => p.remoteId)).toEqual(["a", "c", "b"]);
  });
  it("one blyg", () => {
    expect(arrange([a, b, c], { ...DEFAULT_FILTER, source: "s2" }).map((p) => p.remoteId)).toEqual(["b"]);
  });
  it("unread only (c was read)", () => {
    expect(arrange([a, b, c], { ...DEFAULT_FILTER, unreadOnly: true }).map((p) => p.remoteId)).toEqual(["b", "a"]);
  });
  it("the source picker lists each blyg once, with its count, by title", () => {
    expect(sourcesOf([a, b, c])).toEqual([{ id: "s1", title: "Blog A", count: 2 }, { id: "s2", title: "Blog B", count: 1 }]);
  });
});

describe("framePolicy: may the page be shown inside Obsidian?", () => {
  it.each([
    [{}, "allowed"],
    [{ "Content-Type": "text/html" }, "allowed"],
    [{ "X-Frame-Options": "DENY" }, "forbidden"],
    [{ "x-frame-options": "SAMEORIGIN" }, "forbidden"],
    [{ "Content-Security-Policy": "frame-ancestors 'none'" }, "forbidden"],
    [{ "content-security-policy": "default-src 'self'; frame-ancestors 'self' https://a.example" }, "forbidden"],
    [{ "Content-Security-Policy": "frame-ancestors *" }, "allowed"],
    [{ "Content-Security-Policy": "default-src 'self'" }, "allowed"],
  ] as const)("%j → %s", (headers, want) => expect(framePolicy(headers)).toBe(want));
});

describe("frameable", () => {
  it("only absolute http(s) addresses", () => {
    expect(["https://a.example/f/x/", "http://localhost:8788/f/x/"].every(frameable)).toBe(true);
    expect([null, "", "f/x/", "javascript:alert(1)", "file:///x", "data:text/html,x", "app://obsidian.md/x"].some(frameable)).toBe(false);
  });
});

describe("reading time", () => {
  const words = (n: number): string => `<p>${"word ".repeat(n)}</p>`;
  it.each([[1, 1], [100, 1], [230, 1], [345, 2], [460, 2], [1150, 5], [1400, 6], [4600, 20]])("%i words take %i min", (n, want) => expect(readingMinutes({ contentHtml: words(n) })).toBe(want));
  it("is at least a minute, even for an empty post", () => {
    expect(readingMinutes({ contentHtml: "" })).toBe(1);
    expect(readingTimeLabel({ contentHtml: words(10) })).toBe("1 min read");
  });
  it("counts what is read, not the markup", () => {
    expect(readingMinutes({ contentHtml: `<p class="${"x".repeat(5000)}">${"word ".repeat(10)}</p>` })).toBe(1);
  });
  it("follows an edited post (the same object with new text)", () => {
    const p = { contentHtml: words(10) };
    expect(readingMinutes(p)).toBe(1);
    p.contentHtml = words(1200);
    expect(readingMinutes(p)).toBe(5);
  });
});

describe("sorting and filtering by reading time", () => {
  const long = post({ remoteId: "L", created: "2026-11-01T00:00:00Z", contentHtml: `<p>${"word ".repeat(1400)}</p>` }); // 6 min
  const mid = post({ remoteId: "M", created: "2026-11-02T00:00:00Z", contentHtml: `<p>${"word ".repeat(600)}</p>` }); // 3 min
  const shortOld = post({ remoteId: "S1", created: "2026-11-03T00:00:00Z", contentHtml: "<p>tiny</p>" }); // 1 min
  const shortNew = post({ remoteId: "S2", created: "2026-11-04T00:00:00Z", contentHtml: "<p>also tiny</p>" }); // 1 min
  const all = [long, mid, shortOld, shortNew];
  const ids = (f: Partial<typeof DEFAULT_FILTER>) => arrange(all, { ...DEFAULT_FILTER, ...f }).map((p) => p.remoteId);
  it("shortest and longest first; equal length puts the newer first", () => {
    expect(ids({ sort: "shortest" })).toEqual(["S2", "S1", "M", "L"]);
    expect(ids({ sort: "longest" })).toEqual(["L", "M", "S2", "S1"]);
  });
  it("by length: under 2 minutes, 2 to 5, over 5", () => {
    expect(ids({ length: "short" })).toEqual(["S2", "S1"]);
    expect(ids({ length: "medium" })).toEqual(["M"]);
    expect(ids({ length: "long" })).toEqual(["L"]);
    expect(ids({ length: "any" })).toHaveLength(4);
  });
  it("combines with the other choices", () => {
    expect(ids({ length: "short", sort: "oldest" })).toEqual(["S1", "S2"]);
  });
  it("counts the choices that differ from the start", () => {
    expect(activeFilters(DEFAULT_FILTER)).toBe(0);
    expect(activeFilters({ ...DEFAULT_FILTER, sort: "longest", length: "long", unreadOnly: true, source: "s1" })).toBe(4);
  });
});

describe("nextAfter: the post to open after this one", () => {
  const mk = (id: string, read: boolean, t: string): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "S", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: read ? 1 : null, observedAt: t, created: t, isReply: false, contentHtml: "<p>x</p>", contentMd: "x", authorName: null, authorUrl: null, sourceUrl: null });
  const posts = [mk("a", false, "2026-11-01T00:00:00Z"), mk("b", true, "2026-11-02T00:00:00Z"), mk("c", false, "2026-11-03T00:00:00Z"), mk("d", false, "2026-11-04T00:00:00Z")];
  it("is the next unread one in the order shown, skipping what is read", () => {
    expect(nextAfter(posts, DEFAULT_FILTER, posts[3] as ReadingPost)?.remoteId).toBe("c"); // newest first: d, c, b, a
    expect(nextAfter(posts, DEFAULT_FILTER, posts[2] as ReadingPost)?.remoteId).toBe("a"); // b is read
    expect(nextAfter(posts, { ...DEFAULT_FILTER, sort: "oldest" }, posts[0] as ReadingPost)?.remoteId).toBe("c");
  });
  it("is none at the end of the order (no wrapping round), and never the post itself", () => {
    expect(nextAfter(posts, DEFAULT_FILTER, posts[0] as ReadingPost)).toBeNull();
    expect(nextAfter([mk("only", false, "2026-11-01T00:00:00Z")], DEFAULT_FILTER, mk("only", false, "2026-11-01T00:00:00Z"))).toBeNull();
  });
  it("still finds it when the post just read is no longer unread and the feed shows only unread", () => {
    posts[3] = mk("d", true, "2026-11-04T00:00:00Z");
    expect(nextAfter(posts, { ...DEFAULT_FILTER, unreadOnly: true }, posts[3])?.remoteId).toBe("c");
  });
});
