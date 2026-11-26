// "Send passage to note" (feature passages): the pure parts. Headings of a note, where the quote goes, the folder scope and the recent order, and the main promise:
// the note text written here is what a thread on a Studio route accepts as it stands (the native quote kept whole, the reaction line not part of it).
import { describe, expect, it } from "vitest";
import { noteHeadings } from "../../src/app/noteHeadings";
import { insertPassage, type PassageTarget } from "../../src/app/passageInsert";
import { destinationList, destinationVerdict, inFolders, parseFolders, passageBlocked, readRecent, RECENT_MAX, withRecent, type DestinationNote } from "../../src/app/passageScope";
import { quoteBlockOf } from "../../src/app/threadCommands";
import { lazyQuoteLines, prepareStudioText, scanStudioQuotes } from "../../src/studio/text";
import { makeStudioWorld } from "../studio/world";
import type { ReadingPost } from "../../src/studio/reading";


const ID = "095s4h48j67mnbf6hq8vatc2d4";
const PASSAGE = "The point of copying a passage out by hand was never the copy.";
const made = quoteBlockOf(`${ID} | Example Blyg`, { kind: "passage", selected: PASSAGE });
if (!made.ok) throw new Error("fixture");
const BLOCK = made.text;
const NOTE = "---\nblyg_kind: thread\n---\n# On habit\nShort entries.\n\n## Slow reading\nText.\n\n## Copying\nMore.\n\n# Open questions\nDoes typing count?\n";
const h = (level: number, text: string, nth = 0): PassageTarget => ({ kind: "heading", level, text, nth });

describe("the headings of a note", () => {
  it("lists ATX headings in order with their level, outside the properties and outside code", () => {
    const text = "---\ntitle: # not a heading\n---\n# One\n```\n# in code\n```\ntext\n## Two ##\n~~~\n## also code\n~~~\n###### Six\n####### seven hashes is text\n#nospace\n";
    expect(noteHeadings(text).map((x) => [x.level, x.text])).toEqual([[1, "One"], [2, "Two"], [6, "Six"]]);
  });
  it("counts equal headings so each can be found again", () => {
    const hs = noteHeadings("# Notes\na\n# Notes\nb\n## Notes\n");
    expect(hs.map((x) => [x.level, x.nth])).toEqual([[1, 0], [1, 1], [2, 0]]);
  });
  it("an empty heading and a CRLF note are read sensibly", () => {
    expect(noteHeadings("#\n# \n# A\r\n").map((x) => x.text)).toEqual(["A"]);
  });
});

