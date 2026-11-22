// The reader's feed as a window (HK4): only a stretch of the cards is in the page, however long the list is. Cards are added below as you scroll down (and above as
// you scroll back up); the ones that have left the stretch are removed, and a spacer as high as they were keeps the scroll bar and the place on the screen true.
// Before this the feed only grew: scrolling through 5000 posts built 5000 cards. Now at most WINDOW_MAX are built at a time.
// The index arithmetic is pure and unit-tested (tests/reader-window.test.ts); the DOM part is checked in a browser, and on a device (docs/TESTING.md).

/** Cards built at the first draw, and added by one step of scrolling. */
export const WINDOW_FIRST = 30;
export const WINDOW_STEP = 40;
/** The most cards in the page at once. A phone shows about 5 to 8 at a time, so this keeps many screens either side. */
export const WINDOW_MAX = 120;
/** The height assumed for a card that has not been measured yet. */
export const CARD_PX = 150;

/** What the window remembers between two draws of the feed (a reload, opening a post and coming back): the built stretch, and the heights measured. */
export interface WindowMemory {
  /** The order and filter the stretch belongs to; another one starts again from the top. */
  sig: string;
  from: number;
  to: number;
  /** Heights of cards that were built and left, by post key (so a new order does not lose them). */
  heights: Map<string, number>;
}

export const newWindowMemory = (): WindowMemory => ({ sig: "", from: 0, to: 0, heights: new Map() });

/** Another order or filter: the stretch starts at the top again, the measured heights stay. */
export function restartWindow(m: WindowMemory, sig: string): void {
  if (m.sig === sig) return;
  m.sig = sig;
  m.from = 0;
  m.to = WINDOW_FIRST;
}

/** The stretch cut to a list of `total` rows. */
export function clampWindow(m: WindowMemory, total: number): void {
  m.to = Math.min(Math.max(m.to, WINDOW_FIRST), total);
  m.from = Math.max(0, Math.min(m.from, m.to));
}

/** Scrolling down: how many cards to add below, and how many to drop at the top to stay within WINDOW_MAX. */
export function planDown(m: Pick<WindowMemory, "from" | "to">, total: number): { add: number; drop: number } {
  const add = Math.max(0, Math.min(WINDOW_STEP, total - m.to));
  return { add, drop: Math.max(0, m.to + add - m.from - WINDOW_MAX) };
}

/** Scrolling up: how many cards to add above, and how many to drop at the bottom. */
export function planUp(m: Pick<WindowMemory, "from" | "to">): { add: number; drop: number } {
  const add = Math.min(WINDOW_STEP, m.from);
  return { add, drop: Math.max(0, m.to - (m.from - add) - WINDOW_MAX) };
}

/** The height of rows [from, to) of `keys`: measured ones as measured, the rest at the average of the measured (CARD_PX before any). */
export function estimateHeight(heights: ReadonlyMap<string, number>, keys: readonly string[], from: number, to: number): number {
  let known = 0;
  let sum = 0;
  for (const h of heights.values()) {
    sum += h;
    known++;
  }
  const average = known > 0 ? sum / known : CARD_PX;
  let total = 0;
  for (let i = from; i < to; i++) total += heights.get(keys[i] ?? "") ?? average;
  return total;
}

export interface WindowOptions {
  /** The element that holds the window (its place in the page). */
  into: HTMLElement;
  /** The element that scrolls. */
  scroller: HTMLElement | null;
  /** The key of each row, in the order shown. */
  keys: string[];
  memory: WindowMemory;
  /** Build row `index` before `before` (null: at the end) and return its element. */
  build: (index: number, before: HTMLElement | null) => HTMLElement;
  /** A built row left the page. */
  dropped: (key: string) => void;
  /** What follows the last row once it is built (e.g. "Load older posts"). */
  footer: (into: HTMLElement) => void;
  /** The text of the button that adds more by hand (a device where scrolling does not). */
  moreLabel: (left: number) => string;
}

/** Draws the stretch `memory` says, and moves it as the list is scrolled. */
export class StreamWindow {
  private readonly top: HTMLElement;
  private readonly bottom: HTMLElement;
  private readonly cards = new Map<number, HTMLElement>();
  private topPx = 0;
  private readonly observer: IntersectionObserver;

