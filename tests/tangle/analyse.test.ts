import { describe, expect, it } from "vitest";
import { rewriteTangled, scanTangle, spanLabel, TANGLE_MAX } from "../../src/tangle/analyse";

const ID = "7c9wk2n4h6q1x8v0z3m5rjy2ke";
const codes = (t: string): string[] => scanTangle(t).issues.map((i) => i.code);

describe("spans ![[+ … ]]", () => {
  it("one line", () => {
    const s = scanTangle("Intro.\n\n![[+ a passage]]\n\nOutro.\n");
    expect(s.count).toBe(1);
    expect(s.issues).toEqual([]);
    expect(s.parts[0]).toMatchObject({ kind: "span", line: 3, endLine: 3, text: "a passage" });
  });
  it("over several lines and paragraphs", () => {
    const s = scanTangle("![[+ first\n\nsecond paragraph\nthird]]\nafter");
    expect(s.issues).toEqual([]);
    expect(s.parts[0]).toMatchObject({ line: 1, endLine: 4 });
  });
  it("opens with a line break after the marker", () => {
    expect(codes("![[+\nwords\n]]\n")).toEqual([]);
  });
  it("steps over links and directives when looking for the closer", () => {
    const t = `![[+ see [[Note]] and\n![[${ID} | label]]\nand [[${ID}]] end]]\n`;
    const s = scanTangle(t);
    expect(s.issues).toEqual([]);
    expect(s.count).toBe(1);
    expect(s.parts[0]?.end).toBe(t.trimEnd().length);
  });
  it("refuses: opener not at line start", () => {
    expect(codes("text ![[+ a]]\n")).toEqual(["opener-not-at-line-start"]);
    expect(codes(" ![[+ a]]\n")).toEqual(["opener-not-at-line-start"]);
  });
  it("refuses: no space after the opener", () => {
    expect(codes("![[+a]]\n")).toEqual(["no-space-after-opener"]);
  });
  it("refuses: no closer", () => {
    expect(codes("![[+ a passage\nthat never ends\n")).toEqual(["no-closer"]);
  });
  it("refuses: closer not at line end", () => {
    expect(codes("![[+ a]] and more\n")).toEqual(["closer-not-at-line-end"]);
  });
  it("refuses: empty span", () => {
    expect(codes("![[+ ]]\n")).toEqual(["empty-span"]);
    expect(codes("![[+\n\n]]\n")).toEqual(["empty-span"]);
  });
  it("refuses: a span inside a span, a placeholder inside a span", () => {
    expect(codes("![[+ a\n![[+ b]]\n]]\n")).toContain("span-in-span");
    expect(codes("![[+ a [[+ idea]] b]]\n")).toContain("placeholder-in-span");
  });
  it("refuses: an attached image inside a span", () => {
    expect(codes("![[+ look ![pic](blyg-media:abc123)]]\n")).toContain("image-in-span");
  });
  it("is inert in code, /* */ and %% comments", () => {
    const t = "```\n![[+ x]]\n```\n\n`![[+ y]]` and `[[+ z]]`\n\n/* ![[+ c]]\n[[+ d]] */\n\n%% ![[+ e]] %%\n";
    expect(scanTangle(t).count).toBe(0);
    expect(scanTangle(t).issues).toEqual([]);
  });
});

describe("placeholders [[+ idea]]", () => {
  it("inline, one line", () => {
    const s = scanTangle("A thought about [[+ the idea]] and more.\n");
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0]).toMatchObject({ kind: "placeholder", line: 1, text: "the idea" });
  });
  it("not after !, and not without a blank after the plus", () => {
    expect(scanTangle("x ![[+ a]] y").parts.filter((p) => p.kind === "placeholder")).toHaveLength(0);
    expect(scanTangle("[[+x]] [[+]]").count).toBe(0);
  });
  it("refuses an empty one", () => {
    expect(codes("a [[+  ]] b")).toEqual(["empty-placeholder"]);
  });
  it("does not run over lines", () => {
    expect(scanTangle("[[+ one\ntwo]]").count).toBe(0);
  });
});

describe("one count, one cap", () => {
  it("spans and placeholders share it, in source order", () => {
    const s = scanTangle("![[+ a]]\n\nand [[+ b]]\n\n![[+ c]]\n");
    expect(s.parts.map((p) => p.kind)).toEqual(["span", "placeholder", "span"]);
    expect(s.count).toBe(3);
    expect(s.overCap).toBe(false);
  });
  it(`${TANGLE_MAX} is allowed, one more is over`, () => {
    const make = (n: number): string => Array.from({ length: n }, (_, i) => `![[+ p${i}]]`).join("\n\n");
    expect(scanTangle(make(TANGLE_MAX)).overCap).toBe(false);
    expect(scanTangle(make(TANGLE_MAX + 1)).overCap).toBe(true);
  });
});

describe("spanLabel", () => {
  it("first eight words, ellipsis when cut", () => {
    expect(spanLabel("one two three four five six seven eight nine")).toBe("one two three four five six seven eight…");
    expect(spanLabel("one two three")).toBe("one two three");
  });
  it("leaves directive lines out, and bars and brackets", () => {
    expect(spanLabel(`![[${ID}]]\nreal | words [x]`)).toBe("real words x");
    expect(spanLabel(`![[${ID}]]`)).toBe("");
  });
});

describe("rewriteTangled (what the Studio does to its working copy, done to the note)", () => {
  const A = "01aaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "01bbbbbbbbbbbbbbbbbbbbbbbb";
  it("a span becomes a directive line with a blank line after it", () => {
    const r = rewriteTangled("Intro.\n\n![[+ the cheapest way to find what I think]]\n> quoted\n", [A]);
    expect(r).toEqual({ ok: true, text: `Intro.\n\n![[${A} | the cheapest way to find what I think]]\n\n> quoted\n` });
  });
  it("keeps an existing blank line, adds none at the end of the text", () => {
    expect(rewriteTangled("![[+ a b]]\n\nnext", [A])).toEqual({ ok: true, text: `![[${A} | a b]]\n\nnext` });
    expect(rewriteTangled("![[+ a b]]", [A])).toEqual({ ok: true, text: `![[${A} | a b]]` });
  });
  it("a placeholder becomes [[id | anchor]], inline", () => {
    expect(rewriteTangled("About [[+ slow reading]] here.", [A])).toEqual({ ok: true, text: `About [[${A} | slow reading]] here.` });
  });
  it("mixed, ids in source order", () => {
    const r = rewriteTangled("![[+ one]]\n\nand [[+ two]]\n", [A, B]);
    expect(r).toEqual({ ok: true, text: `![[${A} | one]]\n\nand [[${B} | two]]\n` });
  });
  it("a long span is cut to eight words", () => {
    const r = rewriteTangled("![[+ 1 2 3 4 5 6 7 8 9 10]]\n", [A]);
    expect(r).toEqual({ ok: true, text: `![[${A} | 1 2 3 4 5 6 7 8…]]\n` });
  });
  it("refuses when the counts differ or the text has an issue; the text is then not changed", () => {
    expect(rewriteTangled("![[+ a]]\n", [A, B]).ok).toBe(false);
    expect(rewriteTangled("![[+ a]] more\n", [A]).ok).toBe(false);
    expect(rewriteTangled("no parts\n", [A]).ok).toBe(false);
  });
  it("is idempotent once rewritten: the result holds no parts", () => {
    const r = rewriteTangled("![[+ a b]]\n", [A]);
    expect(r.ok && scanTangle(r.text).count).toBe(0);
  });
});
