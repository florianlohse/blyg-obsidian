// "Draft as Blyg fragment / thread": what a selection becomes. The selection is copied; a captured quote is kept whole in a thread, never in a fragment, never cut.
import { describe, expect, it } from "vitest";
import { decideDraft, planSelection, quoteBlocks, readOrigins, withOrigin, wordsHash, ORIGINS_MAX, type Pos } from "../../src/app/passageDraft";
import { insertPassage } from "../../src/app/passageInsert";
import { quoteBlockOf } from "../../src/app/threadCommands";
import { prepareStudioText } from "../../src/studio/text";
import { makeStudioWorld } from "../studio/world";

const ID = "095s4h48j67mnbf6hq8vatc2d4";
const PASSAGE = "The point of copying a passage out by hand was never the copy.";
const made = quoteBlockOf(`${ID} | Example Blyg`, { kind: "passage", selected: PASSAGE });
if (!made.ok) throw new Error("fixture");
// line 0..: a private line, the pair (2 lines), a blank, my reaction, a blank, more private text
const NOTE = `Private line above.\n\n${made.text}\n\nMy reaction, in my own words.\n\nPrivate line below.\n`;
const lines = NOTE.split("\n");
const at = (line: number, ch = 0): Pos => ({ line, ch });
const end = (line: number): Pos => at(line, lines[line]!.length);
const ctx = { vault: makeStudioWorld().deps.vault, routes: [], fromPath: "studio/T.md", origin: "https://studio.test/", fragmentCharCap: 1000 };

describe("the quote blocks of a note", () => {
  it("finds the directive with its attached lines, 0-based, and nothing in code", () => {
    expect(quoteBlocks(NOTE)).toEqual([{ first: 2, last: 3 }]);
    expect(quoteBlocks("```\n![[" + ID + "]]\n> x\n```\n")).toEqual([]);
  });
});

describe("planning a selection", () => {
  it("only my reaction: words, exactly the selected words, nothing of the lines around it", () => {
    const p = planSelection(NOTE, at(5), end(5));
    expect(p).toEqual({ kind: "words", body: "My reaction, in my own words.\n" });
  });
  it("part of a line is only that part", () => {
    expect(planSelection(NOTE, at(5, 3), at(5, 11))).toEqual({ kind: "words", body: "reaction\n" });
  });
  it("a selection made backwards is the same", () => {
    expect(planSelection(NOTE, end(5), at(5))).toEqual(planSelection(NOTE, at(5), end(5)));
  });
  it("the pair and the reaction: whole quote inside, kept intact as written", () => {
    const p = planSelection(NOTE, at(2), end(5));
    expect(p).toEqual({ kind: "quotes", body: `${made.text}\n\nMy reaction, in my own words.\n`, count: 1 });
  });
  it("a selection that ends at the start of the next line does not take that line", () => {
    const p = planSelection(NOTE, at(2), at(6, 0));
    expect(p.kind).toBe("quotes");
    expect(p.kind === "quotes" && p.body.includes("Private")).toBe(false);
  });
  it("a selection that starts inside the quote or ends inside it is a cut, with both ways out", () => {
    const start = planSelection(NOTE, at(3, 4), end(5));
    expect(start.kind).toBe("cuts");
    if (start.kind !== "cuts") return;
    expect(start.expanded).toBe(`${made.text}\n\nMy reaction, in my own words.\n`);
    expect(start.trimmed).toBe("My reaction, in my own words.\n");
    const finish = planSelection(NOTE, at(0), at(3, 8));
    if (finish.kind !== "cuts") throw new Error("cut");
    expect(finish.expanded.startsWith("Private line above.")).toBe(true);
    expect(finish.expanded.endsWith(`${PASSAGE.replace(/^/, "> ")}\n`)).toBe(true);
    expect(finish.trimmed).toBe("Private line above.\n");
  });
  it("words selected only inside the quote: the only way out is to take the whole quote", () => {
    const p = planSelection(NOTE, at(3, 4), at(3, 20));
    if (p.kind !== "cuts") throw new Error("cut");
    expect(p.trimmed).toBe("");
    const d = decideDraft(p, "fragment", 1000);
    expect(d.ask && d.options.map((o) => o.id)).toEqual(["include-quote"]);
  });
  it("blank selections are empty", () => {
    expect(planSelection(NOTE, at(1), at(1))).toEqual({ kind: "empty" });
    expect(planSelection(NOTE, at(1), at(4, 0)).kind).toBe("quotes");
  });
});

