import { describe, expect, it } from "vitest";
import { clusterPosts, firstSentence } from "../../src/digest/cluster";
import { buildDaily } from "../../src/digest/daily";
import { ownWords, quotedIdsOf } from "../../src/digest/quotes";
const DAY_MS = 24 * 3600 * 1000;
import type { InboundMention, ReadingPost } from "../../src/studio/reading";

const NOW = Date.parse("2030-03-10T12:00:00Z");
const ago = (h: number): string => new Date(NOW - h * 3600_000).toISOString();
let counter = 0;
const nextId = (): string => `c${String(++counter).padStart(25, "0")}`;
const ID = { a: "7c9wk2mhq0v3xj8tn5rzfd41bg", b: "1vgtgz0gq5b2c9k7d3m8r4n6xy", c: "2mhdb5wr1k5agypd4tspkyhst0" };

function post(over: Partial<ReadingPost> & { text?: string }): ReadingPost {
  const { text, ...rest } = over;
  return {
    subscriptionId: "s1",
    subscriptionTitle: "Example blyg",
    origin: "https://one.example.com/",
    remoteId: nextId(),
    kind: "fragment",
    withdrawn: false,
    version: 1,
    readVersion: null,
    observedAt: ago(2),
    created: null,
    isReply: false,
    stubTarget: null,
    contentHtml: `<p>${text ?? "Some words."}</p>`,
    contentMd: "",
    authorName: null,
    authorUrl: null,
    sourceUrl: null,
    ...rest,
  };
}
const quote = (qid: string, inner = "A quoted line."): string => `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${qid}" data-blyg-version="1"><p>${inner}</p></blockquote>`;

describe("quotes in posts", () => {
  it("reads the quoted ids from the rendered form, in any attribute order, and skips the post's own id", () => {
    const p = post({ remoteId: ID.a, contentHtml: `<p>x</p>${quote(ID.b)}<blockquote data-blyg-id="${ID.c}" class="blyg-transclusion"><p>y</p></blockquote><blockquote data-blyg-id="${ID.a}" class="blyg-transclusion">z</blockquote><blockquote data-blyg-id="${ID.c}">plain quote</blockquote>` });
    expect(quotedIdsOf(p)).toEqual([ID.b, ID.c]);
  });
  it("also reads Markdown directives when the post still has its Markdown", () => {
    expect(quotedIdsOf(post({ contentMd: `![[${ID.b}]]\n> text` }))).toEqual([ID.b]);
  });
  it("leaves the quoted words out of a post's own words", () => {
    expect(ownWords(post({ contentHtml: `<p>My reply.</p>${quote(ID.b, "Their sentence.")}` }))).toBe("My reply.");
    expect(ownWords(post({ contentHtml: quote(ID.b, "Only a quote.") }))).toBe("Only a quote.");
  });
});

describe("headlines", () => {
  it("takes the first sentence, joins a very short one, cuts long ones at a word", () => {
    expect(firstSentence("Die Bibliothek öffnet am Montag. Danach gibt es Kaffee.")).toBe("Die Bibliothek öffnet am Montag.");
    expect(firstSentence("Yes. Here is why it matters.")).toBe("Yes. Here is why it matters.");
    const long = firstSentence(`${"word ".repeat(60)}end.`);
    expect(long.length).toBeLessThanOrEqual(111);
    expect(long.endsWith("…")).toBe(true);
    expect(firstSentence("   ")).toBe("");
    expect(firstSentence("No full stop here")).toBe("No full stop here");
  });
});

describe("clusterPosts", () => {
  it("joins a reply to the post it answers, and posts that quote the same item", () => {
    const root = post({ remoteId: ID.a, text: "The harbour bridge will close for repairs in April.", subscriptionId: "s1" });
    const reply = post({ remoteId: ID.b, text: "I doubt April is realistic.", stubTarget: { origin: "https://one.example.com/", id: ID.a }, isReply: true, subscriptionId: "s2" });
    const q1 = post({ remoteId: ID.c, contentHtml: `<p>Cats are wonderful.</p>${quote("zzzzzzzzzzzzzzzzzzzzzzzzzz")}`, subscriptionId: "s3" });
    const q2 = post({ contentHtml: `<p>Dogs are fine too.</p>${quote("zzzzzzzzzzzzzzzzzzzzzzzzzz")}`, subscriptionId: "s4" });
    const loner = post({ text: "Sourdough needs patience and a warm kitchen.", subscriptionId: "s5" });
    const clusters = clusterPosts([loner, q2, reply, q1, root]);
    expect(clusters.map((c) => c.posts.length)).toEqual([2, 2, 1]);
    const bridge = clusters.find((c) => c.posts.some((p) => p.remoteId === ID.a));
    expect(bridge?.posts[0]?.remoteId).toBe(ID.a); // the answered post leads
    expect(bridge?.headline).toBe("The harbour bridge will close for repairs in April.");
    expect(clusters.find((c) => c.posts.includes(q1))?.posts).toContain(q2);
  });
  it("joins replies to an item that is itself not in the list", () => {
    const outside = { origin: "https://x.example.com/", id: "9".repeat(26) };
    const a = post({ text: "First answer to something we cannot see.", stubTarget: outside });
    const b = post({ text: "Second answer to the same thing.", stubTarget: outside });
    expect(clusterPosts([a, b])).toHaveLength(1);
  });
  it("joins a post left alone to a similar one: German and English", () => {
    const de1 = post({ text: "Die Stadtbibliothek eröffnet am Montag eine neue Ausstellung über Buchdruck im sechzehnten Jahrhundert." });
    const de2 = post({ text: "Ausstellung zum Buchdruck: Die Stadtbibliothek zeigt ab Montag Drucke aus dem sechzehnten Jahrhundert." });
    const en1 = post({ text: "The council approved a new cycling lane along the river, with construction starting next spring." });
    const en2 = post({ text: "New cycling lane along the river approved by the council; construction starts next spring." });
    const odd = post({ text: "Sourdough starters like warm kitchens, regular feeding and plenty of patience." });
    const clusters = clusterPosts([de1, en1, odd, de2, en2]);
    expect(clusters.map((c) => c.posts.length)).toEqual([2, 2, 1]);
    expect(clusters.some((c) => c.posts.includes(de1) && c.posts.includes(de2))).toBe(true);
    expect(clusters.some((c) => c.posts.includes(en1) && c.posts.includes(en2))).toBe(true);
  });
  it("keeps unrelated and very short posts apart", () => {
    const posts = [post({ text: "Good morning." }), post({ text: "Good morning!" }), post({ text: "Rain on the roof all night, and the garden loves it." }), post({ text: "Quarterly figures were published; revenue grew modestly." })];
    expect(clusterPosts(posts)).toHaveLength(4);
  });
  it("is deterministic whatever the order of the input", () => {
    const posts = [
      post({ remoteId: ID.a, text: "The harbour bridge will close for repairs in April." }),
      post({ remoteId: ID.b, text: "Reply about the bridge timing.", stubTarget: { origin: "o", id: ID.a } }),
      post({ remoteId: ID.c, text: "Something else entirely about gardens and tomatoes in July." }),
    ];
    const shape = (ps: ReadingPost[]) => JSON.stringify(clusterPosts(ps).map((c) => [c.headline, c.posts.map((p) => p.remoteId), c.terms]));
    expect(shape([...posts].reverse())).toBe(shape(posts));
  });
  it("orders by size, then recency, and names the terms", () => {
    const old = post({ remoteId: ID.a, text: "An older solitary note about tomatoes.", observedAt: ago(30) });
    const fresh = post({ remoteId: ID.b, text: "A fresher solitary note about harbours.", observedAt: ago(1) });
    const c = clusterPosts([old, fresh]);
    expect(c.map((x) => x.posts[0])).toEqual([fresh, old]);
    expect(c[0]?.terms.length).toBeGreaterThan(0);
  });
});