  constructor(private readonly o: WindowOptions) {
    const m = o.memory;
    clampWindow(m, o.keys.length);
    this.top = o.into.createDiv({ cls: "blyg-reader-wintop" });
    this.bottom = o.into.createDiv({ cls: "blyg-reader-more" });
    this.topPx = estimateHeight(m.heights, o.keys, 0, m.from);
    this.setTop();
    for (let i = m.from; i < m.to; i++) this.cards.set(i, o.build(i, this.bottom));
    this.observer = new IntersectionObserver((entries) => this.seen(entries), { root: o.scroller, rootMargin: "600px 0px" });
    this.settle();
  }

  private setTop(): void {
    this.top.setCssProps({ height: `${Math.round(this.topPx)}px` });
  }

  private seen(entries: IntersectionObserverEntry[]): void {
    if (!this.o.into.isConnected) {
      this.observer.disconnect();
      return;
    }
    const m = this.o.memory;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (e.target === this.bottom && m.to < this.o.keys.length) this.down();
      else if (e.target === this.top && m.from > 0) this.up();
    }
  }

  /** The bottom row of the window (the "more" button, or the footer once the last row is built), and the watchers, set up again after every change. */
  private settle(): void {
    const m = this.o.memory;
    const total = this.o.keys.length;
    this.bottom.empty();
    if (m.to < total) {
      const left = total - m.to;
      const button = this.bottom.createEl("button", { text: this.o.moreLabel(left), cls: "blyg-reader-btn blyg-reader-quiet" });
      button.addEventListener("click", () => this.down());
    } else this.o.footer(this.bottom);
    // Watching again makes the observer report at once, so a step that left the edge still in view takes the next one.
    this.observer.unobserve(this.bottom);
    this.observer.unobserve(this.top);
    this.observer.observe(this.bottom);
    if (m.from > 0) this.observer.observe(this.top);
  }

  private down(): void {
    const m = this.o.memory;
    const { add, drop } = planDown(m, this.o.keys.length);
    if (add === 0) return;
    for (let i = m.to; i < m.to + add; i++) this.cards.set(i, this.o.build(i, this.bottom));
    m.to += add;
    // The cards that leave at the top are measured first, then removed and replaced by a spacer of the same height: what is on the screen does not move.
    const gone: Array<[number, HTMLElement, number]> = [];
    for (let i = m.from; i < m.from + drop; i++) {
      const el = this.cards.get(i);
      if (el) gone.push([i, el, el.getBoundingClientRect().height]);
    }
    for (const [i, el, h] of gone) {
      const key = this.o.keys[i] ?? "";
      m.heights.set(key, h);
      this.topPx += h;
      el.remove();
      this.cards.delete(i);
      this.o.dropped(key);
    }
    m.from += drop;
    this.setTop();
    this.settle();
  }

  private up(): void {
    const m = this.o.memory;
    const { add, drop } = planUp(m);
    if (add === 0) return;
    const first = this.cards.get(m.from) ?? this.bottom;
    const before = this.topPx;
    const estimated = estimateHeight(m.heights, this.o.keys, m.from - add, m.from);
    const fresh: Array<[number, HTMLElement]> = [];
    for (let i = m.from - add; i < m.from; i++) {
      const el = this.o.build(i, first);
      this.cards.set(i, el);
      fresh.push([i, el]);
    }
    m.from -= add;
    this.topPx = Math.max(0, this.topPx - estimated);
    this.setTop();
    let actual = 0;
    for (const [i, el] of fresh) {
      const h = el.getBoundingClientRect().height;
      m.heights.set(this.o.keys[i] ?? "", h);
      actual += h;
    }
    // Everything changed here is above what is on the screen: moving the scroll by what it grew or shrank keeps the screen where it was.
    if (this.o.scroller) this.o.scroller.scrollTop += this.topPx + actual - before;
    for (let i = m.to - 1; i >= m.to - drop; i--) {
      this.cards.get(i)?.remove();
      this.cards.delete(i);
      this.o.dropped(this.o.keys[i] ?? "");
    }
    m.to -= drop;
    this.settle();
  }
}