describe("what the writer is asked", () => {
  it("words: no question; a fragment over the cap is refused before anything is written, a thread is not", () => {
    const p = planSelection(NOTE, at(5), end(5));
    expect(decideDraft(p, "fragment", 1000)).toEqual({ ask: false, kind: "fragment", body: "My reaction, in my own words.\n" });
    expect(decideDraft(p, "fragment", 5)).toMatchObject({ ask: false, refuse: "too-long", cap: 5 });
    expect(decideDraft(p, "thread", 5)).toMatchObject({ ask: false, kind: "thread" });
  });
  it("a quote inside: a thread directly; as a fragment the only offer is the thread, so the quote is never dropped silently", () => {
    const p = planSelection(NOTE, at(2), end(5));
    expect(decideDraft(p, "thread", 1000)).toMatchObject({ ask: false, kind: "thread" });
    const d = decideDraft(p, "fragment", 1000);
    expect(d).toMatchObject({ ask: true, why: "quotes" });
    expect(d.ask && d.options.map((o) => [o.id, o.kind])).toEqual([["thread-with-quote", "thread"]]);
  });
  it("a cut: include the whole quote (a thread) or leave it out (the kind asked for)", () => {
    const p = planSelection(NOTE, at(3, 4), end(5));
    const f = decideDraft(p, "fragment", 1000);
    expect(f.ask && f.options.map((o) => [o.id, o.kind])).toEqual([["include-quote", "thread"], ["leave-quote-out-fragment", "fragment"]]);
    const t = decideDraft(p, "thread", 1000);
    expect(t.ask && t.options.map((o) => [o.id, o.kind])).toEqual([["include-quote", "thread"], ["leave-quote-out-thread", "thread"]]);
  });
});

describe("the draft is what a Studio takes", () => {
  it("the pair and the reaction become a thread with the native quote, the passage and no problem; no private line is in it", () => {
    const p = planSelection(NOTE, at(2), end(5));
    if (p.kind !== "quotes") throw new Error("quotes");
    const draft = prepareStudioText(p.body.trim(), "thread", ctx);
    expect(draft.problems).toEqual([]);
    expect(draft.quotes).toHaveLength(1);
    expect(draft.quotes[0]).toMatchObject({ id: ID, quoteMd: PASSAGE, label: "Example Blyg" });
    expect(p.body).not.toMatch(/Private/);
  });
  it("only the reaction becomes a fragment with just those words", () => {
    const p = planSelection(NOTE, at(5), end(5));
    if (p.kind !== "words") throw new Error("words");
    expect(prepareStudioText(p.body.trim(), "fragment", ctx).problems).toEqual([]);
  });
  it("the same pair written by Send passage to note round-trips into a quote-capable draft", () => {
    const sent = insertPassage("# On habit\nShort entries.\n", { kind: "end" }, made.text);
    if (!sent.ok) throw new Error("no");
    const note = sent.text.replace(/\n$/, "\nMy reaction.\n");
    const ls = note.split("\n");
    const first = ls.findIndex((l) => l.startsWith("![["));
    const p = planSelection(note, at(first), at(ls.findIndex((l) => l === "My reaction."), "My reaction.".length));
    expect(p.kind).toBe("quotes");
    if (p.kind === "quotes") expect(prepareStudioText(p.body.trim(), "thread", ctx).quotes[0]).toMatchObject({ id: ID, quoteMd: PASSAGE });
  });
  it("a fragment made from a quote-bearing selection is refused by the Studio's own check", () => {
    const p = planSelection(NOTE, at(2), end(5));
    if (p.kind !== "quotes") throw new Error("quotes");
    expect(prepareStudioText(p.body.trim(), "fragment", ctx).problems.map((x) => x.kind)).toContain("fragment-quote");
  });
});

describe("where a draft came from", () => {
  it("keeps a small map, drops what is odd, forgets the oldest", () => {
    const o = { path: "a.md", from: at(1), to: at(2, 3), hash: wordsHash("x") };
    expect(readOrigins({ "d.md": o, bad: { path: 1 }, worse: null })).toEqual({ "d.md": o });
    expect(readOrigins([o])).toEqual({});
    let m: ReturnType<typeof readOrigins> = {};
    for (let i = 0; i < ORIGINS_MAX + 5; i++) m = withOrigin(m, `d${i}.md`, o);
    expect(Object.keys(m)).toHaveLength(ORIGINS_MAX);
    expect(m["d0.md"]).toBeUndefined();
    expect(wordsHash("abc")).toBe(wordsHash("abc"));
    expect(wordsHash("abc")).not.toBe(wordsHash("abd"));
  });
});
