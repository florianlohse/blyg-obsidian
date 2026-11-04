import { describe, expect, it } from "vitest";
import { stripBlockIds, stripObsidianComments } from "../../src/core/comments";
import { diffText } from "../../src/core/diff";
import { extractWikilinks } from "../../src/core/links";

const strip = (t: string) => {
  const r = stripObsidianComments(t);
  if (!r.ok) throw new Error("unclosed");
  return r.text;
};

describe("block ids (^id) are taken off the end of a line", () => {
  it("removes the id and the space before it, and reports what it removed", () => {
    expect(stripBlockIds("A thought. ^ab12cd\n\nNext.\n")).toEqual({ text: "A thought.\n\nNext.\n", ids: [{ id: "ab12cd", excerpt: "A thought." }] });
    expect(stripBlockIds("one ^a-1\ntwo ^b2").ids.map((i) => i.id)).toEqual(["a-1", "b2"]);
  });

  it("a line that is only an id disappears, and the id is credited to the block above", () => {
    expect(stripBlockIds("| a | b |\n| - | - |\n\n^tbl1\nnext")).toEqual({ text: "| a | b |\n| - | - |\n\nnext", ids: [{ id: "tbl1", excerpt: "| - | - |" }] });
  });

  it("leaves carets that are not an id at the end of a line alone", () => {
    for (const t of ["x^2 is a square", "see [[Note#^ab12cd]]", "a ^b c", "link https://x.test/#^abc", "caret ^ at the end ^"]) {
      expect(stripBlockIds(t).text, t).toBe(t);
    }
  });

  it("treats code as literal and keeps CRLF line ends", () => {
    expect(stripBlockIds("```\ncode ^keep\n```\ntext ^gone\n").text).toBe("```\ncode ^keep\n```\ntext\n");
    expect(stripBlockIds("a ^x1\r\nb\r\n").text).toBe("a\r\nb\r\n");
  });

  it("cuts a long excerpt", () => {
    const r = stripBlockIds(`${"word ".repeat(30)}^zz9`);
    expect(r.ids[0]?.excerpt.length).toBe(40);
    expect(r.ids[0]?.excerpt.endsWith("…")).toBe(true);
  });

  it("stripObsidianComments does it after the comments: hidden marks leave the id bare, then the id goes", () => {
    const r = stripObsidianComments("A thought. %%[[Topic]] \u2B50\uFE0F\u2B50\uFE0F%% ^ab12cd\n");
    expect(r).toEqual({ ok: true, text: "A thought.\n", removed: 1, blockIds: [{ id: "ab12cd", excerpt: "A thought." }] });
  });
});

describe("stripObsidianComments", () => {
  it("removes inline comments and leaves the rest of the line", () => {
    expect(strip("Hello %%secret%% world")).toBe("Hello  world");
    expect(strip("a %%x%% b %%y%% c")).toBe("a  b  c");
  });

  it("removes a comment that fills a line together with the line, and multi-line comments", () => {
    expect(strip("one\n%%private note%%\ntwo\n")).toBe("one\ntwo\n");
    expect(strip("one\n  %%private%%  \ntwo")).toBe("one\ntwo");
    expect(strip("one\n%%\nline a\nline b\n%%\ntwo\n")).toBe("one\ntwo\n");
    expect(strip("start %%multi\nline%% end")).toBe("start  end");
  });

  it("handles comments at the very start and end of the text", () => {
    expect(strip("%%first%%\nbody")).toBe("body");
    expect(strip("body\n%%last%%")).toBe("body\n");
    expect(strip("body %%last%%")).toBe("body ");
  });

  it("leaves text without comments untouched, byte for byte", () => {
    const t = "A 100% sure thing.\n\n50%% off? no: this has %% only once\n";
    // two `%%` do pair up in Obsidian's grammar, so this one is a comment:
    expect(stripObsidianComments("100%").ok).toBe(true);
    expect(strip("plain text\nno comments\n")).toBe("plain text\nno comments\n");
    expect(stripObsidianComments(t).ok).toBe(true);
  });

  it("treats code as literal: fenced blocks and inline code keep their %%", () => {
    expect(strip("```\n%%not a comment%%\n```\nafter")).toBe("```\n%%not a comment%%\n```\nafter");
    expect(strip("~~~js\n%% x\n~~~\n")).toBe("~~~js\n%% x\n~~~\n");
    expect(strip("use `%%` for comments %%gone%% ok")).toBe("use `%%` for comments  ok");
    expect(strip("``a %% b`` %%gone%%")).toBe("``a %% b`` ");
  });

  it("a fence only closes with the same character and at least the same length", () => {
    expect(strip("````\n```\n%%still code%%\n````\n%%gone%%\nx")).toBe("````\n```\n%%still code%%\n````\nx");
  });

  it("refuses an opening %% that never closes (never guesses what to publish)", () => {
    expect(stripObsidianComments("fine\nthen %% oops\nmore text")).toEqual({ ok: false, reason: "unclosed", line: 2 });
    expect(stripObsidianComments("%%a%% and %%b")).toMatchObject({ ok: false, reason: "unclosed" });
  });

  it("counts what it removed", () => {
    expect(stripObsidianComments("%%a%% x %%b%%")).toMatchObject({ ok: true, removed: 2 });
  });
});

