// A single line break inside a paragraph: Obsidian shows it, CommonMark (a Studio's renderer) turns it into a space. The plugin keeps what the author
// sees by sending a Markdown hard break (two trailing spaces) between two plain paragraph lines (S2 device test, 2026-10-23, test 6).
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import { keepLineBreaks } from "../../src/studio/text";
import { frontmatterOf } from "../world";
import { makeStudioWorld, tapStudio } from "./world";

describe("keepLineBreaks", () => {
  it("puts a hard break between two plain lines, not after the last, not between paragraphs", () => {
    expect(keepLineBreaks("Line1\nLine2")).toBe("Line1  \nLine2");
    expect(keepLineBreaks("A\nB\nC")).toBe("A  \nB  \nC");
    expect(keepLineBreaks("First paragraph.\n\nSecond\nparagraph.")).toBe("First paragraph.\n\nSecond  \nparagraph.");
  });

  it("is idempotent and respects a break the author already wrote", () => {
    const once = keepLineBreaks("A\nB\nC");
    expect(keepLineBreaks(once)).toBe(once);
    expect(keepLineBreaks("A  \nB")).toBe("A  \nB");
    expect(keepLineBreaks("A\\\nB")).toBe("A\\\nB");
  });

  it("leaves code alone, fenced or indented", () => {
    const fenced = "Text\n\n```\nline one\nline two\n```\n\n~~~js\na\nb\n~~~\n\nAfter\nthis";
    expect(keepLineBreaks(fenced)).toBe(fenced.replace("After\nthis", "After  \nthis"));
    expect(keepLineBreaks("    code a\n    code b")).toBe("    code a\n    code b");
  });

  it("leaves lists, quotes, headings, tables, rules and html alone", () => {
    for (const block of ["- one\n- two", "1. one\n2. two", "> a\n> b", "# Heading\nText", "Text\n# Heading", "| a | b |\n| - | - |\n| 1 | 2 |", "Para\n---\nNext", "<div>\nx\n</div>", "[^1]: note\nmore"]) {
      expect(keepLineBreaks(block)).not.toMatch(/ {2}\n/);
    }
  });

  it("a text line before a list, quote or directive keeps its newline as it is (a block starts there anyway)", () => {
    expect(keepLineBreaks("Intro\n- item")).toBe("Intro\n- item");
    expect(keepLineBreaks("Intro\n![[a0000000000000000000000001]]\n> passage")).toBe("Intro\n![[a0000000000000000000000001]]\n> passage");
  });
});

describe("what a publish sends", () => {
  it("sends the hard breaks, hashes what it sent, and leaves the note in the vault as it was", async () => {
    const w = makeStudioWorld({ vault: { "studio/N.md": "Line1\nLine2\n\nNext paragraph.\n" } });
    const out = await tapStudio(w, "studio/N.md");
    expect(out.status).toBe("published");
    expect(w.studio.items.get(out.id ?? "")?.content_md).toBe("Line1  \nLine2\n\nNext paragraph.");
    expect(frontmatterOf(w.local.get("studio/N.md") ?? "").blyg_sent).toBe(await contentHash("Line1  \nLine2\n\nNext paragraph."));
    expect(w.local.get("studio/N.md")).toContain("Line1\nLine2\n");
    // a second tap finds nothing to do: the same text is derived again
    expect((await tapStudio(w, "studio/N.md")).status).toBe("noop");
  });

  it("counts the added spaces against a fragment's cap, as the Studio does", async () => {
    const lines = Array.from({ length: 100 }, () => "abcdef").join("\n"); // 699 characters, 99 breaks add 198: 897, under the cap
    const w = makeStudioWorld({ vault: { "studio/N.md": `${lines}\n` } });
    expect((await tapStudio(w, "studio/N.md")).status).toBe("published");
    const long = Array.from({ length: 130 }, () => "abcdef").join("\n"); // 909 characters as written, 129 breaks add 258: 1167, over the cap as sent
    w.local.set("studio/Big.md", `${long}\n`);
    expect((await tapStudio(w, "studio/Big.md")).status).toBe("refused");
  });
});
