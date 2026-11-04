// Our reading of the bracket grammar (spec 0.4 §10.1) against a real Studio's: for every string of the Burrow client's grammar vectors,
// the Studio's preview recognised some number of quote directives and item links (frozen in tests/fixtures/studio/bracket-grammar.json,
// credit and licence in its comment); the plugin's scanner must call a string a quote / a link exactly when the Studio did. The e2e test
// repeats the measurement live, so the fixture cannot drift from the Studio unnoticed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanLabel, scanStudioQuotes } from "../../src/studio/text";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/studio/bracket-grammar.json", import.meta.url), "utf8")) as {
  studio: string;
  cases: Array<{ text: string; directives: number; links: number }>;
};

describe(`bracket grammar, as ${fixture.studio} reads it`, () => {
  it("has the vectors", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
    expect(fixture.cases.some((c) => c.directives > 0) && fixture.cases.some((c) => c.links > 0) && fixture.cases.some((c) => c.directives === 0 && c.links === 0)).toBe(true);
  });

  for (const c of fixture.cases) {
    it(`${JSON.stringify(c.text)} → ${c.directives > 0 ? "a quote" : c.links > 0 ? "a link" : "plain text"}`, () => {
      const scan = scanStudioQuotes(c.text);
      expect(scan.quotes.length > 0, "quote").toBe(c.directives > 0);
      expect(scan.links > 0, "link").toBe(c.links > 0);
    });
  }

  it("a label may hold a single bracket or a pipe, but never ]], and is trimmed", () => {
    const id = "7c9wk2n4h6q1x8v0z3m5rjy2ke";
    // the label is the author's words up to the first ]]; what the plugin shows is cleaned of brackets and bars
    expect(scanStudioQuotes(`![[${id}   |   a ] b | c  ]]`).quotes[0]?.label).toBe(cleanLabel("a ] b | c"));
    expect(cleanLabel("a ] b | c")).toBe("a b c");
    expect(scanStudioQuotes(`![[${id} | cut]] here]]`).quotes).toEqual([]);
    expect(scanStudioQuotes(`![[${id} |]]`).quotes[0]?.label).toBeNull();
  });
});
