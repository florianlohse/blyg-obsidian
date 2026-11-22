import { describe, expect, it } from "vitest";
import { findPassage, normalizeForMatch } from "../../src/core/passage";
import { parseQuoteRefs, quotedItemIds } from "../../src/core/quoteRefs";
import { Bm25Index, STOP_WORDS, buildBm25Index, foldTerm, tokenize } from "../../src/core/terms";

const A = "0123456789abcdefghjkmnpqrs";
const B = "0123456789abcdefghjkmnpqrt";

describe("tokenize", () => {
  it("splits Unicode words, folds case and accents, drops stop words", () => {
    expect(tokenize("Die Größe der Äpfel ist ÜBER 3 Meter")).toEqual(["grosse", "apfel", "meter"]);
    expect(tokenize("The quick brown fox, and the lazy dog's bone")).toEqual(["quick", "brown", "fox", "lazy", "dogs", "bone"]);
  });
  it("keeps numbers, drops one-letter terms, can keep stop words", () => {
    expect(tokenize("a 42 b x1")).toEqual(["42", "x1"]);
    expect(tokenize("the cat", { keepStopWords: true })).toEqual(["the", "cat"]);
  });
  it("handles non-Latin scripts", () => {
    expect(tokenize("Привет, мир! 東京 tokyo")).toEqual(["привет", "мир", "東京", "tokyo"]);
  });
  it("has stop words of both languages, folded", () => {
    expect(STOP_WORDS.has("the") && STOP_WORDS.has("und") && STOP_WORDS.has("fur")).toBe(true);
    expect(foldTerm("Straße")).toBe("strasse");
  });
});

describe("Bm25Index", () => {
  const docs = [
    { id: "d1", text: "Die Bibliothek eröffnet am Montag eine neue Ausstellung über Buchdruck." },
    { id: "d2", text: "The library opens a new exhibition about printing on Monday." },
    { id: "d3", text: "Recipe: how to bake sourdough bread at home, with a long rest." },
    { id: "d4", text: "Printing printing printing: a history of printing presses." },
  ];
  const index = buildBm25Index(docs);

  it("ranks the relevant documents first and says which terms matched", () => {
    const hits = index.search("printing exhibition");
    expect(hits.map((h) => h.id)).toEqual(["d2", "d4"]);
    expect(hits.find((h) => h.id === "d2")?.terms).toEqual(["printing", "exhibition"]);
  });
  it("matches across German accents and works in German", () => {
    const hits = index.search("Ausstellung Buchdruck eroffnet");
    expect(hits[0]?.id).toBe("d1");
    expect(hits[0]?.terms).toEqual(["ausstellung", "buchdruck", "eroffnet"]);
  });
  it("returns nothing for stop words only or unknown terms, and honours limit", () => {
    expect(index.search("the und")).toEqual([]);
    expect(index.search("zebra")).toEqual([]);
    expect(index.search("monday printing", { limit: 1 })).toHaveLength(1);
    expect(new Bm25Index([]).search("x y")).toEqual([]);
  });
  it("is deterministic and orders ties by insertion", () => {
    const twin = buildBm25Index([{ id: "x", text: "alpha beta" }, { id: "y", text: "alpha beta" }]);
    expect(twin.search("alpha").map((h) => h.id)).toEqual(["x", "y"]);
    expect(JSON.stringify(index.search("library printing"))).toBe(JSON.stringify(buildBm25Index(docs).search("library printing")));
  });
  it("builds 1000 documents well under a second", () => {
    const words = Array.from({ length: 400 }, (_, i) => `wort${i}`);
    const many = Array.from({ length: 1000 }, (_, i) => ({
      id: `n${i}`,
      text: Array.from({ length: 200 }, (_, k) => words[(i * 7 + k * 13) % 400]).join(" "),
    }));
    const t0 = performance.now();
    const big = buildBm25Index(many);
    const built = performance.now() - t0;
    expect(big.size).toBe(1000);
    expect(built).toBeLessThan(1000);
    const t1 = performance.now();
    expect(big.search("wort5 wort77 wort301").length).toBeGreaterThan(0);
    expect(performance.now() - t1).toBeLessThan(100);
  });
});

