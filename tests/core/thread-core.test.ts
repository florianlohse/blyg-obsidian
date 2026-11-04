// R3 core: the text-content port, the thread grammar and the quote subset, against the site's shared fixtures
// (tests/fixtures/site/threads/, copied from the site repo's docs/fixtures/threads/; the site's tests run the same files).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderQuoteSelection, quoteFromSelection } from "../../src/core/quote";
import { leftoverEmbeds, scanThread } from "../../src/core/thread";
import {
  excerptFromHtml,
  excerptFromText,
  graphemePrefix,
  locateSelection,
  normalizeSelection,
  plainTextFromHtml,
  quoteLines,
  selectionText,
} from "../../src/core/textContent";

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/site/threads/${name}`, import.meta.url), "utf8")) as T;

interface SelectionFixtures {
  selectionText: Array<{ name: string; html: string; text: string }>;
  normalizeSelection: Array<{ name: string; input: string; output: string }>;
  quoteLines: Array<{ name: string; selection: string; quote: string }>;
  selectionFromQuote: Array<{ name: string; quote: string; selection: string }>;
}
interface DirectiveFixtures {
  cases: Array<{ name: string; md: string; directives: Array<{ id: string; quote: string | null }>; links: string[]; problems: number }>;
}
const selection = load<SelectionFixtures>("selection.json");
const directives = load<DirectiveFixtures>("directives.json");

describe("text content (a port of the reference's normaliser; the site's cases)", () => {
  for (const c of selection.selectionText) it(`selectionText: ${c.name}`, () => expect(selectionText(c.html)).toBe(c.text));
  for (const c of selection.normalizeSelection) it(`normalizeSelection: ${c.name}`, () => expect(normalizeSelection(c.input)).toBe(c.output));
  for (const c of selection.quoteLines) it(`quoteLines: ${c.name}`, () => expect(quoteLines(c.selection)).toBe(c.quote));

  it("plain text puts a space where blocks end, so sentences do not weld", () => {
    expect(plainTextFromHtml("<p>evil.</p><p>Next</p>")).toBe("evil. Next");
  });

  it("cuts an excerpt on a grapheme boundary and adds an ellipsis only when it cut", () => {
    expect(excerptFromText("short")).toBe("short");
    expect(excerptFromText("x".repeat(60))).toBe("x".repeat(60));
    expect(excerptFromText("x".repeat(61))).toBe(`${"x".repeat(60)}…`);
    // 59 letters then a family emoji (11 UTF-16 units): cutting at 60 must not split it
    const family = "👨‍👩‍👧‍👦";
    expect(graphemePrefix(`${"a".repeat(59)}${family}`, 60)).toBe("a".repeat(59));
    expect(excerptFromHtml(`<p>${"a".repeat(59)}${family}</p>`)).toBe(`${"a".repeat(59)}…`);
  });

  it("locates a selection and records up to 32 characters of context either side of the first match", () => {
    const html = "<p>Coordination is hard.</p>\n<p>Stigmergy is what a protocol looks like from inside. And more.</p>";
    expect(locateSelection(html, "Stigmergy is what a protocol looks like from inside.")).toEqual({
      exact: "Stigmergy is what a protocol looks like from inside.",
      prefix: "Coordination is hard.\n", // the context is taken from the flattened text, where the blocks are joined by a line break
      suffix: " And more.",
    });
    expect(locateSelection(html, "not in there")).toBeNull();
    expect(locateSelection("<p>“yes” he said</p>", '"yes"')).toBeNull(); // straight quotes do not match the site's curly ones
  });
});

describe("thread grammar (docs/CONTRACT.md §3.3, option a′: the site's answer, or a refusal, never a different answer)", () => {
  const refused: string[] = [];
  for (const c of directives.cases) {
    it(c.name, () => {
      const scan = scanThread(c.md);
      if (!scan.ok) {
        refused.push(c.name);
        expect(scan.problems.length).toBeGreaterThan(0);
        return;
      }
      expect(c.problems, "the site found a grammar problem the plugin did not").toBe(0);
      expect(scan.directives.map((d) => ({ id: d.id, quote: d.quoteMd }))).toEqual(c.directives);
      expect(scan.links).toEqual([...new Set(c.links)]);
    });
  }

  it("refuses only where an id might be inside code (the list must not quietly grow into 'refuse everything')", () => {
    expect(refused.sort()).toEqual(
      [
        "a directive after a closed fence is live",
        "an explicit version is refused",
        "inert in a backtick fence",
        "inert in a fence inside a list item",
        "inert in a tilde fence",
        "inert in an indented code block",
        "plain links are inert in code",
      ].sort(),
    );
  });

  const A = "7c9wk2mhq0v3xj8tn5rzfd41bg";
  const B = "1vgtgz0gq5b2c9k7d3m8r4n6xy";

  it("a body that mentions no item id is never refused, whatever code it has", () => {
    expect(scanThread("```\ncode\n```\n\n    indented\n\n`span` text")).toEqual({ ok: true, directives: [], links: [] });
  });

  it("records the line of each directive and an attached quote runs to the first non-quote line", () => {
    const scan = scanThread(`intro\n\n![[${A}]]\n> one\n> two\nafter\n\n![[${B}]]`);
    expect(scan).toEqual({
      ok: true,
      directives: [
        { id: A, quoteMd: "one\ntwo", line: 3 },
        { id: B, quoteMd: null, line: 8 },
      ],
      links: [],
    });
  });

  it("finds links in prose and in other quotes, ignores an inline embed and a link inside a directive's quote", () => {
    const scan = scanThread(`See [[${A}]] and [[${B}]] and again [[${A}]].\n\nInline ![[${B}]] is text.\n\n> a quote with [[${B}]] in it\n\n![[${A}]]\n> inside [[${B}]]`);
    expect(scan).toMatchObject({ ok: true, links: [A, B] });
  });

  it("refuses an indented directive or link, a link next to a backtick, and says where", () => {
    const indented = scanThread(`text\n\n    ![[${A}]]`);
    expect(indented).toMatchObject({ ok: false });
    expect(!indented.ok && indented.problems.join(" ")).toMatch(/line 3.*indented/);
    const tab = scanThread(`\t[[${A}]]`);
    expect(tab.ok).toBe(false);
    const quoted = scanThread(`>     [[${A}]]`);
    expect(quoted.ok).toBe(false);
    const ticks = scanThread(`Some \`code\` and [[${A}]]`);
    expect(!ticks.ok && ticks.problems.join(" ")).toMatch(/backtick/);
    // the backtick is in another paragraph: fine
    expect(scanThread(`Some \`code\`\n\n[[${A}]]`)).toMatchObject({ ok: true, links: [A] });
    // an escaped backtick cannot open a code span
    expect(scanThread(`Not \\\`code\\\` and [[${A}]]`)).toMatchObject({ ok: true, links: [A] });
  });

  it("three spaces of indentation are still a directive", () => {
    expect(scanThread(`   ![[${A}]]`)).toMatchObject({ ok: true, directives: [{ id: A }] });
  });
});

