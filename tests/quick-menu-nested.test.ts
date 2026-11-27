// SH1 on iOS: a long press on a post row inside a story card must open ONE menu, and the shelf's Save entry must not depend on the shelf having been read yet.
import { describe, expect, it, vi } from "vitest";

const menus: string[][] = [];
vi.mock("obsidian", () => ({
  Menu: class {
    titles: string[] = [];
    addItem(cb: (i: unknown) => void): this {
      const item = { setTitle: (t: string) => (this.titles.push(t), item), setIcon: () => item, setDisabled: () => item, onClick: () => item };
      cb(item);
      return this;
    }
    showAtPosition(): void {
      menus.push(this.titles);
    }
  },
}));
import type { ReadingPost } from "../src/studio/reading";
import type { ShelfFacade } from "../src/app/shelfService";
import { attachQuick, quickPost, quickStory } from "../src/ui/quickMenu";
import { ShelfControl } from "../src/ui/readerShelf";

vi.stubGlobal("window", { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (h: number) => clearTimeout(h) });
type L = (e: unknown) => void;
class El {
  parent: El | null = null;
  handlers = new Map<string, L[]>();
  addEventListener(t: string, f: L): void {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), f]);
  }
  fire(t: string, e: Record<string, unknown>): void {
    for (let el = this as El | null; el; el = el.parent) for (const f of el.handlers.get(t) ?? []) f(e);
  }
}
const post = { subscriptionId: "s", subscriptionTitle: "T", origin: null, remoteId: "a", kind: "fragment", withdrawn: false, version: 1 } as unknown as ReadingPost;

describe("one menu per long press", () => {
  it("a post row inside a story card: the row's menu opens, the card's does not (touch and context click)", () => {
    vi.useFakeTimers();
    const card = new El();
    const row = new El();
    row.parent = card;
    menus.length = 0;
    quickStory(card as unknown as HTMLElement, [post], { open: () => undefined });
    quickPost(row as unknown as HTMLElement, () => post, { open: () => undefined, shelf: { state: () => ({ saved: false, full: false }), toggle: () => undefined } });
    const t = { touches: [{ clientX: 1, clientY: 1 }], changedTouches: [], cancelable: true, preventDefault: () => undefined };
    row.fire("touchstart", t);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(1);
    expect(menus[0]).toContain("Save for later");
    row.fire("touchend", { ...t, touches: [] });
    menus.length = 0;
    vi.advanceTimersByTime(1000);
    row.fire("contextmenu", { clientX: 1, clientY: 1, preventDefault: () => undefined });
    expect(menus).toHaveLength(1);
    expect(menus[0]).toContain("Save for later");
    vi.useRealTimers();
  });
  it("a plain card still opens its own menu", () => {
    vi.useFakeTimers();
    const el = new El();
    menus.length = 0;
    attachQuick(el as unknown as HTMLElement, () => menus.push(["x"]));
    el.fire("touchstart", { touches: [{ clientX: 1, clientY: 1 }], changedTouches: [] });
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("Save is offered before the shelf has been read", () => {
  const facade = (o: Partial<ShelfFacade>): ShelfFacade => ({ on: () => true, ready: () => false, has: () => false, count: () => 0, full: () => false, opening: () => Promise.resolve(), reset: () => undefined, saved: () => Promise.resolve([]), toggle: () => Promise.resolve({ ok: true, saved: true }), ...o });
  const ui = (f: ShelfFacade) => new ShelfControl(() => f, { status: () => undefined, refresh: () => undefined, body: () => undefined, posts: () => [] });
  it("still being read, or lost: an entry; a Studio without a shelf, or the feature off: none", () => {
    expect(ui(facade({ settling: () => true })).actions(post).state()).toEqual({ saved: false, full: false });
    expect(ui(facade({ lost: () => true })).actions(post).state()).toEqual({ saved: false, full: false });
    expect(ui(facade({})).actions(post).state()).toBeNull();
    expect(ui(facade({ on: () => false, settling: () => true })).actions(post).state()).toBeNull();
  });
});
