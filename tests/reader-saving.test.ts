// HX3: "Saving bookmark…" while a shelf write is in flight (src/ui/savingLine.ts, src/ui/readerShelf.ts): drawn next to the bookmark of the open post and said in the status line, then replaced by the result.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/ui/savedMark", () => ({ drawSavedMark: () => undefined, SAVED_MARK_CLASS: "blyg-savedmark" }));
import type { ShelfFacade, ShelfResult } from "../src/app/shelfService";
import type { ReadingPost } from "../src/studio/reading";
import { ShelfControl } from "../src/ui/readerShelf";
import { drawSaving, SAVING_LABEL } from "../src/ui/savingLine";

const post = (remoteId: string): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "T", origin: null, remoteId, kind: "fragment", withdrawn: false, version: 1 } as unknown as ReadingPost);

/** An element that records its children (createSpan) and attributes. */
interface Rec { cls?: string; text?: string; attr?: Record<string, string>; kids: Rec[]; createSpan(o?: { cls?: string; text?: string; attr?: Record<string, string> }): Rec }
const rec = (o: { cls?: string; text?: string; attr?: Record<string, string> } = {}): Rec => {
  const r: Rec = { ...o, kids: [], createSpan: (c) => { const k = rec(c); r.kids.push(k); return k; } };
  return r;
};

function shelfWith(answer: Promise<ShelfResult>): ShelfFacade {
  return { on: () => true, ready: () => true, has: () => false, count: () => 0, full: () => false, opening: () => Promise.resolve(), reset: () => undefined, toggle: () => answer, saved: () => Promise.resolve([]) };
}

describe("HX3: the saving line", () => {
  it("is one phrase for a screen reader, three blinking dots as decoration, and nothing but text", () => {
    const parent = rec();
    const line = drawSaving(parent as unknown as HTMLElement) as unknown as Rec;
    expect(line.cls).toBe("blyg-saving");
    expect(line.attr).toMatchObject({ role: "status", "aria-label": SAVING_LABEL });
    expect(SAVING_LABEL).toBe("Saving bookmark…");
    const dots = line.kids.find((k) => k.cls === "blyg-saving-dots");
    expect(dots?.kids.map((k) => [k.cls, k.text])).toEqual([["blyg-saving-dot", "."], ["blyg-saving-dot", "."], ["blyg-saving-dot", "."]]);
    expect(line.kids.every((k) => k.attr?.["aria-hidden"] === "true")).toBe(true);
  });

  it("while the write is on its way the status line shows it, then the result replaces it", async () => {
    let answer!: (r: ShelfResult) => void;
    const facade = shelfWith(new Promise<ShelfResult>((r) => (answer = r)));
    const log: string[] = [];
    const screen = { status: (l: string) => void log.push(`status:${l}`), saving: () => void log.push("saving"), refresh: () => void log.push("refresh"), body: () => undefined, posts: () => [] as ReadingPost[] };
    const ui = new ShelfControl(() => facade, screen);
    const done = ui.toggle(post("a"));
    expect(log).toEqual(["refresh", "saving"]);
    answer({ ok: true, saved: true });
    await done;
    expect(log).toEqual(["refresh", "saving", "status:Saved for later.", "refresh"]);
  });

  it("the open post's button row gets the line right of the bookmark only while the post's write is in flight", async () => {
    let answer!: (r: ShelfResult) => void;
    const facade = shelfWith(new Promise<ShelfResult>((r) => (answer = r)));
    const screen = { status: () => undefined, refresh: () => undefined, body: () => undefined, posts: () => [] as ReadingPost[] };
    const ui = new ShelfControl(() => facade, screen);
    const draw = (): Rec => {
      const parent = rec();
      ui.button(parent as unknown as HTMLElement, post("a"), () => ({}) as HTMLButtonElement);
      return parent;
    };
    expect(draw().kids).toHaveLength(0);
    const done = ui.toggle(post("a"));
    expect(draw().kids.map((k) => k.cls)).toEqual(["blyg-saving"]);
    answer({ ok: true, saved: true });
    await done;
    expect(draw().kids).toHaveLength(0);
  });

  it("the dots stand still with reduced motion, and the word 'bookmark' gives way on a narrow phone", () => {
    const css = readFileSync("styles.css", "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.blyg-saving-dot \{ animation: none; opacity: 1; \} \}/);
    expect(css).toMatch(/\.blyg-saving-dot \{ animation: blyg-saving-dot/);
    expect(css).toMatch(/@media \(max-width: 360px\) \{ \.blyg-saving-obj \{ display: none; \} \}/);
  });
});
