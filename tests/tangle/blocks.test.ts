import { describe, expect, it } from "vitest";
import { blockEmbeds, newBlockId, paragraphAt, readBlockMap, withBlockId } from "../../src/tangle/blocks";

const NOTE = "---\ntitle: x\n---\n# Heading\n\nFirst paragraph\nsecond line.\n\n- a list item\n\nLast one ^ab12\n\n```\ncode here\n```\n\n> quoted\n";

describe("paragraphAt", () => {
  it("a paragraph of two lines, from either line", () => {
    for (const line of [6, 7]) expect(paragraphAt(NOTE, line)).toEqual({ ok: true, paragraph: { startLine: 6, endLine: 7, text: "First paragraph\nsecond line.", blockId: null } });
  });
  it("takes the block id off the end and reports it", () => {
    expect(paragraphAt(NOTE, 11)).toEqual({ ok: true, paragraph: { startLine: 11, endLine: 11, text: "Last one", blockId: "ab12" } });
  });
  it("says why a line is not a paragraph", () => {
    expect(paragraphAt(NOTE, 2)).toEqual({ ok: false, problem: "properties" });
    expect(paragraphAt(NOTE, 4)).toEqual({ ok: false, problem: "heading" });
    expect(paragraphAt(NOTE, 5)).toEqual({ ok: false, problem: "blank" });
    expect(paragraphAt(NOTE, 9)).toEqual({ ok: false, problem: "list" });
    expect(paragraphAt(NOTE, 14)).toEqual({ ok: false, problem: "code" });
    expect(paragraphAt(NOTE, 17)).toEqual({ ok: false, problem: "quote" });
    expect(paragraphAt(NOTE, 99)).toEqual({ ok: false, problem: "blank" });
  });
  it("a paragraph that runs into a list without a blank line is refused whole", () => {
    expect(paragraphAt("text\n- item\n", 1)).toEqual({ ok: false, problem: "list" });
  });
});

describe("newBlockId / withBlockId", () => {
  it("six letters and digits, not one the note uses", () => {
    let calls = 0;
    const random = { bytes: (n: number) => Uint8Array.from({ length: n }, () => (calls++ < 6 ? 0 : 1)) };
    const id = newBlockId(random, "x ^aaaaaa");
    expect(id).toMatch(/^[a-z0-9]{6}$/);
    expect(id).not.toBe("aaaaaa");
    expect(() => newBlockId({ bytes: (n: number) => new Uint8Array(n) }, "x ^aaaaaa")).toThrow();
  });
  it("adds the id to the end of exactly one matching paragraph", () => {
    const body = "# H\n\nFirst paragraph\nsecond line.\n\nOther\n";
    expect(withBlockId(body, "First paragraph\nsecond line.", "ab12cd")).toBe("# H\n\nFirst paragraph\nsecond line. ^ab12cd\n\nOther\n");
  });
  it("refuses when the paragraph is gone or appears twice", () => {
    expect(withBlockId("one\n\ntwo\n", "three", "ab12cd")).toBeNull();
    expect(withBlockId("same\n\nsame\n", "same", "ab12cd")).toBeNull();
  });
});

describe("blockEmbeds", () => {
  it("own-line block and heading embeds, outside code", () => {
    const t = "intro\n\n![[Daily note#^ab12]]\n\n![[Daily note#A heading]]\n\n```\n![[x#^zz]]\n```\n\nand ![[inline#^no]] here\n";
    expect(blockEmbeds(t)).toEqual({ blocks: [{ line: 3, host: "Daily note", blockId: "ab12" }], headings: [{ line: 5, target: "Daily note#A heading" }] });
  });
  it("an embed of a block of this same note has an empty host", () => {
    expect(blockEmbeds("![[#^ab12]]").blocks).toEqual([{ line: 1, host: "", blockId: "ab12" }]);
  });
});

describe("readBlockMap", () => {
  it("keeps only block ids mapped to Blyg ids", () => {
    const id = "7c9wk2n4h6q1x8v0z3m5rjy2ke";
    expect(readBlockMap({ ab12: id, bad: "x", "no way": id })).toEqual({ ab12: id });
    expect(readBlockMap(null)).toEqual({});
    expect(readBlockMap([id])).toEqual({});
  });
});
