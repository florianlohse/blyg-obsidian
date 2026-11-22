// HK4: the index arithmetic of the feed window (ui/readerWindow.ts) and what loaded older posts do to the list held (ui/readerSync.ts, ui/readerOlderRow.ts).
import { describe, expect, it } from "vitest";
import type { ReadingPost } from "../src/studio/reading";
import type { ReaderData } from "../src/ui/ReaderView";
import { OlderPosts } from "../src/ui/readerOlderRow";
import { keepOlderTail, keyOf, OLDER_MAX, READER_KEEP, type OlderResult } from "../src/ui/readerSync";
import { CARD_PX, clampWindow, estimateHeight, newWindowMemory, planDown, planUp, restartWindow, WINDOW_FIRST, WINDOW_MAX, WINDOW_STEP } from "../src/ui/readerWindow";

const post = (id: string, day: number, over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "S", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`, created: null, isReply: false, contentHtml: "<p>x</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });

describe("the window's plan", () => {
  it("scrolling down adds a step and drops nothing until the window is full", () => {
    expect(planDown({ from: 0, to: 30 }, 1000)).toEqual({ add: WINDOW_STEP, drop: 0 });
    expect(planDown({ from: 0, to: 80 }, 1000)).toEqual({ add: WINDOW_STEP, drop: 0 });
    expect(planDown({ from: 0, to: 100 }, 1000)).toEqual({ add: WINDOW_STEP, drop: 20 });
  });
  it("never adds past the end of the list", () => {
    expect(planDown({ from: 0, to: 30 }, 40)).toEqual({ add: 10, drop: 0 });
    expect(planDown({ from: 0, to: 40 }, 40)).toEqual({ add: 0, drop: 0 });
  });
  it("scrolling up adds above (at most what is there) and drops below to stay within the maximum", () => {
    expect(planUp({ from: 0, to: 30 })).toEqual({ add: 0, drop: 0 });
    expect(planUp({ from: 10, to: 50 })).toEqual({ add: 10, drop: 0 });
    expect(planUp({ from: 400, to: 520 })).toEqual({ add: WINDOW_STEP, drop: WINDOW_STEP });
  });
  it("a long walk down and back keeps the built count at or under the maximum, and the stretch contiguous", () => {
    const total = 5000;
    const m = { from: 0, to: WINDOW_FIRST };
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      const p = planDown(m, total);
      m.to += p.add;
      m.from += p.drop;
      peak = Math.max(peak, m.to - m.from);
    }
    expect(m.to).toBe(total);
    expect(m.from).toBe(total - WINDOW_MAX);
    for (let i = 0; i < 200; i++) {
      const p = planUp(m);
      m.from -= p.add;
      m.to -= p.drop;
      peak = Math.max(peak, m.to - m.from);
      expect(m.from).toBeGreaterThanOrEqual(0);
      expect(m.to).toBeGreaterThan(m.from);
    }
    expect(m.from).toBe(0);
    expect(peak).toBeLessThanOrEqual(WINDOW_MAX + WINDOW_STEP); // a step is added before the drop, then the drop brings it back
  });
});

describe("the window's memory", () => {
  it("another order or filter starts at the top again, and keeps the measured heights", () => {
    const m = newWindowMemory();
    restartWindow(m, "a");
    expect(m).toMatchObject({ from: 0, to: WINDOW_FIRST });
    m.from = 300;
    m.to = 420;
    m.heights.set("k", 99);
    restartWindow(m, "a");
    expect(m).toMatchObject({ from: 300, to: 420 });
    restartWindow(m, "b");
    expect(m).toMatchObject({ from: 0, to: WINDOW_FIRST });
    expect(m.heights.get("k")).toBe(99);
  });
  it("is cut to a shorter list", () => {
    const m = { ...newWindowMemory(), from: 300, to: 420 };
    clampWindow(m, 100);
    expect(m).toMatchObject({ from: 100, to: 100 });
    const small = { ...newWindowMemory(), from: 0, to: 30 };
    clampWindow(small, 5);
    expect(small.to).toBe(5);
  });
  it("estimates a stretch from the heights measured, and the average for the rest", () => {
    const keys = ["a", "b", "c", "d"];
    expect(estimateHeight(new Map(), keys, 0, 4)).toBe(4 * CARD_PX);
    expect(estimateHeight(new Map([["a", 100], ["b", 200]]), keys, 0, 4)).toBe(100 + 200 + 150 + 150);
    expect(estimateHeight(new Map([["a", 100]]), keys, 1, 3)).toBe(200);
  });
});

describe("keepOlderTail: a whole read of the newest window does not lose what was loaded further back", () => {
  const fresh = [post("n", 20), post("a", 19), post("b", 18)];
  const held = [post("a", 19), post("b", 18), post("c", 17), post("d", 16), post("own", 25, { own: true })];
  it("keeps the held posts older than the oldest fresh one, not the own ones", () => {
    expect(keepOlderTail(held, fresh, true).map((p) => p.remoteId)).toEqual(["n", "a", "b", "c", "d"]);
  });
  it("keeps nothing when the list ended inside the window", () => {
    expect(keepOlderTail(held, fresh, false)).toBe(fresh);
  });
  it("lets the fresh row win over a held row of the same post, and does not duplicate", () => {
    const got = keepOlderTail([post("b", 18, { version: 1 }), post("c", 17)], [post("b", 18, { version: 2 })], true);
    expect(got.map((p) => `${p.remoteId}${p.version}`)).toEqual(["b2", "c1"]);
  });
  it("a post that rolled out of the window is not older than it: it is dropped", () => {
    expect(keepOlderTail([post("gone", 19)], fresh, true).map((p) => p.remoteId)).toEqual(["n", "a", "b"]);
  });
  it("the memory limit is what the merges keep", () => expect(READER_KEEP).toBe(OLDER_MAX));
});

describe("OlderPosts", () => {
  function setup(answers: OlderResult[], held: ReadingPost[] = [post("a", 19)]) {
    let data: ReaderData | null = { posts: held, mentions: [], note: "", studioOrigin: null };
    const redraws: string[] = [];
    let asked = 0;
    const older = new OlderPosts({
      load: () => Promise.resolve(answers[asked++] ?? { ok: false, message: "no answer" }),
      data: () => data,
      replace: (posts) => void (data = data ? { ...data, posts } : null),
      redraw: () => void redraws.push("x"),
    });
    return { older, get posts() { return data?.posts.map(keyOf) ?? []; }, redraws, get asked() { return asked; }, clear: () => void (data = null) };
  }
  it("merges what arrived into the list held and redraws before and after", async () => {
    const t = setup([{ ok: true, posts: [post("b", 18), post("c", 17)], more: true, capped: false }]);
    t.older.setMore(true);
    await t.older.load();
    expect(t.posts).toEqual(["s/a", "s/b", "s/c"]);
    expect(t.redraws).toHaveLength(2);
  });
  it("two presses at once make one request", async () => {
    const t = setup([{ ok: true, posts: [], more: true, capped: false }, { ok: true, posts: [], more: true, capped: false }]);
    await Promise.all([t.older.load(), t.older.load()]);
    expect(t.asked).toBe(1);
  });
  it("a failure keeps the list and can be tried again", async () => {
    const t = setup([{ ok: false, message: "The Studio is limiting requests." }, { ok: true, posts: [post("b", 18)], more: false, capped: false }]);
    t.older.setMore(true);
    await t.older.load();
    expect(t.posts).toEqual(["s/a"]);
    await t.older.load();
    expect(t.posts).toEqual(["s/a", "s/b"]);
  });
  it("does nothing when there is no list", async () => {
    const t = setup([]);
    t.clear();
    await t.older.load();
    expect(t.asked).toBe(0);
  });
});
