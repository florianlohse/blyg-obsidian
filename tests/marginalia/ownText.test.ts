// G: a reply's preview shows the reply's own words, not the original quoted at the top of the reply note.
import { describe, expect, it } from "vitest";
import { ownTextFromHtml, ownTextFromMarkdown, OWN_TEXT_MAX } from "../../src/marginalia/ownText";
import { buildReception } from "../../src/marginalia/reception";
import type { MarginaliaEntry, MarginaliaMention } from "../../src/marginalia/lookup";

describe("ownTextFromMarkdown", () => {
  it("skips the leading directive and blockquote, keeps the reply's words", () => {
    const md = "![[01ABC | Harbour]]\n> the original passage\n> second line\n\nI disagree with **this**, see [[Other note|the other]].\n";
    expect(ownTextFromMarkdown(md)).toBe("I disagree with this, see the other.");
  });
  it("keeps a quote that comes after the reply's own words", () => {
    expect(ownTextFromMarkdown("My view.\n\n![[01ABC]]\n> quoted\n")).toBe("My view. quoted");
  });
  it("is empty when there is only the quote, and cut when long", () => {
    expect(ownTextFromMarkdown("![[01ABC]]\n> only the original\n")).toBe("");
    expect(ownTextFromMarkdown("x".repeat(400)).length).toBe(OWN_TEXT_MAX);
  });
});

describe("ownTextFromHtml", () => {
  it("drops the baked transclusion block", () => {
    const html = '<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="01ABC"><p>the original</p></blockquote><p>My words.</p>';
    expect(ownTextFromHtml(html)).toBe("My words.");
  });
});

describe("the Reception rows of a reply", () => {
  const mention = (relation: string): MarginaliaMention => ({ id: "m1", targetItemId: "01ABC", relation, status: "open", hidden: false, sourceOrigin: "https://x.example/", sourceId: "s1", sourcePage: null, sourceAuthorName: "Teo", firstSeen: "" }) as unknown as MarginaliaMention;
  it("previews the reply's own words even when it quotes a passage; a whole quote and a reply with no quote show theirs too", () => {
    const entries: MarginaliaEntry[] = [
      { mention: mention("stub"), result: { kind: "quotes", version: 1, own: "I disagree.", quotes: [{ kind: "passage", text: "the original words" }] } },
      { mention: mention("stub"), result: { kind: "quotes", version: 1, own: "Just a reply.", quotes: [] } },
      { mention: mention("quote"), result: { kind: "quotes", version: 1, own: "Look at this.", quotes: [{ kind: "whole" }] } },
      { mention: mention("quote"), result: { kind: "quotes", version: 1, own: "Nice.", quotes: [{ kind: "passage", text: "the original words" }] } },
    ];
    const rows = buildReception(entries, [{ from: 0, to: 20, plain: "the original words" }]);
    expect(rows.map((r) => r.excerpt)).toEqual(["I disagree.", "Just a reply.", "Look at this.", "the original words"]);
  });
});
