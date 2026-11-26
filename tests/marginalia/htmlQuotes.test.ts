// HK3: the quotes of an item read from a post's rendered HTML (what a peek serves for any blyg). The HTML below is what a real Studio 0.51.0 served (measured 2026-11-26).
import { describe, expect, it } from "vitest";
import { parseQuotesFromHtml } from "../../src/marginalia/htmlQuotes";

const ID = "4j4p9apv0tgeps24xmt2m00j1q";
const partial = (text: string, id = ID) => `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${id}" data-blyg-version="1" data-blyg-origin="http://localhost:8787/">\n${text}\n</blockquote>\n`;
const whole = (id = ID) => `<blockquote class="blyg-transclusion" data-blyg-id="${id}" data-blyg-version="1" data-blyg-origin="http://localhost:8787/">\n<p>All of the item.</p>\n</blockquote>\n`;

describe("parseQuotesFromHtml", () => {
  it("a partial transclusion is a passage with its plain text; a whole one is the whole post", () => {
    expect(parseQuotesFromHtml(`${partial("<p>ants leave traces for others</p>")}<p>My words on that.</p>\n`, ID)).toEqual([{ kind: "passage", text: "ants leave traces for others" }]);
    expect(parseQuotesFromHtml(`${whole()}<p>I quote it all.</p>`, ID)).toEqual([{ kind: "whole" }]);
  });
  it("several paragraphs of one passage read as one text; entities are decoded; markup and script in a stranger's words never come out", () => {
    expect(parseQuotesFromHtml(partial("<p>one &amp; two</p>\n<p>three <b>four</b> <script>x()</script></p>"), ID)).toEqual([{ kind: "passage", text: "one & two three four" }]);
  });
  it("quotes of other items, plain blockquotes and a post with no quote give nothing", () => {
    expect(parseQuotesFromHtml(partial("<p>x</p>", "other"), ID)).toEqual([]);
    expect(parseQuotesFromHtml("<blockquote><p>a plain quote</p></blockquote>", ID)).toEqual([]);
    expect(parseQuotesFromHtml("<p>Only a reply, no quote.</p>", ID)).toEqual([]);
  });
  it("two quotes stand in the order they come; attribute order and quoting do not matter", () => {
    const html = `${whole()}<p>and</p><blockquote data-blyg-id="${ID}" class="blyg-partial blyg-transclusion"><p>again</p></blockquote>`;
    expect(parseQuotesFromHtml(html, ID)).toEqual([{ kind: "whole" }, { kind: "passage", text: "again" }]);
  });
  it("a partial quote with no text is read as the whole post rather than an empty passage", () => {
    expect(parseQuotesFromHtml(partial("<p> </p>"), ID)).toEqual([{ kind: "whole" }]);
  });
});
