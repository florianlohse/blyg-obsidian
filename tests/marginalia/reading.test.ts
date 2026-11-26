// HK3: in Reading view the section goes under the last block of the note only.
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ MarkdownRenderChild: class {} }));
const { endsNote } = await import("../../src/marginalia/reading");

describe("endsNote", () => {
  const text = "---\nblyg_id: x\n---\nFirst.\n\nSecond.\n\n";
  it("is true for the block that holds the last text, even with blank lines after it", () => {
    expect(endsNote(text, 5)).toBe(true);
    expect(endsNote("one\n\ntwo", 2)).toBe(true);
  });
  it("is false for an earlier block", () => {
    expect(endsNote(text, 3)).toBe(false);
    expect(endsNote(text, 2)).toBe(false);
  });
  it("a note of one block ends at that block; CRLF counts the same", () => {
    expect(endsNote("only", 0)).toBe(true);
    expect(endsNote("a\r\n\r\nb\r\n", 0)).toBe(false);
    expect(endsNote("a\r\n\r\nb\r\n", 2)).toBe(true);
  });
});
