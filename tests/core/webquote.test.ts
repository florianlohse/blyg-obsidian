// S20 web quote (docs/plans/S20-web-quote.md): the formatter, the address cleaning, the shortened link, the template, the insertion plan, and how a
// web quote sits next to a blyg thread's directive.
import { describe, expect, it } from "vitest";
import {
  buildWebQuote,
  cleanUrl,
  DEFAULT_FORMAT,
  DEFAULT_WEB_QUOTE,
  draftIsEmpty,
  escapeLabel,
  formState,
  parseDraft,
  planInsert,
  type Pos,
  formatProblem,
  quoteText,
  renderFormat,
  shortLink,
  SHORT_LINK_MAX,
  type WebQuoteOptions,
} from "../../src/core/webQuote";
import { scanThread } from "../../src/core/thread";

const opts = (o: Partial<WebQuoteOptions> = {}): WebQuoteOptions => ({ ...DEFAULT_WEB_QUOTE, ...o });
const ok = (url: string, strip = true): string => {
  const r = cleanUrl(url, strip);
  if (!r.ok) throw new Error(r.reason);
  return r.url;
};

describe("quoteText", () => {
  it("keeps what was pasted line by line (nothing escaped, no > added: the format does that)", () => {
    expect(quoteText("One *emphasised* line with [a link](https://x.test)\nSecond line")).toEqual(["One *emphasised* line with [a link](https://x.test)", "Second line"]);
  });
  it("normalises line endings and drops trailing spaces and blank lines at the ends", () => {
    expect(quoteText("\r\n\r\nA  \r\nB\t\r\n\r\n")).toEqual(["A", "B"]);
    expect(quoteText("A\u2028B")).toEqual(["A", "B"]);
  });
  it("turns a run of blank lines into one", () => {
    expect(quoteText("A\n\n\n\nB")).toEqual(["A", "", "B"]);
    expect(quoteText("A\n   \nB")).toEqual(["A", "", "B"]);
  });
  it("removes one level of > from a quote copied from Markdown, so it does not nest", () => {
    expect(quoteText("> A\n>\n> B")).toEqual(["A", "", "B"]);
    expect(quoteText("> > deep\n> text")).toEqual(["> deep", "text"]);
  });
  it("leaves a quote alone when only some lines start with >", () => {
    expect(quoteText("> A\nB")).toEqual(["> A", "B"]);
  });
  it("is empty for nothing", () => {
    expect(quoteText("")).toEqual([]);
    expect(quoteText(" \n\t\n")).toEqual([]);
  });
});

