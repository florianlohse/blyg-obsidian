// E9 (docs/plans/E9-thread-quote-extent.md): Studio 0.50+ gives a partial quote CommonMark's blockquote extent, lazy continuation included.
// A line directly under the `>` run, with no `>` of its own and no blank line, is part of the quoted passage there and the author's own
// words on 0.49 (and in the plugin's own reading). Such a thread is refused on a Studio route, naming the line.
import { describe, expect, it } from "vitest";
import { lazyQuoteLines, prepareStudioText, refusalFor } from "../../src/studio/text";
import { makeStudioWorld, tapStudio } from "./world";

const ID = "095s4h48j67mnbf6hq8vatc2d4";
const ID2 = "095s4h48j67mnbf6hq8vatc2d5";

describe("lines that CommonMark would read as part of a partial quote", () => {
  it("the changelog's own example: a line under the quote with no blank line", () => {
    expect(lazyQuoteLines(`![[${ID}]]\n> the quoted passage\nand then a line of my own`)).toEqual([3]);
  });
  it("a blank line after the quote, or '>' on the line, is fine", () => {
    expect(lazyQuoteLines(`![[${ID}]]\n> the quoted passage\n\nand then a line of my own`)).toEqual([]);
    expect(lazyQuoteLines(`![[${ID}]]\n> the quoted passage\n> and a quoted line of mine\n`)).toEqual([]);
  });
  it("a whole quotation (no '>' lines) has no extent to get wrong", () => {
    expect(lazyQuoteLines(`![[${ID}]]\nmy next line`)).toEqual([]);
  });
  it("a directive line (also with a label, or the reserved @vN form) is never a continuation: it ends the selection", () => {
    expect(lazyQuoteLines(`![[${ID}]]\n> a passage\n![[${ID2}]]`)).toEqual([]);
    expect(lazyQuoteLines(`![[${ID}]]\n> a passage\n![[${ID2} | label]]`)).toEqual([]);
    expect(lazyQuoteLines(`![[${ID}]]\n> a passage\n![[${ID2}@v2]]`)).toEqual([]);
  });
  it("blocks that interrupt a paragraph end the quote too: heading, fence, rule, bullet, '1.' list", () => {
    for (const next of ["# A heading", "## Two", "```", "~~~js", "---", "***", "- item", "* item", "+ item", "1. first", "1) first"]) {
      expect(lazyQuoteLines(`![[${ID}]]\n> a passage\n${next}`), next).toEqual([]);
    }
  });
  it("things that cannot interrupt a paragraph are lazy continuation: '2.' lists, an empty bullet, indented text, '===', plain text, a link", () => {
    for (const next of ["2. second", "-", "    indented", "===", "see [[Another note]]", "**bold** words", "> "]) {
      const hits = lazyQuoteLines(`![[${ID}]]\n> a passage\n${next}`);
      expect(hits, next).toEqual(next === "> " ? [] : [3]);
    }
  });
  it("a directive inside a code span or fence is not a directive, so nothing is reported for it", () => {
    expect(lazyQuoteLines("```\n![[" + ID + "]]\n> not a quote\ntext\n```")).toEqual([]);
  });
  it("reports every directive's trailing line, with the line numbers of the text as sent", () => {
    expect(lazyQuoteLines(`intro\n\n![[${ID}]]\n> one\nlazy one\n\n![[${ID2}]]\n> two\nlazy two`)).toEqual([5, 9]);
  });
});

describe("a thread on a Studio route", () => {
  const ctx = { vault: makeStudioWorld().deps.vault, routes: [], fromPath: "studio/T.md", origin: "https://studio.test/", fragmentCharCap: 1000 };
  it("is refused with a message that names the line and what to do", () => {
    const out = prepareStudioText(`Opening.\n\n![[${ID}]]\n> passage\nmy own words\n`, "thread", ctx);
    expect(out.problems).toEqual([{ kind: "lazy-quote", lines: [5] }]);
    const message = refusalFor(out.problems[0] ?? { kind: "empty" });
    expect(message).toMatch(/Line 5 sits directly under a quote/);
    expect(message).toMatch(/blank line after the quote, or put “>” in front/);
    expect(message).toMatch(/Nothing was sent/);
  });
  it("a fragment has no quotes, so the check does not apply to it", () => {
    expect(prepareStudioText("Just words.", "fragment", ctx).problems).toEqual([]);
  });
  it("the publish is refused before any request", async () => {
    const w = makeStudioWorld({ vault: { "studio/T.md": `---\nblyg_kind: thread\n---\nOpening.\n\n![[${ID}]]\n> passage\nmy own words\n` } });
    w.studio.importItem({ remote_id: ID, content_md: "passage" });
    const out = await tapStudio(w, "studio/T.md");
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/Line 5 sits directly under a quote/);
    expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
  });
});