describe("inserting the quote", () => {
  it("puts it at the end of the section, sub-sections included, and leaves the next heading after it", () => {
    const r = insertPassage(NOTE, h(1, "On habit"), BLOCK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(`---\nblyg_kind: thread\n---\n# On habit\nShort entries.\n\n## Slow reading\nText.\n\n## Copying\nMore.\n\n${BLOCK}\n\n\n\n# Open questions\nDoes typing count?\n`);
  });
  it("puts it under a sub-heading before the next heading of the same level", () => {
    const r = insertPassage(NOTE, h(2, "Slow reading"), BLOCK);
    if (!r.ok) throw new Error("no");
    expect(r.text).toContain(`## Slow reading\nText.\n\n${BLOCK}\n\n\n\n## Copying`);
  });
  it("end of note: after the last line, and the reaction line is the empty last line", () => {
    const r = insertPassage(NOTE, { kind: "end" }, BLOCK);
    if (!r.ok) throw new Error("no");
    expect(r.text.endsWith(`Does typing count?\n\n${BLOCK}\n\n`)).toBe(true);
    const lines = r.text.split("\n");
    expect(lines[r.quoteLine]).toBe(BLOCK.split("\n")[0]);
    expect(lines[r.cursorLine]).toBe("");
    expect(r.cursorLine).toBe(lines.length - 1);
  });
  it("a heading with nothing under it, an empty note and a note of properties only", () => {
    const a = insertPassage("# Empty\n# Next\n", h(1, "Empty"), BLOCK);
    if (!a.ok) throw new Error("no");
    expect(a.text).toBe(`# Empty\n\n${BLOCK}\n\n\n\n# Next\n`);
    const b = insertPassage("", { kind: "end" }, BLOCK);
    if (!b.ok) throw new Error("no");
    expect(b.text).toBe(`${BLOCK}\n\n`);
    expect(b.quoteLine).toBe(0);
    const c = insertPassage("---\na: 1\n---\n", { kind: "end" }, BLOCK);
    if (!c.ok) throw new Error("no");
    expect(c.text).toBe(`---\na: 1\n---\n\n${BLOCK}\n\n`);
  });
  it("finds the same heading again by level, text and count, and refuses when it has gone", () => {
    const twice = "# Notes\na\n# Notes\nb\n";
    const r = insertPassage(twice, h(1, "Notes", 1), BLOCK);
    if (!r.ok) throw new Error("no");
    expect(r.text).toBe(`# Notes\na\n# Notes\nb\n\n${BLOCK}\n\n`);
    expect(insertPassage("# Other\n", h(1, "Notes"), BLOCK)).toEqual({ ok: false, reason: "heading-gone" });
    expect(insertPassage("## Notes\n", h(1, "Notes"), BLOCK)).toEqual({ ok: false, reason: "heading-gone" });
  });
  it("refuses to write inside a code block that is never closed, and writes after one that is closed", () => {
    expect(insertPassage("# A\n```\ncode\n", h(1, "A"), BLOCK)).toEqual({ ok: false, reason: "open-fence" });
    const ok = insertPassage("# A\n```\ncode\n```\n# B\n", h(1, "A"), BLOCK);
    expect(ok.ok).toBe(true);
  });
  it("keeps CRLF line ends", () => {
    const r = insertPassage("# A\r\ntext\r\n", h(1, "A"), BLOCK);
    if (!r.ok) throw new Error("no");
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
  });
  it("changes nothing before the insertion point (the writer's own text is kept byte for byte)", () => {
    const r = insertPassage(NOTE, h(2, "Copying"), BLOCK);
    if (!r.ok) throw new Error("no");
    expect(r.text.startsWith("---\nblyg_kind: thread\n---\n# On habit\nShort entries.\n\n## Slow reading\nText.\n\n## Copying\nMore.")).toBe(true);
    expect(r.text.endsWith("# Open questions\nDoes typing count?\n")).toBe(true);
  });
});

describe("the written note is what a Studio thread takes as it stands", () => {
  const ctx = { vault: makeStudioWorld().deps.vault, routes: [], fromPath: "studio/T.md", origin: "https://studio.test/", fragmentCharCap: 1000 };
  const body = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n/, "");
  it("keeps the directive and the quote together, and a reaction typed on the cursor line is the writer's own words", () => {
    const r = insertPassage(NOTE, h(2, "Copying"), BLOCK);
    if (!r.ok) throw new Error("no");
    const lines = r.text.split("\n");
    lines[r.cursorLine] = "My reaction, in my own words.";
    const typed = lines.join("\n");
    expect(lazyQuoteLines(body(typed))).toEqual([]);
    const draft = prepareStudioText(body(typed), "thread", ctx);
    expect(draft.problems).toEqual([]);
    expect(draft.quotes).toHaveLength(1);
    expect(draft.quotes[0]).toMatchObject({ id: ID, quoteMd: PASSAGE, label: "Example Blyg" });
  });
  it("even without a reaction the quote is the passage alone", () => {
    const r = insertPassage(NOTE, { kind: "end" }, BLOCK);
    if (!r.ok) throw new Error("no");
    expect(scanStudioQuotes(body(r.text)).quotes[0]?.quoteMd).toBe(PASSAGE);
  });
  it("a fragment cannot hold it: the Studio's own check says so (this is why the destination is asked about first)", () => {
    const r = insertPassage("A fragment.\n", { kind: "end" }, BLOCK);
    if (!r.ok) throw new Error("no");
    expect(prepareStudioText(r.text, "fragment", ctx).problems.map((p) => p.kind)).toContain("fragment-quote");
  });
  it("passages with Markdown-looking text are escaped by the quote builder, so the quote stays one block", () => {
    const odd = quoteBlockOf(ID, { kind: "passage", selected: "# not a heading\n- not a list" });
    if (!odd.ok) throw new Error("no");
    const r = insertPassage(NOTE, { kind: "end" }, odd.text);
    if (!r.ok) throw new Error("no");
    expect(scanStudioQuotes(body(r.text)).quotes).toHaveLength(1);
  });
});

