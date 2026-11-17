// S15, the reader's feed: cards, order and filters, and whether a post's page may be shown inside Obsidian. Pure functions.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readOwnReadingEntry, readReadingPost, type ReadingPost } from "../src/studio/reading";
import { activeFilters, arrange, cardOf, DEFAULT_FILTER, formattedRuns, isReplyToMine, OWN_SOURCE, frameable, postOfQuote, readingMinutes, readingTimeLabel, relativeTime, sourcesOf } from "../src/ui/readerFeed";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/studio/reader/${name}-0.51.0.html`, import.meta.url), "utf8");
const post = (patch: Record<string, unknown>): ReadingPost =>
  readReadingPost({ subscriptionId: "s1", subscriptionTitle: "Blog A", origin: "https://a.example/", remoteId: "r1", kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2026-11-10T10:00:00Z", created: null, contentHtml: "<p>x</p>", ...patch })!;

describe("cardOf", () => {
  it("a thread: the quoted words apart from the author's own, from real Studio output", () => {
    expect(cardOf({ contentHtml: fixture("imported-thread-partial") })).toEqual({ quote: "It has a quotable sentence.", words: "My own words under a partial quote, with a link.", runs: [{ text: "My own words under a partial quote, with a link." }], images: 0 });
  });
  it("a fragment with an image: its words, and the image counted, not loaded", () => {
    expect(cardOf({ contentHtml: fixture("imported-image") })).toEqual({ quote: null, words: "A post with a picture.", runs: [{ text: "A post with a picture." }], images: 1 });
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
  it("the owner's own posts are always in the feed, are never unread, and are no blyg in the source list", () => {
    const mine = readOwnReadingEntry({ source: "own", displayAt: "2026-11-06T00:00:00Z", own: { id: "m1", kind: "fragment", withdrawn: false, updated: "2026-11-06T00:00:00Z", contentHtml: "<p>My own words.</p>" } });
    expect(mine).toMatchObject({ own: true, subscriptionId: "", remoteId: "m1", readVersion: 1, version: 1 });
    expect(arrange([a, b, mine as ReadingPost], DEFAULT_FILTER).map((p) => p.remoteId)).toEqual(["m1", "b", "a"]);
    expect(arrange([a, b, mine as ReadingPost], { ...DEFAULT_FILTER, unreadOnly: true }).map((p) => p.remoteId)).toEqual(["b", "a"]);
    expect(sourcesOf([a, mine as ReadingPost]).map((s) => s.id)).toEqual(["s1"]);
  });
  it("My posts in the Blyg choice, and only the replies to my posts", () => {
    const mine = readOwnReadingEntry({ source: "own", displayAt: "2026-11-06T00:00:00Z", own: { id: "m1", kind: "fragment", withdrawn: false, updated: "2026-11-06T00:00:00Z", contentHtml: "<p>Mine.</p>" } }) as ReadingPost;
    const reply: ReadingPost = { ...post({ remoteId: "r", created: "2026-11-02T00:00:00Z" }), isReply: true, stubTarget: { origin: "https://o/", id: "m1" } };
    const replyToOther: ReadingPost = { ...post({ remoteId: "x", created: "2026-11-02T12:00:00Z" }), isReply: true, stubTarget: { origin: "https://o/", id: "other" } };
    const ids = new Set(["m1"]);
    expect(arrange([a, mine, reply], { ...DEFAULT_FILTER, source: OWN_SOURCE }).map((p) => p.remoteId)).toEqual(["m1"]);
    expect(arrange([a, mine, reply, replyToOther], { ...DEFAULT_FILTER, repliesToMe: true }, ids).map((p) => p.remoteId)).toEqual(["r"]);
    expect(arrange([a, reply], { ...DEFAULT_FILTER, repliesToMe: true }).map((p) => p.remoteId)).toEqual([]); // my items not known yet: nothing matches
    expect(isReplyToMine(reply, ids)).toBe(true);
    expect(isReplyToMine(replyToOther, ids)).toBe(false);
    expect(isReplyToMine(a, ids)).toBe(false);
    expect(activeFilters({ ...DEFAULT_FILTER, repliesToMe: true })).toBe(1);
  });
  it("an entry of the merged list is an own post only when it says source own and carries its item", () => {
    expect(readOwnReadingEntry({ source: "imported", imported: {} })).toBeNull();
    expect(readOwnReadingEntry({ source: "own", own: { id: "", kind: "fragment", contentHtml: "x" } })).toBeNull();
    expect(readOwnReadingEntry({ source: "own", own: { id: "x", kind: "essay", contentHtml: "x" } })).toBeNull();
    expect(readOwnReadingEntry("junk")).toBeNull();
  });
  it("the source picker lists each blyg once, with its count, by title", () => {
    expect(sourcesOf([a, b, c])).toEqual([{ id: "s1", title: "Blog A", count: 2 }, { id: "s2", title: "Blog B", count: 1 }]);
  });
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

describe("postOfQuote: where a quote comes from", () => {
  const mk = (id: string, withdrawn = false): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "S", origin: null, remoteId: id, kind: "fragment", withdrawn, version: 1, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null });
  it("finds the post of a blyg the Studio reads, by the quote's item id", () => {
    const posts = [mk("a"), mk("b")];
    expect(postOfQuote(posts, "b")).toBe(posts[1]);
    expect(postOfQuote(posts, "zzz")).toBeNull();
    expect(postOfQuote(posts, "")).toBeNull();
  });
  it("prefers a copy that is not withdrawn", () => {
    const posts = [mk("a", true), mk("a")];
    expect(postOfQuote(posts, "a")).toBe(posts[1]);
    expect(postOfQuote([mk("a", true)], "a")?.withdrawn).toBe(true);
  });
});

describe("formattedRuns (a card's words with a little formatting)", () => {
  const joined = (r: ReturnType<typeof formattedRuns>): string => r.map((x) => x.text).join("");
  it("a heading is bold and ends its line; the paragraph after it starts clean", () => {
    expect(formattedRuns("<h2>A heading</h2><p>Some words follow.</p>")).toEqual([{ text: "A heading", bold: true, breakAfter: true }, { text: "Some words follow." }]);
  });
  it("bold and italics are kept; the space between words belongs to the word that follows", () => {
    expect(formattedRuns("<p>one <strong>two</strong> and <em>three</em>, <b>four</b> <i>five</i>.</p>")).toEqual([
      { text: "one" }, { text: " two", bold: true }, { text: " and" }, { text: " three", italic: true }, { text: "," }, { text: " four", bold: true }, { text: " five", italic: true }, { text: "." },
    ]);
  });
  it("nested bold and italic, entities, and links stay plain words", () => {
    const runs = formattedRuns('<p><strong>very <em>much</em></strong> &amp; <a href="https://x">a link</a></p>');
    expect(runs[0]).toEqual({ text: "very", bold: true });
    expect(runs[1]).toEqual({ text: " much", bold: true, italic: true });
    expect(joined(runs)).toBe("very much & a link");
  });
  it("the words are the plain text's words, whitespace collapsed, one space between paragraphs", () => {
    const html = "<p>First  paragraph.</p>\n<p>Second   one.</p><ul><li>item</li></ul>";
    expect(joined(formattedRuns(html))).toBe(cardOf({ contentHtml: html }).words);
  });
  it("is cut at the card length with an ellipsis, across runs, and never ends on a line break", () => {
    const runs = formattedRuns(`<h1>Head</h1><p>${"word ".repeat(100)}</p>`, 40);
    expect(joined(runs).length).toBeLessThanOrEqual(40);
    expect(joined(runs).endsWith("…")).toBe(true);
    expect(formattedRuns("<p>x</p><h2>Last</h2>").at(-1)?.breakAfter).toBeUndefined();
  });
  it("tags it does not know and scripts' text are not markup: only words come out", () => {
    const runs = formattedRuns("<p>safe <script>alert(1)</script> <span onclick=x>words</span></p>");
    expect(runs.every((r) => !/[<>]/.test(r.text))).toBe(true);
  });
});