describe("cleanUrl", () => {
  it("accepts http and https only", () => {
    expect(ok("https://example.com/a")).toBe("https://example.com/a");
    expect(ok("http://example.com/a")).toBe("http://example.com/a");
    for (const bad of ["ftp://example.com/", "javascript:alert(1)", "data:text/html,x", "mailto:a@b.test", "example.com/page", "[[note]]"]) {
      expect(cleanUrl(bad, true).ok, bad).toBe(false);
    }
  });
  it("refuses an empty address, spaces, line breaks and credentials", () => {
    expect(cleanUrl("   ", true)).toEqual({ ok: false, reason: "Paste the address of the page." });
    expect(cleanUrl("https://example.com/a b", true).ok).toBe(false);
    expect(cleanUrl("https://example.com/a\nhttps://other.test/", true).ok).toBe(false);
    expect(cleanUrl("https://me:secret@example.com/", true).ok).toBe(false);
  });
  it("trims surrounding white space", () => {
    expect(ok("  https://example.com/x \n")).toBe("https://example.com/x");
  });
  it("percent-encodes the characters that would break a Markdown link destination", () => {
    expect(ok("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_%28bar%29");
    expect(ok("https://example.com/a?x=<1>")).toBe("https://example.com/a?x=%3C1%3E");
  });
  it("removes utm_*, fbclid, gclid, mc_cid and mc_eid everywhere, keeping the rest in order", () => {
    expect(ok("https://example.com/p?id=7&utm_source=a&UTM_medium=b&fbclid=x&q=%20y&gclid=1&mc_cid=2&mc_eid=3")).toBe("https://example.com/p?id=7&q=%20y");
  });
  it("drops the ? when no parameter is left, and keeps the fragment", () => {
    expect(ok("https://example.com/p?utm_source=a#section-2")).toBe("https://example.com/p#section-2");
    expect(ok("https://example.com/p?id=1#c")).toBe("https://example.com/p?id=1#c");
  });
  it("removes Substack's share parameters on substack.com hosts only", () => {
    const s = "https://x.substack.com/p/slug?r=abc&utm_campaign=post&triedRedirect=true&showWelcomeOnShare=true&keep=1";
    expect(ok(s)).toBe("https://x.substack.com/p/slug?keep=1");
    expect(ok("https://substack.com/home/post/p-1?r=zz")).toBe("https://substack.com/home/post/p-1");
    expect(ok("https://news.example.com/p/slug?r=abc&utm_campaign=post")).toBe("https://news.example.com/p/slug?r=abc");
    expect(ok("https://notsubstack.com/p?r=1")).toBe("https://notsubstack.com/p?r=1");
  });
  it("touches nothing when asked not to", () => {
    expect(ok("https://x.substack.com/p/slug?r=abc&utm_campaign=post", false)).toBe("https://x.substack.com/p/slug?r=abc&utm_campaign=post");
  });
});

describe("shortLink", () => {
  it("shows host and path without scheme, www, query, fragment and trailing slash", () => {
    expect(shortLink("https://www.example.com/")).toBe("example.com");
    expect(shortLink("https://example.com/a/b/?x=1#y")).toBe("example.com/a/b");
  });
  it("keeps a link that fits whole, at the limit exactly", () => {
    const host = "a".repeat(SHORT_LINK_MAX - 3);
    expect(shortLink(`https://${host}.io/`)).toBe(`${host}.io`);
    expect(Array.from(shortLink(`https://${host}.io/`))).toHaveLength(SHORT_LINK_MAX);
  });
  it("cuts the rest after the host and never the host first (limit 40, the ellipsis included)", () => {
    const short = shortLink("https://example.substack.com/p/why-the-long-form-essay-is-not-dead");
    expect(short).toBe("example.substack.com/p/why-the-long-for…");
    expect(Array.from(short)).toHaveLength(SHORT_LINK_MAX);
  });
  it("cuts a host that is itself too long", () => {
    const short = shortLink(`https://${"a".repeat(60)}.example.com/x`);
    expect(Array.from(short)).toHaveLength(SHORT_LINK_MAX);
    expect(short.endsWith("…")).toBe(true);
  });
  it("counts characters, not UTF-16 units, so an emoji is never split", () => {
    const short = shortLink(`https://example.com/${"😀".repeat(60)}`, 30);
    expect(Array.from(short)).toHaveLength(30);
    expect(short.endsWith("😀…")).toBe(true);
  });
  it("shows an encoded path readably", () => {
    expect(shortLink("https://example.com/caf%C3%A9")).toBe("example.com/café");
    expect(shortLink("https://example.com/100%")).toBe("example.com/100%");
  });
});

describe("escapeLabel", () => {
  it("escapes what could break a link label or the italics around it", () => {
    expect(escapeLabel("a [b] *c* `d` <e> \\f")).toBe("a \\[b\\] \\*c\\* \\`d\\` \\<e> \\\\f");
  });
  it("flattens line breaks", () => {
    expect(escapeLabel("one\r\ntwo\n\nthree")).toBe("one two three");
  });
  it("leaves an underscore inside a word alone and escapes the others", () => {
    expect(escapeLabel("snake_case_name")).toBe("snake_case_name");
    expect(escapeLabel("_lead and trail_")).toBe("\\_lead and trail\\_");
  });
});

describe("formatProblem", () => {
  it("accepts the default and ordinary formats", () => {
    for (const f of [DEFAULT_FORMAT, "{quote}\n{link}", "> {quote}\n>\n> *{link}*", "> {quote} ({alias})\n{url}", "{quote} {link}", "- {quote}\n  {link}"]) expect(formatProblem(f), f).toBeNull();
  });
  it("names the problem", () => {
    expect(formatProblem("")).toMatch(/empty/);
    expect(formatProblem("  \n ")).toMatch(/empty/);
    expect(formatProblem("> {quote}\n> {lnk}")).toMatch(/Unknown placeholder \{lnk\}/);
    expect(formatProblem("*{link}*")).toMatch(/needs \{quote\}/);
    expect(formatProblem("> {quote}\n> {quote}\n{link}")).toMatch(/only once/);
    expect(formatProblem("> {quote}")).toMatch(/needs \{link\}/);
    expect(formatProblem("> {quote}\n> {alias}")).toMatch(/needs \{link\}/);
  });
});

describe("renderFormat", () => {
  const parts = { quote: ["First line", "Second line"], text: "Essay", url: "https://x.test/a" };
  it("the default is a block quote with the source as its last line and no blank line between", () => {
    expect(renderFormat(DEFAULT_FORMAT, parts)).toBe("> First line\n> Second line\n> *[Essay](https://x.test/a)*");
  });
  it("a blank line is there only if the format has one", () => {
    expect(renderFormat("> {quote}\n>\n> *{link}*", parts)).toBe("> First line\n> Second line\n>\n> *[Essay](https://x.test/a)*");
    expect(renderFormat("> {quote}\n\n*{link}*", parts)).toBe("> First line\n> Second line\n\n*[Essay](https://x.test/a)*");
  });
  it("the marks in front of {quote} carry onto the quote's later lines, a blank quote line becoming a bare mark", () => {
    expect(renderFormat("> {quote}\n> {link}", { ...parts, quote: ["A", "", "B"] })).toBe("> A\n>\n> B\n> [Essay](https://x.test/a)");
    expect(renderFormat("> > {quote}\n{url}", { ...parts, quote: ["A", "B"] })).toBe("> > A\n> > B\nhttps://x.test/a");
    expect(renderFormat("{quote}\n{link}", { ...parts, quote: ["A", "", "B"] })).toBe("A\n\nB\n[Essay](https://x.test/a)");
  });
  it("text after {quote} on its line follows the last quote line", () => {
    expect(renderFormat("> {quote} ({alias})\n{url}", parts)).toBe("> First line\n> Second line (Essay)\nhttps://x.test/a");
  });
  it("the source may come first", () => {
    expect(renderFormat("{link}\n> {quote}", parts)).toBe("[Essay](https://x.test/a)\n> First line\n> Second line");
  });
  it("fills the placeholders in one pass: a value containing a placeholder is left alone", () => {
    expect(renderFormat("> {quote}\n> {link}", { quote: ["{url}"], text: "{quote}", url: "https://x.test/" })).toBe("> {url}\n> [{quote}](https://x.test/)");
  });
  it("drops blank lines at the ends of the result, and understands CRLF in the format", () => {
    expect(renderFormat("\n\n> {quote}\r\n> {link}\n\n", parts)).toBe("> First line\n> Second line\n> [Essay](https://x.test/a)");
  });
});

describe("buildWebQuote", () => {
  const input = { quote: "First line\nSecond line", link: "https://example.substack.com/p/slug?r=1&utm_medium=web", alias: "" };
  it("builds the default block: a quote with an italic source as its last line, no blank line, no dash", () => {
    const r = buildWebQuote(input, opts());
    expect(r).toMatchObject({ ok: true, formatFellBack: false });
    if (r.ok) {
      expect(r.text).toBe("> First line\n> Second line\n> *[example.substack.com/p/slug](https://example.substack.com/p/slug)*");
      expect(r.text).not.toMatch(/[—–]/);
    }
  });
  it("uses an alias when there is one, escaped", () => {
    const r = buildWebQuote({ ...input, alias: "A [post] by *me*" }, opts());
    expect(r.ok && r.text.split("\n").at(-1)).toBe("> *[A \\[post\\] by \\*me\\*](https://example.substack.com/p/slug)*");
  });
  it("follows the format for the whole block", () => {
    const r = buildWebQuote({ ...input, alias: "Slug" }, opts({ format: "{quote}\n\nSource: {link}" }));
    expect(r.ok && r.text).toBe("First line\nSecond line\n\nSource: [Slug](https://example.substack.com/p/slug)");
  });
  it("keeps the tracking parameters when switched off", () => {
    const r = buildWebQuote({ ...input, alias: "S" }, opts({ stripTracking: false }));
    expect(r.ok && r.text).toContain("(https://example.substack.com/p/slug?r=1&utm_medium=web)");
  });
  it("falls back to the default format, and says so, when the saved format is unusable", () => {
    const r = buildWebQuote({ ...input, alias: "S" }, opts({ format: "{nope}" }));
    expect(r).toMatchObject({ ok: true, formatFellBack: true });
    expect(r.ok && r.text).toBe("> First line\n> Second line\n> *[S](https://example.substack.com/p/slug)*");
  });
  it("refuses an empty quote or a bad address with the reason", () => {
    expect(buildWebQuote({ ...input, quote: " \n " }, opts())).toEqual({ ok: false, reason: "The quote is empty." });
    expect(buildWebQuote({ ...input, link: "nope" }, opts())).toMatchObject({ ok: false });
  });
});

describe("formState", () => {
  it("enables Insert only for a usable quote and address, and shows the block as it will be written", () => {
    expect(formState({ quote: "", link: "", alias: "" }, opts())).toEqual({ canInsert: false, linkProblem: "", preview: "", formatFellBack: false });
    expect(formState({ quote: "q", link: "", alias: "" }, opts()).canInsert).toBe(false);
    const half = formState({ quote: "", link: "https://example.com/a", alias: "" }, opts());
    expect(half.canInsert).toBe(false);
    expect(half.preview).toBe("> …\n> *[example.com/a](https://example.com/a)*"); // the quote not typed yet is a placeholder
    const full = formState({ quote: "q", link: "https://example.com/a", alias: "" }, opts());
    expect(full.canInsert).toBe(true);
    expect(full.preview).toBe("> q\n> *[example.com/a](https://example.com/a)*");
  });
  it("names a bad address only once something was typed", () => {
    expect(formState({ quote: "q", link: "", alias: "" }, opts()).linkProblem).toBe("");
    expect(formState({ quote: "q", link: "ftp://x", alias: "" }, opts()).linkProblem).toMatch(/http/);
  });
});

describe("planInsert", () => {
  const block = "> q\n> *[a](https://x.test/)*";
  const at = (line: number, ch = 0): Pos => ({ line, ch });
  it("on an empty line with blank lines on both sides adds no padding", () => {
    expect(planInsert(["intro", "", "", "", "outro"], at(2), at(2), block)).toEqual({ from: at(2), to: at(2), text: block });
  });
  it("adds a blank line where text touches the block above, below, or both", () => {
    expect(planInsert(["intro", "", "", "outro"], at(1), at(1), block).text).toBe(`\n${block}`);
    expect(planInsert(["", "", "outro"], at(1), at(1), block).text).toBe(`${block}\n`);
    expect(planInsert(["intro", "", "outro"], at(1), at(1), block).text).toBe(`\n${block}\n`);
  });
  it("starts a paragraph of its own when the cursor stands in text", () => {
    const p = planInsert(["before after"], { line: 0, ch: 6 }, { line: 0, ch: 6 }, block);
    expect(p.text).toBe(`\n\n${block}\n\n`);
    expect(p.from).toEqual({ line: 0, ch: 6 });
  });
  it("replaces a selection", () => {
    const p = planInsert(["x quote here y"], { line: 0, ch: 2 }, { line: 0, ch: 12 }, block);
    expect(p.from).toEqual({ line: 0, ch: 2 });
    expect(p.to).toEqual({ line: 0, ch: 12 });
  });
  it("takes in white space around the cursor so an indent cannot turn the block into code", () => {
    const p = planInsert(["      "], { line: 0, ch: 6 }, { line: 0, ch: 6 }, block);
    expect(p.from).toEqual({ line: 0, ch: 0 });
    expect(p.text).toBe(block);
  });
});

describe("a web quote next to a blyg thread's directive", () => {
  const ID = "dq6263yx1daeym5dx8p1byfdz8";
  const quote = buildWebQuote({ quote: "A passage from elsewhere", link: "https://example.com/post", alias: "Elsewhere" }, opts());
  const text = quote.ok ? quote.text : "";
  it("is read as plain prose, not as a partial quote, when a blank line separates them", () => {
    const scan = scanThread(`![[${ID}]]\n\n${text}\n\nMy answer.`);
    expect(scan.ok).toBe(true);
    if (scan.ok) expect(scan.directives).toEqual([{ id: ID, quoteMd: null, line: 1 }]);
  });
  it("would be read as the directive's partial quote without the blank line (why planInsert adds it)", () => {
    const scan = scanThread(`![[${ID}]]\n${text}\n\nMy answer.`);
    expect(scan.ok).toBe(true);
    if (scan.ok) expect(scan.directives[0]?.quoteMd).toContain("A passage from elsewhere");
  });
  it("planInsert puts the blank line there when the cursor is directly under a directive", () => {
    const lines = [`![[${ID}]]`, "", "My answer."];
    const p = planInsert(lines, { line: 1, ch: 0 }, { line: 1, ch: 0 }, text);
    expect(p.text.startsWith("\n")).toBe(true);
    const merged = `${lines[0]}\n${lines[1]}${p.text}\n${lines[2]}`; // what the editor holds after the edit
    const scan = scanThread(merged);
    expect(scan.ok && scan.directives[0]?.quoteMd).toBeNull();
  });
});

describe("the saved draft", () => {
  it("round-trips and survives garbage", () => {
    const d = { quote: "q", link: "https://x.test/", alias: "a" };
    expect(parseDraft(JSON.stringify(d))).toEqual(d);
    for (const bad of [null, undefined, 3, "", "{", "[]", '{"quote":5}']) expect(draftIsEmpty(parseDraft(bad))).toBe(true);
  });
});