describe("the quote subset (plain-text quotes only; everything else is refused with a reason)", () => {
  for (const c of selection.selectionFromQuote) {
    it(`site case: ${c.name}`, () => {
      const r = renderQuoteSelection(c.quote);
      if (r.ok) expect(r.selection).toBe(c.selection);
      else expect(r.reason.length).toBeGreaterThan(0);
    });
  }

  it("covers the plain cases of the site's list, so the fixtures cannot hide a subset that accepts nothing", () => {
    const accepted = selection.selectionFromQuote.filter((c) => renderQuoteSelection(c.quote).ok).map((c) => c.name);
    expect(accepted).toEqual([
      "plain text",
      "soft wraps collapse",
      "two paragraphs stay two lines",
      "straight quotes stay straight (no typography in the selection)",
      "empty after rendering",
      "an ampersand and angle brackets survive",
    ]);
  });

  it("resolves backslash escapes and keeps literal curly quotes and apostrophes", () => {
    expect(renderQuoteSelection("a \\*star\\* and \\[x\\] and 2 \\< 3")).toEqual({ ok: true, selection: "a *star* and [x] and 2 < 3" });
    expect(renderQuoteSelection("“Don’t,” she said.")).toEqual({ ok: true, selection: "“Don’t,” she said." });
    expect(renderQuoteSelection("C:\\temp")).toEqual({ ok: true, selection: "C:\\temp" }); // a backslash before a letter is literal
  });

  it.each([
    ["emphasis", "the *thin* layer", /emphasis/],
    ["strong", "**more**", /emphasis|starts with/],
    ["underscore emphasis", "an _idea_ here", /emphasis/],
    ["a link", "see [layer](https://example.com)", /square brackets/],
    ["code", "use `x`", /backtick/],
    ["a heading", "# Title", /starts with/],
    ["a list", "- one\n- two", /starts with/],
    ["a numbered list", "1. one", /numbered/],
    ["a nested quote", "> inner", /starts with/],
    ["a tag", "use <tags> here", /“<”/],
    ["an entity", "Tom &amp; Jerry", /entity/],
    ["a table bar", "a | b", /vertical bar/],
    ["a hard break", "line one  \nline two", /hard line break/],
    ["a trailing backslash", "line one\\\nline two", /backslash/],
    ["indented code", "    code", /indented/],
    ["a rule", "---", /starts with/],
    ["strikethrough", "~~gone~~", /tilde|starts with/],
  ])("refuses %s", (_name, quote, reason) => {
    const r = renderQuoteSelection(quote);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(reason);
  });

  it("accepts a star or underscore that cannot be emphasis", () => {
    expect(renderQuoteSelection("2 * 3 = 6")).toEqual({ ok: true, selection: "2 * 3 = 6" });
    expect(renderQuoteSelection("the snake_case_name stays")).toEqual({ ok: true, selection: "the snake_case_name stays" });
    expect(renderQuoteSelection("a_b and c*d")).toMatchObject({ ok: false }); // `*` inside a word is emphasis
  });

  it("an attached quote is paragraphs: a bare line separates blocks", () => {
    expect(renderQuoteSelection("First.\n\nSecond.\nstill second")).toEqual({ ok: true, selection: "First.\nSecond. still second" });
  });
});

