import { describe, expect, it } from "vitest";
import { blockToInsert, embedReplacement, extractedItemBody, extractionVerdict, newItemName, newThreadName, NEW_NOTE_TEXT, NEW_THREAD_TEXT, pickerCandidates, quoteBlock, quoteBoxRows, renamedForThread, threadConversion, type PickerEntry } from "../../src/app/threadCommands";
import { renderQuoteSelection } from "../../src/core/quote";
import { scanThread } from "../../src/core/thread";

const A = "7c9wk2mhq0v3xj8tn5rzfd41bg";
const B = "1vgtgz0gq5b2c9k7d3m8r4n6xy";

describe("a new thread note", () => {
  it("is a note whose first property makes it a thread, with an empty body", () => {
    expect(NEW_THREAD_TEXT).toBe("---\nblyg_kind: thread\n---\n\n");
  });
  it("is named by the local time, and numbered when that name is taken", () => {
    const now = new Date(2026, 9, 10, 9, 5, 30);
    expect(newThreadName(now, () => false)).toBe("Thread 2026-10-10 0905");
    expect(newThreadName(now, (n) => n === "Thread 2026-10-10 0905")).toBe("Thread 2026-10-10 0905 2");
    expect(newThreadName(now, (n) => ["Thread 2026-10-10 0905", "Thread 2026-10-10 0905 2"].includes(n))).toBe("Thread 2026-10-10 0905 3");
  });
});

describe("a new note, and the quote window's box", () => {
  it("a new fragment is empty and is named Fragment …; a thread is named Thread …", () => {
    expect(NEW_NOTE_TEXT).toBe("");
    const now = new Date(2026, 9, 10, 8, 30);
    expect(newItemName("Fragment", now, () => false)).toBe("Fragment 2026-10-10 0830");
    expect(newItemName("Thread", now, (n) => n.startsWith("Thread 2026-10-10 0830") && !n.endsWith("2"))).toBe("Thread 2026-10-10 0830 2");
  });
  it("making a fragment a thread renames its automatic name, and leaves a chosen name alone", () => {
    const free = () => false;
    expect(renamedForThread("Fragment 2026-10-10 0830", free)).toBe("Thread 2026-10-10 0830");
    expect(renamedForThread("Fragment 2026-10-10 0830 3", free)).toBe("Thread 2026-10-10 0830 3");
    expect(renamedForThread("Fragment 2026-10-10 0830", (n) => n === "Thread 2026-10-10 0830")).toBe("Thread 2026-10-10 0830 2");
    expect(renamedForThread("Fragment 2026-10-10 0830 3", (n) => n === "Thread 2026-10-10 0830 3")).toBe("Thread 2026-10-10 0830 2");
    expect(renamedForThread("My note about time", free)).toBeNull();
    expect(renamedForThread("Fragment of a thought", free)).toBeNull();
    expect(renamedForThread("Thread 2026-10-10 0830", free)).toBeNull();
  });
  it("the text box fits its text: small for a sentence, capped for an essay", () => {
    expect(quoteBoxRows("One short sentence.")).toBe(3);
    expect(quoteBoxRows("x".repeat(36 * 6))).toBe(6);
    expect(quoteBoxRows("a\n\n\nb")).toBe(4);
    expect(quoteBoxRows("y\n".repeat(100))).toBe(12);
  });
});

describe("quoteBlock", () => {
  it("a whole quote is an embed of the note by the name Obsidian links with (the plugin makes the id of it when publishing)", () => {
    expect(quoteBlock("My note about time", { kind: "whole" })).toEqual({ ok: true, text: "![[My note about time]]" });
    expect(quoteBlock("folder/Name", { kind: "passage", selected: "words" })).toEqual({ ok: true, text: "![[folder/Name]]\n> words" });
    expect(quoteBlock(A, { kind: "whole" })).toEqual({ ok: true, text: `![[${A}]]` });
  });
  it("a passage is the directive with the selected text as an attached quote, normalised and escaped", () => {
    const block = quoteBlock(A, { kind: "passage", selected: "  It’s *the*  \n\n thing  " });
    expect(block).toEqual({ ok: true, text: `![[${A}]]\n> It’s \\*the\\*\n>\n> thing` });
  });
  it("what it writes is read back by the grammar and the quote subset as the selected text", () => {
    const block = quoteBlock(A, { kind: "passage", selected: "- 1. # [x] `y` <z> &amp; ~ | _ * \\" });
    expect(block.ok).toBe(true);
    const scan = scanThread(block.ok ? block.text : "");
    expect(scan.ok && scan.directives[0]?.id).toBe(A);
    const quote = scan.ok ? scan.directives[0]?.quoteMd : null;
    expect(renderQuoteSelection(quote ?? "")).toEqual({ ok: true, selection: "- 1. # [x] `y` <z> &amp; ~ | _ * \\" });
  });
  it("refuses an empty selection, a bad id, and text that cannot be quoted exactly", () => {
    expect(quoteBlock(A, { kind: "passage", selected: " \n " })).toEqual({ ok: false, reason: "empty" });
    expect(quoteBlock("a|b", { kind: "whole" })).toEqual({ ok: false, reason: "bad-ref" });
    expect(quoteBlock("Note#Heading", { kind: "whole" })).toEqual({ ok: false, reason: "bad-ref" });
    expect(quoteBlock(" ", { kind: "whole" })).toEqual({ ok: false, reason: "bad-ref" });
    expect(quoteBlock(A, { kind: "passage", selected: "see https://example.com/a]" })).toEqual({ ok: false, reason: "cannot" });
  });
});