describe("findPassage", () => {
  const paragraphs = [
    "Intro paragraph about something else entirely.",
    "Die Stadtbibliothek eröffnet am Montag „die neue Ausstellung“ – mit über 200 Büchern aus dem 16. Jahrhundert.",
    "It's a “long” story: the press was built in 1455, and nobody expected what happened next.",
    "Closing remarks.",
  ];
  it("finds an exact passage", () => {
    expect(findPassage("nobody expected what happened next", paragraphs)).toEqual({ index: 2, end: 2, confidence: 1, method: "exact" });
  });
  it("finds it again with different quotes, dashes, spacing and case", () => {
    const m = findPassage("IT'S A \"long\"   story - the press", paragraphs);
    expect(m?.index).toBe(2);
    expect(m?.method).toBe("normalised");
    expect(m?.confidence).toBeGreaterThan(0.9);
    expect(m?.confidence).toBeLessThan(1);
  });
  it("finds German text across typography", () => {
    expect(findPassage('die neue Ausstellung - mit uber 200 Buchern', paragraphs)?.index).toBe(1);
  });
  it("finds text edited after quoting by overlap, with lower confidence", () => {
    const m = findPassage("The press was built in 1455 and nobody had expected what then happened", paragraphs);
    expect(m?.index).toBe(2);
    expect(m?.method).toBe("overlap");
    expect(m?.confidence).toBeGreaterThan(0.5);
    expect(m?.confidence).toBeLessThanOrEqual(0.9);
    const de = findPassage("Die Stadtbibliothek eröffnet am Dienstag die neue Ausstellung mit über 300 Büchern", paragraphs);
    expect(de).toMatchObject({ index: 1, method: "overlap" });
  });
  it("returns nothing when it is not there, or the passage is too thin", () => {
    expect(findPassage("completely unrelated sentence about volcanoes erupting", paragraphs)).toBeNull();
    expect(findPassage("press", [" a b c "])).toBeNull();
    expect(findPassage("   ", paragraphs)).toBeNull();
    expect(findPassage("anything", [])).toBeNull();
  });
  it("spans paragraphs for a multi-block passage", () => {
    const m = findPassage("Intro paragraph about something else\nClosing remarks.", paragraphs);
    expect(m).toMatchObject({ index: 0, end: 3, method: "exact" });
  });
  it("normalises for matching", () => {
    expect(normalizeForMatch("  Ünder—the “Sea”, ß ")).toBe("under the sea ss");
  });
});

describe("parseQuoteRefs", () => {
  it("reads a whole-post quote and a partial one", () => {
    const md = `Intro\n\n![[${A}]]\n\nMy view.\n\n![[${B}]]\n> A passage of\n>\n> two blocks.\n\nEnd`;
    const refs = parseQuoteRefs(md);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ itemId: A, citedVersion: null, passageLines: null, passageText: null, line: 3 });
    expect(refs[1]).toMatchObject({ itemId: B, passageLines: ["A passage of", "", "two blocks."], passageText: "A passage of\ntwo blocks.", passageExact: true, line: 7 });
  });
  it("reads a cited version and CRLF", () => {
    const refs = parseQuoteRefs(`![[${A}@v3]]\r\n> text\r\n`);
    expect(refs[0]).toMatchObject({ itemId: A, citedVersion: 3, passageText: "text" });
  });
  it("keeps repeats and dedupes ids on request", () => {
    const md = `![[${A}]]\n> one\n\n![[${A}]]\n> two`;
    expect(parseQuoteRefs(md)).toHaveLength(2);
    expect(quotedItemIds(md)).toEqual([A]);
  });
  it("ignores directives in code, indented, inline, in quotes and in frontmatter", () => {
    const md = `---\ntitle: x\nref: ![[${A}]]\n---\n\`\`\`\n![[${A}]]\n\`\`\`\n    ![[${A}]]\nsee ![[${A}]] inline\n> ![[${A}]]\n[[${A}]]\n`;
    expect(parseQuoteRefs(md)).toEqual([]);
  });
  it("does not take a blank-separated quote as attached", () => {
    expect(parseQuoteRefs(`![[${A}]]\n\n> a separate quote`)[0]?.passageLines).toBeNull();
  });
  it("resolves escapes through the shared renderer, and flags quotes it cannot render exactly", () => {
    const ok = parseQuoteRefs(`![[${A}]]\n> 2 \\* 3 \\[x\\]`)[0];
    expect(ok).toMatchObject({ passageText: "2 * 3 [x]", passageExact: true });
    // A bare web address swallows the backslash: not an escape, and the renderer refuses rather than guesses.
    const url = parseQuoteRefs(`![[${A}]]\n> see https://example.com/a\\_b`)[0];
    expect(url?.passageExact).toBe(false);
    expect(url?.passageText).toBe("see https://example.com/a\\_b");
    const emph = parseQuoteRefs(`![[${A}]]\n> some *emphasis* here`)[0];
    expect(emph).toMatchObject({ passageExact: false, passageText: "some *emphasis* here" });
  });
  it("ignores ids of the wrong shape", () => {
    expect(parseQuoteRefs("![[Some Note]]\n![[0123456789abcdefghjkmnpqr]]")).toEqual([]);
  });
});