describe("quoteFromSelection: what the picker writes always renders back to the selected text", () => {
  const roundTrip = (selected: string): string | undefined => {
    const selectionOf = normalizeSelection(selected);
    if (selectionOf === "") return undefined;
    const md = quoteFromSelection(selectionOf);
    if (md === null) return "CANNOT";
    const scan = scanThread(`![[7c9wk2mhq0v3xj8tn5rzfd41bg]]\n${md}`);
    if (!scan.ok) return `REFUSED by the grammar: ${scan.problems.join("; ")}`;
    const quote = scan.directives[0]?.quoteMd;
    if (quote === null || quote === undefined) return "NO QUOTE";
    const r = renderQuoteSelection(quote);
    return r.ok ? r.selection : `REFUSED by the subset: ${r.reason}`;
  };

  it("writes plain text as it is and puts a bare > between blocks", () => {
    expect(quoteFromSelection("one\ntwo")).toBe("> one\n>\n> two");
    expect(quoteFromSelection("It’s “fine”, isn't it? 2 * 3, snake_case, a < b & c.")).toBe("> It’s “fine”, isn't it? 2 * 3, snake_case, a < b & c.");
  });

  it("escapes what Markdown would read as syntax", () => {
    expect(quoteFromSelection("*star* and _under_ [link](x) `code` ~~s~~ a|b <tag> &amp; \\")).toBe(
      "> \\*star\\* and \\_under\\_ \\[link\\](x) \\`code\\` \\~\\~s\\~\\~ a\\|b \\<tag> \\&amp; \\\\",
    );
    expect(quoteFromSelection("# not a heading")).toBe("> \\# not a heading");
    expect(quoteFromSelection("- not a list")).toBe("> \\- not a list");
    expect(quoteFromSelection("1. not a list")).toBe("> 1\\. not a list");
    expect(quoteFromSelection("> not a quote")).toBe("> \\> not a quote");
    expect(quoteFromSelection("* not a bullet")).toBe("> \\* not a bullet");
    expect(quoteFromSelection("___")).toBe("> \\_\\_\\_");
  });

  it("cannot quote a web address next to characters that need escaping (escapes do not work inside an automatic link)", () => {
    // Found 2026-10-10 by running generated quotes through the site's own parser: `http://a.b/c\]` keeps its backslash there.
    expect(quoteFromSelection("see https://example.com/a [b]")).toBe("> see https://example.com/a \\[b\\]"); // the bracket is a different word: fine
    expect(quoteFromSelection("see https://example.com/a]")).toBeNull();
    expect(quoteFromSelection("<http://auto.link>")).toBeNull();
    expect(quoteFromSelection("mail me@example.com`")).toBeNull();
    expect(quoteFromSelection("www.example.com~")).toBeNull();
    const hidden = renderQuoteSelection("see https://example.com/a\\]");
    expect(hidden.ok).toBe(false);
    expect(!hidden.ok && hidden.reason).toMatch(/web or e-mail address/);
    expect(renderQuoteSelection("see https://example.com/a_b_c and www.example.com.")).toMatchObject({ ok: true });
  });

  it("gives back exactly the selected text for a pile of awkward ones", () => {
    const awkward = [
      "plain sentence.",
      "*emphasis* **strong** ***both*** _under_ __dunder__",
      "[a link](https://example.com) and [ref][1] and ![img](x.png)".replace("(https://example.com)", " (https://example.com )"),
      "`code` and ``double`` and ```fence```",
      "# heading\n## two\n- bullet\n+ plus\n* star\n1. one\n2) two\n> quote\n---\n===\n***\n___",
      "a < b, c <d>, <b>bold</b>, x<y",
      "Tom &amp; Jerry &#35; &#x23; &copy; & &; &x",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      ":--: and :-",
      "back\\slash \\* \\\\ trailing\\",
      "“curly” ‘single’ it’s — dash… ellipsis",
      "www.example.com and https://example.com/a_b_c and mail@example.com",
      "~strike~ and ~~strike~~ and ~~~",
      "   leading spaces\n\ttab line",
      "snake_case_name and 2*3*4 and a * b * c",
      "emoji 👨‍👩‍👧‍👦 and ünïcödé",
      "- ",
      "#hashtag @mention $money ^caret {brace}",
    ];
    for (const text of awkward) expect(roundTrip(text), JSON.stringify(text)).toBe(normalizeSelection(text));
  });

  it("round-trips generated selections (deterministic pseudo-random strings over the characters that matter)", () => {
    const alphabet = ["a", "b", " ", " ", "\n", "*", "_", "`", "[", "]", "(", ")", "<", ">", "&", ";", "#", "-", "+", "=", "~", "|", "\\", "!", ":", "1", ".", "“", "’", "x"];
    let seed = 12345;
    let cannot = 0;
    const next = (): number => {
      // mulberry32 (a multiplicative LCG loses precision above 2^53 and repeats quickly)
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    for (let n = 0; n < 4000; n++) {
      let s = "";
      const length = 1 + (next() % 24);
      for (let i = 0; i < length; i++) s += alphabet[next() % alphabet.length];
      const expected = normalizeSelection(s);
      if (expected === "") continue;
      const got = roundTrip(s);
      if (got === "CANNOT") {
        cannot++;
        continue;
      }
      expect(got, JSON.stringify(s)).toBe(expected);
    }
    expect(cannot, "a web address in the text is rare in this alphabet; 'cannot' must stay rare").toBe(0);
  });
});

describe("leftoverEmbeds (every ![[ the site would show as literal brackets)", () => {
  const A = "7c9wk2mhq0v3xj8tn5rzfd41bg";
  const left = (md: string): string[] => {
    const scan = scanThread(md);
    return leftoverEmbeds(md, scan.ok ? scan.directives : []);
  };
  it("finds inline embeds, images, broken ones and stray punctuation, with the line", () => {
    expect(left("a ![[x]] b")).toEqual(["line 1: ![[x]] b"]);
    expect(left("ok\n\n![[pic.png]]")).toEqual(["line 3: ![[pic.png]]"]);
    expect(left("![[![[0123456789abcdefghjkmnpqrs]]")).toEqual(["line 1: ![[![[0123456789abcdefghjkmnpqrs]]"]);
    expect(left(`![[${A}]]\``)).toHaveLength(1);
  });
  it("does not count directives, their attached quotes, code, or links", () => {
    expect(left(`![[${A}]]\n> a passage\n> more\n\nText with \`![[x]]\` code.\n\nAnd a [[${A}]] link.`)).toEqual([]);
    expect(left("```\n![[y]]\n```")).toEqual([]); // a fence is code (and there is no id here to doubt)
    expect(left("no embeds at all")).toEqual([]);
  });
});