describe("blockToInsert", () => {
  const block = `![[${A}]]`;
  it("on an empty first line, just the block and a blank line", () => {
    expect(blockToInsert({ before: "", after: "", previousLine: undefined }, block)).toBe(`${block}\n\n`);
  });
  it("on an empty line under text, a blank line first (a directive needs a paragraph of its own)", () => {
    expect(blockToInsert({ before: "", after: "", previousLine: "Some text." }, block)).toBe(`\n${block}\n\n`);
    expect(blockToInsert({ before: "", after: "", previousLine: "" }, block)).toBe(`${block}\n\n`);
  });
  it("in the middle of a line, a paragraph break first", () => {
    expect(blockToInsert({ before: "Some te", after: "xt", previousLine: undefined }, block)).toBe(`\n\n${block}\n\n`);
  });
});

describe("threadConversion", () => {
  it("allows an unpublished note in a Blyg folder", () => {
    expect(threadConversion({ inBlygRoute: true, id: undefined, kind: undefined })).toEqual({ ok: true });
    expect(threadConversion({ inBlygRoute: true, id: "", kind: "fragment" })).toEqual({ ok: true });
  });
  it("refuses a published note, a thread already, an essay, an unknown kind", () => {
    expect(threadConversion({ inBlygRoute: true, id: A, kind: undefined })).toMatchObject({ ok: false, message: expect.stringContaining("never changes") as string });
    expect(threadConversion({ inBlygRoute: true, id: undefined, kind: "thread" })).toMatchObject({ ok: false, message: "This note is already a thread." });
    expect(threadConversion({ inBlygRoute: false, id: undefined, kind: undefined })).toMatchObject({ ok: false });
    expect(threadConversion({ inBlygRoute: true, id: undefined, kind: "essay" })).toMatchObject({ ok: false });
  });
});

describe("pickerCandidates", () => {
  const entry = (path: string, fm: PickerEntry["frontmatter"], text = "Words here.\n"): PickerEntry => ({ path, name: path.split("/").pop() ?? path, frontmatter: fm, text });
  const entries: PickerEntry[] = [
    entry("website/blyg/old.md", { blyg_id: A, blyg_updated: "2026-10-01T00:00:00Z" }, "---\nblyg_id: x\n---\n%%private%%\n\nThe oldest note, which is long enough that it needs cutting somewhere around here because it just keeps on going and going.\n"),
    entry("website/blyg/new.md", { blyg_id: B, blyg_updated: new Date("2026-10-09T00:00:00Z") }, "Newest.\n"),
    entry("website/blyg/draft.md", {}, "No id yet.\n"),
    entry("website/blyg/gone.md", { blyg_id: "3d7mnhr5g0kq8v2wxb4tjy6fz9", blyg_withdrawn: true }),
    entry("website/blyg/self.md", { blyg_id: "pd0j92qefzqsrv8c8bmzydgcv4" }),
    entry("website/blyg/test.md", { blyg_id: "9z8y7x6w5v4t3s2r1q0pnmkhjg", blyg_channel: "preview" }),
    entry("website/blyg/bad.md", { blyg_id: "not-an-id" }),
  ];

  it("offers published, unwithdrawn notes other than the one being written, newest first, with the first words", () => {
    const got = pickerCandidates(entries, { activePath: "website/blyg/self.md", channel: "preview" });
    expect(got.map((c) => c.name)).toEqual(["new.md", "old.md", "test.md"]); // notes without an update time come last
    expect(got[0]).toMatchObject({ id: B, excerpt: "Newest." });
    expect(got[1]?.excerpt).toMatch(/^The oldest note.*…$/);
    expect(got[1]?.excerpt.length).toBeLessThanOrEqual(91);
  });

  it("on production, notes published to the test channel are left out", () => {
    const got = pickerCandidates(entries, { activePath: undefined, channel: "production" });
    expect(got.map((c) => c.name)).toEqual(["new.md", "old.md", "self.md"]);
    expect(got.map((c) => c.name)).not.toContain("test.md");
  });
});

describe("extracting a selection into a new item (Florian, 2026-10-16)", () => {
  it("is allowed from a thread and from a note outside the publish folders", () => {
    expect(extractionVerdict({ routeMode: "blyg", kind: "thread", hasId: true })).toEqual({ ok: true });
    expect(extractionVerdict({ routeMode: "blyg", kind: "thread", hasId: false })).toEqual({ ok: true });
    expect(extractionVerdict({ routeMode: null, kind: "fragment", hasId: false })).toEqual({ ok: true });
  });
  it("is refused from an essay or a page (the embed would show as plain text and break the deploy) and from a fragment (it cannot quote)", () => {
    expect(extractionVerdict({ routeMode: "plain", kind: "fragment", hasId: false })).toEqual({ ok: false, reason: "plain-route" });
    expect(extractionVerdict({ routeMode: "blyg", kind: "fragment", hasId: false })).toEqual({ ok: false, reason: "fragment" });
    expect(extractionVerdict({ routeMode: "blyg", kind: "fragment", hasId: true })).toEqual({ ok: false, reason: "published-fragment" });
  });
  it("the new item holds the selection without its surrounding blank lines", () => {
    expect(extractedItemBody("\n\n  Some words.\nMore.  \n\n")).toBe("Some words.\nMore.\n");
  });
  it("the embed that replaces it stands on a line of its own", () => {
    expect(embedReplacement({ before: "", after: "" }, "New fragment")).toBe("![[New fragment]]");
    expect(embedReplacement({ before: "Intro sentence. ", after: "" }, "X")).toBe("\n\n![[X]]");
    expect(embedReplacement({ before: "", after: " and the rest" }, "X")).toBe("![[X]]\n\n");
    expect(embedReplacement({ before: "a", after: "b" }, "folder/X")).toBe("\n\n![[folder/X]]\n\n");
  });
});
