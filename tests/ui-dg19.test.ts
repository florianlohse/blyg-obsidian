// DG19, the pieces that are drawn the same way every time: the saved mark, the menu rows and the feed's menu, the feed's loading spinner, the step counter's words. Drawn into a recording fake
// (the real look, in real Obsidian, is in the scenarios `reader-detail`, `daily`, `daily-refresh` and `sources`).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ setIcon: (el: FakeEl, name: string) => void (el.icon = name) }));

import { drawFeedStart } from "../src/ui/readerStart";
import { drawMenuButton, drawMenuPanel, sortValue, type FeedMenu } from "../src/ui/readerMenu";
import { drawMenuRow, fillMenuRow } from "../src/ui/menuRow";
import { drawSavedMark, SAVED_MARK_CLASS } from "../src/ui/savedMark";
import { stepCount, stepLabel, type Step } from "../src/ui/readerSteps";

class FakeEl {
  tag: string;
  cls = "";
  text = "";
  attrs: Record<string, string> = {};
  kids: FakeEl[] = [];
  handlers: Array<() => void> = [];
  icon = "";
  constructor(tag = "div", o: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    this.tag = tag;
    this.cls = o.cls ?? "";
    this.text = o.text ?? "";
    this.attrs = { ...(o.attr ?? {}) };
  }
  private make(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl {
    const e = new FakeEl(tag, o);
    this.kids.push(e);
    return e;
  }
  createDiv(o?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl { return this.make("div", o); }
  createSpan(o?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl { return this.make("span", o); }
  createEl(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl { return this.make(tag, o); }
  empty(): void { this.kids = []; }
  prepend(e: FakeEl): void { this.kids.unshift(e); }
  appendText(t: string): void { this.text += t; }
  append(e: FakeEl): void { this.kids.push(e); }
  setAttr(k: string, v: string): void { this.attrs[k] = v; }
  addEventListener(_t: string, f: () => void): void { this.handlers.push(f); }
  click(): void { this.handlers.forEach((h) => h()); }
  all(): FakeEl[] { return [this, ...this.kids.flatMap((k) => k.all())]; }
  hasClass(c: string): boolean { return this.cls.split(" ").includes(c); }
  find(c: string): FakeEl | undefined { return this.all().find((e) => e.hasClass(c)); }
}
const el = (e: FakeEl): HTMLElement => e as unknown as HTMLElement;

beforeEach(() => {
  (globalThis as unknown as { createSpan: (o?: { cls?: string; text?: string; attr?: Record<string, string> }) => FakeEl }).createSpan = (o) => new FakeEl("span", o);
});

describe("the saved mark (one helper for a card, a post row and the open post)", () => {
  it("is a bookmark glyph with a label and no word, put first on the line (or last when asked)", () => {
    const line = new FakeEl("div");
    line.createSpan({ text: "1 min read" });
    const mark = drawSavedMark(el(line)) as unknown as FakeEl;
    expect(line.kids[0]).toBe(mark);
    expect([mark.hasClass(SAVED_MARK_CLASS), mark.icon, mark.text, mark.attrs["role"], mark.attrs["aria-label"]]).toEqual([true, "bookmark", "", "img", "Saved"]);
    const end = drawSavedMark(el(line), "end") as unknown as FakeEl;
    expect(line.kids.at(-1)).toBe(end);
  });
});

describe("Menu 1 rows", () => {
  it("are label, value and a fixed slot for the ›, the arrow only on a row that opens something", () => {
    const panel = new FakeEl("div");
    const ran: string[] = [];
    const open = drawMenuRow(el(panel), { label: "Sources", value: "12 blygs", opens: true, title: "The blygs", run: () => void ran.push("sources") }) as unknown as FakeEl;
    const plain = drawMenuRow(el(panel), { label: "Refresh", value: "no AI, no cost", run: () => void ran.push("refresh") }) as unknown as FakeEl;
    const tells = drawMenuRow(el(panel), { label: "Price", value: "$0.04" }) as unknown as FakeEl;
    for (const row of [open, plain, tells]) expect(row.kids.map((k) => k.cls)).toEqual(["blyg-menurow-label", "blyg-menurow-value", "blyg-menurow-go"]); // the same three parts, so the edges line up
    expect([open, plain, tells].map((r) => r.kids[2]?.text)).toEqual(["›", "", ""]);
    expect([open.tag, plain.tag, tells.tag]).toEqual(["button", "button", "div"]); // a row that only tells is no button
    expect(open.kids[2]?.attrs["aria-hidden"]).toBe("true");
    open.click();
    plain.click();
    expect(ran).toEqual(["sources", "refresh"]);
  });
  it("can be drawn again in place (the Write row while it runs)", () => {
    const row = drawMenuRow(el(new FakeEl()), { label: "Write the digest", value: "uses tokens", run: () => undefined }) as unknown as FakeEl;
    const { value } = fillMenuRow(el(row), { label: "Writing the digest…", value: "" });
    expect(row.kids.map((k) => k.text)).toEqual(["Writing the digest…", "", ""]);
    expect((value as unknown as FakeEl).hasClass("blyg-menurow-value")).toBe(true);
    expect(row.handlers).toHaveLength(1); // the tap handler stays on the row
  });
});

describe("the feed's menu", () => {
  const make = (over: Partial<FeedMenu> = {}): { menu: FeedMenu; log: string[]; state: { open: boolean } } => {
    const state = { open: false };
    const log: string[] = [];
    return { state, log, menu: { state, repaint: () => void log.push("repaint"), sort: { value: "Newest", run: () => void log.push("sort") }, sources: () => void log.push("sources"), settings: () => void log.push("settings"), ...over } };
  };
  it("has a hamburger button with a label that unfolds the panel and says so", () => {
    const { menu, state, log } = make();
    const row = new FakeEl("div");
    const b = drawMenuButton(el(row), menu) as unknown as FakeEl;
    expect([b.tag, b.icon, b.attrs["aria-label"], b.attrs["aria-expanded"]]).toEqual(["button", "menu", "Menu", "false"]);
    b.click();
    expect([state.open, log]).toEqual([true, ["repaint"]]);
  });
  it("holds Sort & filter, Sources and Settings (in that order), nothing while folded, and a pick folds it again", () => {
    const { menu, state, log } = make();
    const header = new FakeEl("div");
    drawMenuPanel(el(header), menu);
    expect(header.kids).toHaveLength(0);
    state.open = true;
    drawMenuPanel(el(header), menu);
    const rows = header.all().filter((e) => e.hasClass("blyg-menurow"));
    expect(rows.map((r) => r.kids[0]?.text)).toEqual(["Sort & filter", "Sources", "Settings"]);
    expect(rows.map((r) => r.kids[2]?.text)).toEqual(["›", "›", "›"]);
    expect(rows.map((r) => r.hasClass("blyg-reader-filterbtn") || r.hasClass("blyg-reader-sources") || r.hasClass("blyg-reader-settings"))).toEqual([true, true, true]);
    rows[1]?.click();
    expect([state.open, log]).toEqual([false, ["sources", "repaint"]]);
  });
  it("leaves out Sort & filter while there is nothing to sort, and Settings where the host cannot open them", () => {
    const { menu, state } = make({ sort: null });
    delete (menu as { settings?: unknown }).settings;
    state.open = true;
    const header = new FakeEl("div");
    drawMenuPanel(el(header), menu);
    expect(header.all().filter((e) => e.hasClass("blyg-menurow")).map((r) => r.kids[0]?.text)).toEqual(["Sources"]);
  });
  it("says in the Sort & filter row how many choices are made, or the order", () => {
    expect([sortValue(0, "Newest"), sortValue(1, "Newest"), sortValue(4, "Newest")]).toEqual(["Newest", "1 choice", "4 choices"]);
  });
});

describe("the feed before it has a list", () => {
  it("shows a labelled spinner while the first answer is on its way, never the words 'nothing to show'", () => {
    for (const [busy, first] of [[false, true], [true, false], [true, true]] as const) {
      const col = new FakeEl("div");
      drawFeedStart(el(col), busy, first);
      const box = col.find("blyg-reader-loading");
      expect([box?.attrs["role"], box?.attrs["aria-label"], box?.attrs["aria-busy"]]).toEqual(["status", "Loading…", "true"]);
      expect(col.find("blyg-reader-spinner")).toBeDefined();
      expect(col.find("blyg-reader-note")).toBeUndefined();
      expect(col.all().some((e) => /nothing to show/i.test(e.text))).toBe(false);
    }
  });
  it("says 'nothing to show' only for a real empty answer, with no spinner", () => {
    const col = new FakeEl("div");
    drawFeedStart(el(col), false, false);
    expect(col.find("blyg-reader-note")?.text).toMatch(/nothing to show/);
    expect(col.find("blyg-reader-spinner")).toBeUndefined();
  });
});

describe("the step counter's words", () => {
  const step = (o: { at: number; n: number; mode: "feed" | "digest"; section?: string }): Step => ({ keys: Array.from({ length: o.n }, (_, i) => `k${i}`), at: o.at, mode: o.mode, ...(o.section !== undefined ? { section: o.section } : {}) });
  it("names the list and then the numbers: 'Feed · 9 of 38', 'Digest · <heading> · 4 of 12', 'Digest · 4 of 12' on a page with no sections", () => {
    expect(stepLabel(step({ at: 8, n: 38, mode: "feed" }))).toEqual({ name: "Feed", numbers: "9 of 38" });
    expect(stepLabel(step({ at: 3, n: 12, mode: "digest", section: "Work and Culture" }))).toEqual({ name: "Digest · Work and Culture", numbers: "4 of 12" });
    expect(stepLabel(step({ at: 3, n: 12, mode: "digest" }))).toEqual({ name: "Digest", numbers: "4 of 12" });
  });
  it("draws the name in its own span (it gives way) and the numbers in another (they never do)", () => {
    const row = new FakeEl("div");
    stepCount(el(row), step({ at: 3, n: 12, mode: "digest", section: "Work and Culture" }));
    const count = row.find("blyg-reader-stepcount");
    expect(count?.attrs["aria-label"]).toBe("Digest · Work and Culture · 4 of 12");
    expect(count?.find("blyg-reader-steptitle")?.text).toBe("Digest · Work and Culture");
    expect(count?.find("blyg-reader-stepnum")?.kids.map((k) => k.text)).toEqual(["4"]);
  });
});
