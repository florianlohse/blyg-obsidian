// "Mark posts as read when I open them": the clock (ui/readerAutoRead.ts) and the setting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSettings } from "../src/settings/migrate";
import { defaultSettings } from "../src/settings/schema";
import type { ReadingPost } from "../src/studio/reading";
import { AUTO_READ_MS, AutoRead } from "../src/ui/readerAutoRead";

const post = (over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s1", remoteId: "p1", version: 1, readVersion: null, observedAt: "2026-11-01T00:00:00Z", ...over }) as ReadingPost;

function setup(p: ReadingPost, enabled = true) {
  const state = { shown: p as ReadingPost | null, enabled, live: p };
  const marked: ReadingPost[] = [];
  const auto = new AutoRead({ enabled: () => state.enabled, current: () => state.shown, live: () => state.live, mark: (q) => marked.push(q) });
  return { state, marked, auto };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("auto-read clock", () => {
  it("marks an unread post once it has been open for a second, not before", () => {
    const { marked, auto } = setup(post());
    auto.arm(post());
    vi.advanceTimersByTime(AUTO_READ_MS - 1);
    expect(marked).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(marked).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(marked).toHaveLength(1);
  });
  it("an accidental tap does not count: leaving to the list or to another post before the second marks nothing", () => {
    const { state, marked, auto } = setup(post());
    auto.arm(post());
    vi.advanceTimersByTime(400);
    state.shown = null;
    vi.advanceTimersByTime(2000);
    expect(marked).toHaveLength(0);
    const second = post({ remoteId: "p2" });
    state.shown = second;
    auto.arm(post());
    vi.advanceTimersByTime(400);
    auto.arm(second); // Next: the first clock is dropped, the second starts afresh
    vi.advanceTimersByTime(700);
    expect(marked).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(marked.map((m) => m.remoteId)).toEqual(["p2"]);
  });
  it("does nothing when the setting is off, also when it is switched off while the clock runs", () => {
    const off = setup(post(), false);
    off.auto.arm(post());
    vi.advanceTimersByTime(3000);
    expect(off.marked).toHaveLength(0);
    const later = setup(post());
    later.auto.arm(post());
    later.state.enabled = false;
    vi.advanceTimersByTime(3000);
    expect(later.marked).toHaveLength(0);
  });
  it("never marks your own post, a withdrawn one, or one already read (a newer version is unread again)", () => {
    for (const p of [post({ own: true }), post({ withdrawn: true }), post({ readVersion: 1 })]) {
      const { marked, auto } = setup(p);
      auto.arm(p);
      vi.advanceTimersByTime(3000);
      expect(marked).toHaveLength(0);
    }
    const updated = post({ version: 2, readVersion: 1 });
    const { marked, auto } = setup(updated);
    auto.arm(updated);
    vi.advanceTimersByTime(AUTO_READ_MS);
    expect(marked).toHaveLength(1);
  });
  it("a post marked read meanwhile (by hand) is not marked again; cancel stops the clock", () => {
    const { state, marked, auto } = setup(post());
    auto.arm(post());
    state.live = post({ readVersion: 1 });
    vi.advanceTimersByTime(3000);
    expect(marked).toHaveLength(0);
    state.live = post();
    auto.arm(post());
    auto.cancel();
    vi.advanceTimersByTime(3000);
    expect(marked).toHaveLength(0);
  });
});

describe("the setting", () => {
  it("is on by default, also for a data.json that never had it; only an explicit false switches it off", () => {
    expect(defaultSettings().readerPane.autoRead).toBe(true);
    expect(migrateSettings({}).settings.readerPane.autoRead).toBe(true);
    expect(migrateSettings({ readerPane: { images: "always" } }).settings.readerPane.autoRead).toBe(true);
    expect(migrateSettings({ readerPane: { autoRead: false } }).settings.readerPane.autoRead).toBe(false);
    expect(migrateSettings({ readerPane: { autoRead: "no" } }).settings.readerPane.autoRead).toBe(true);
  });
});