describe("the folders and the notes offered", () => {
  const notes: DestinationNote[] = [
    { path: "Reading/Commonplace book.md", name: "Commonplace book", mtime: 5 },
    { path: "Reading/Quotes.md", name: "Quotes", mtime: 9 },
    { path: "Ideas/Slow reading.md", name: "Slow reading", mtime: 7 },
    { path: "Ideas/sub/Deep.md", name: "Deep", mtime: 1 },
    { path: "Private/Diary.md", name: "Diary", mtime: 99 },
    { path: "Readings/Other.md", name: "Other", mtime: 3 },
  ];
  it("reads one folder per line, cleans slashes, drops empty, repeated and climbing entries", () => {
    expect(parseFolders("Reading\n /Ideas/ \n\nReading\n../Secret\nA//B\r\nC\\D\n.\n")).toEqual(["Reading", "Ideas", "A/B", "C/D"]);
    expect(parseFolders("")).toEqual([]);
  });
  it("a path is inside a folder only through a slash, and no folder means nothing is inside", () => {
    expect(inFolders("Reading/a.md", ["Reading"])).toBe(true);
    expect(inFolders("Readings/a.md", ["Reading"])).toBe(false);
    expect(inFolders("Reading.md", ["Reading"])).toBe(false);
    expect(inFolders("Reading/a.md", [])).toBe(false);
  });
  it("offers only notes of the chosen folders (several), recent first, then the rest by last change; fail closed with none", () => {
    const folders = ["Reading", "Ideas"];
    const l = destinationList(notes, { folders, recent: [{ path: "Ideas/Slow reading.md", at: 2 }, { path: "Private/Diary.md", at: 1 }, { path: "Gone/x.md", at: 0 }] });
    expect(l.recent.map((n) => n.name)).toEqual(["Slow reading"]);
    expect(l.others.map((n) => n.name)).toEqual(["Quotes", "Commonplace book", "Deep"]);
    expect([...l.recent, ...l.others].some((n) => n.path.startsWith("Private/") || n.path.startsWith("Readings/"))).toBe(false);
    const none = destinationList(notes, { folders: [], recent: [] });
    expect(none.recent).toEqual([]);
    expect(none.others).toEqual([]);
  });
  it("narrowing can only take folders away; a folder that is not allowed is ignored; a query filters by name or path", () => {
    const folders = ["Reading", "Ideas"];
    expect(destinationList(notes, { folders, narrowed: ["Ideas"], recent: [] }).others.map((n) => n.name)).toEqual(["Slow reading", "Deep"]);
    expect(destinationList(notes, { folders, narrowed: ["Private"], recent: [] }).others.map((n) => n.name)).not.toContain("Diary");
    expect(destinationList(notes, { folders, query: "SLOW", recent: [] }).others.map((n) => n.name)).toEqual(["Slow reading"]);
    expect(destinationList(notes, { folders, query: "sub/", recent: [] }).others.map((n) => n.name)).toEqual(["Deep"]);
  });
  it("the recent list moves a used note to the front, has no repeats and a limit, and never trusts what is stored", () => {
    let list = withRecent([], "a.md", 1);
    list = withRecent(list, "b.md", 2);
    list = withRecent(list, "a.md", 3);
    expect(list.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    for (let i = 0; i < 20; i++) list = withRecent(list, `n${i}.md`, 10 + i);
    expect(list).toHaveLength(RECENT_MAX);
    expect(readRecent([{ path: "x.md", at: 1 }, { path: 5, at: 1 }, "no", null, { path: "y.md" }])).toEqual([{ path: "x.md", at: 1 }]);
    expect(readRecent("nonsense")).toEqual([]);
  });
});

describe("what a destination allows", () => {
  it("is the same rule as moving a selection out: a page folder and a fragment cannot hold a quote, a thread and a plain note can", () => {
    expect(destinationVerdict({ routeMode: "plain", kind: "thread", hasId: false })).toEqual({ ok: false, reason: "plain-route" });
    expect(destinationVerdict({ routeMode: "studio", kind: "fragment", hasId: false })).toEqual({ ok: false, reason: "fragment" });
    expect(destinationVerdict({ routeMode: "studio", kind: "fragment", hasId: true })).toEqual({ ok: false, reason: "published-fragment" });
    expect(destinationVerdict({ routeMode: "studio", kind: "thread", hasId: true })).toEqual({ ok: true });
    expect(destinationVerdict({ routeMode: null, kind: "fragment", hasId: false })).toEqual({ ok: true });
  });
});

describe("which posts can be quoted", () => {
  const post = (over: Partial<ReadingPost>): ReadingPost => ({ subscriptionId: "sub1", subscriptionTitle: "Example Blyg", origin: "https://example.com/", remoteId: ID, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "<p>x</p>", contentMd: "x", authorName: null, authorUrl: null, sourceUrl: null, ...over });
  it("a followed post can; an unfollowed, a withdrawn and your own cannot (fail closed, with the reason)", () => {
    expect(passageBlocked(post({}))).toBeNull();
    expect(passageBlocked(post({ subscriptionId: "" }))).toMatch(/not followed/);
    expect(passageBlocked(post({ withdrawn: true }))).toMatch(/withdrawn/);
    expect(passageBlocked(post({ own: true }))).toMatch(/own post/);
  });
});