describe("extractWikilinks", () => {
  it("finds links and embeds, strips alias, heading and block parts, de-duplicates", () => {
    const links = extractWikilinks("See [[Plan A]] and [[Plan A|the plan]] and [[Plan B#Goals]] and [[Plan C#^abc]] and ![[Diagram.png]].");
    expect(links).toEqual([
      { target: "Plan A", embed: false },
      { target: "Plan B", embed: false },
      { target: "Plan C", embed: false },
      { target: "Diagram.png", embed: true },
    ]);
  });

  it("ignores code, empty targets, same-note heading links and Blyg ids", () => {
    expect(extractWikilinks("`[[in code]]`\n```\n[[in fence]]\n```\n[[#Heading]] [[]] [[7c9wk2mhq0v3xj8tn5rzfd41bg]] [[real one]]")).toEqual([
      { target: "real one", embed: false },
    ]);
  });

  it("treats a link and an embed of the same name as different entries", () => {
    expect(extractWikilinks("[[x]] ![[x]]")).toHaveLength(2);
  });
});

describe("diffText", () => {
  const changed = (d: ReturnType<typeof diffText>) => d.blocks.filter((b) => b.kind === "change");

  it("says identical texts are identical", () => {
    expect(diffText("same\ntext\n", "same\ntext\n")).toMatchObject({ identical: true, addedWords: 0, removedWords: 0 });
  });

  it("finds a single word change inside a long line", () => {
    const d = diffText("The quick brown fox jumps.\n", "The quick red fox jumps.\n");
    expect(d).toMatchObject({ identical: false, addedWords: 1, removedWords: 1 });
    const ops = (changed(d)[0] as { ops: { type: string; text: string }[] }).ops;
    expect(ops.filter((o) => o.type === "del").map((o) => o.text)).toEqual(["brown"]);
    expect(ops.filter((o) => o.type === "add").map((o) => o.text)).toEqual(["red"]);
  });

  it("handles additions and deletions of whole lines", () => {
    expect(diffText("a\nb\n", "a\nb\nc d\n")).toMatchObject({ addedWords: 2, removedWords: 0 });
    expect(diffText("a\nb c\nd\n", "a\nd\n")).toMatchObject({ addedWords: 0, removedWords: 2 });
  });

  it("keeps unchanged stretches as 'same' blocks around the change", () => {
    const d = diffText("l1\nl2\nl3 old\nl4\nl5\n", "l1\nl2\nl3 new\nl4\nl5\n");
    expect(d.blocks.map((b) => b.kind)).toEqual(["same", "change", "same"]);
  });

  it("is lossless: same+del reproduces before, same+add reproduces after", () => {
    const before = "Para one has words.\n\nPara two stays.\nThird line goes away.\nLast line.\n";
    const after = "Para one has more words.\n\nPara two stays.\nLast line, edited.\nBrand new line.\n";
    const d = diffText(before, after);
    const ops = d.blocks.flatMap((b) => (b.kind === "same" ? [{ type: "same" as const, text: b.text }] : b.ops));
    expect(ops.filter((o) => o.type !== "add").map((o) => o.text).join("")).toBe(before);
    expect(ops.filter((o) => o.type !== "del").map((o) => o.text).join("")).toBe(after);
  });

  it("copes with a large essay and a few scattered edits quickly", () => {
    const para = (i: number) => `Paragraph ${i} ` + "word ".repeat(40) + "\n";
    const before = Array.from({ length: 400 }, (_, i) => para(i)).join("");
    const after = Array.from({ length: 400 }, (_, i) => (i === 50 ? para(i).replace("word", "edited") : i === 350 ? "" : para(i))).join("");
    const t0 = Date.now();
    const d = diffText(before, after);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(d.identical).toBe(false);
    expect(d.removedWords).toBeGreaterThan(40);
  });

  it("falls back to a coarse change instead of hanging on pathological input", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 4000 }, (_, i) => `b${i}`).join(" ");
    const t0 = Date.now();
    const d = diffText(a, b);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(d.removedWords).toBe(4000);
    expect(d.addedWords).toBe(4000);
  });
});