describe("buildDaily", () => {
  const mention = (over: Partial<InboundMention>): InboundMention => ({ id: "m1", targetItemId: ID.a, relation: "stub", status: "verified", hidden: false, sourceOrigin: null, sourceId: null, sourcePage: null, sourceAuthorName: "Sam", firstSeen: ago(3), ...over });
  const since = NOW - DAY_MS;

  it("keeps to the window, and leaves out the owner's own posts", () => {
    const m = buildDaily([post({ text: "Fresh enough to count here." }), post({ text: "Too old to count.", observedAt: ago(50) }), post({ text: "Mine.", own: true, subscriptionId: "" })], [], since, NOW);
    expect(m.postCount).toBe(1);
    expect(m.front).toHaveLength(0); // one post is a single post: it is in the Mixed bag, not a story
    expect(m.mixed).toHaveLength(1);
  });
  it("lists revised posts as corrections: 'revised to vN', and which version you read", () => {
    const m = buildDaily([post({ remoteId: ID.a, version: 3, readVersion: 2, text: "Corrected figure for March." }), post({ remoteId: ID.b, version: 2, text: "A second revision." }), post({ text: "Never revised." })], [], since, NOW);
    expect(m.corrections.map((c) => c.note).sort()).toEqual(["revised to v2", "revised to v3 (you read v2)"]);
  });
  it("lists withdrawn posts as retractions, not on the front page", () => {
    const m = buildDaily([post({ withdrawn: true, text: "Taken back.", version: 2 }), post({ text: "Still standing." })], [], since, NOW);
    expect(m.retractions.map((r) => r.headline)).toEqual(["Taken back."]);
    expect(m.corrections).toHaveLength(0);
    expect(m.postCount).toBe(1);
  });
  it("lists mentions of your items as letters: window, hidden, failed", () => {
    const src = post({ remoteId: ID.c, text: "I replied to you here.", authorName: "Sam" });
    const m = buildDaily([src], [mention({ sourceId: ID.c }), mention({ id: "m2", hidden: true }), mention({ id: "m3", status: "failed" }), mention({ id: "m4", firstSeen: ago(90) }), mention({ id: "m5", relation: "transclusion", sourceAuthorName: null, firstSeen: ago(1) })], since, NOW);
    expect(m.letters.map((l) => l.mention.id)).toEqual(["m5", "m1"]);
    expect(m.letters[1]).toMatchObject({ who: "Sam", words: "replied to", headline: "I replied to you here." });
    expect(m.letters[0]?.words).toBe("quoted");
  });
  it("shows only the first clusters and counts the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => {
      const id = `${"a".repeat(24)}${String(i).padStart(2, "0")}`;
      return [post({ remoteId: id, text: `Topic${i} unique${i} wording${i} alpha${i} beta${i}.` }), post({ remoteId: `${"c".repeat(24)}${String(i).padStart(2, "0")}`, isReply: true, stubTarget: { id } as never, text: `Reply ${i}.` })];
    }).flat();
    const m = buildDaily(many, [], since, NOW);
    expect(m.front).toHaveLength(15);
    expect(m.moreClusters).toBe(5);
  });
  it("builds 200 posts quickly", () => {
    const words = Array.from({ length: 300 }, (_, i) => `wort${i}`);
    const posts = Array.from({ length: 200 }, (_, i) => post({ remoteId: `${"b".repeat(22)}${String(i).padStart(4, "0")}`, text: Array.from({ length: 80 }, (_, k) => words[(i * 11 + k * 7) % 300]).join(" ") }));
    const t0 = performance.now();
    buildDaily(posts, [], since, NOW);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
