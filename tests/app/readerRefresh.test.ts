// The one Refresh of the feed and the digest (app/readerRefresh.ts): one ask of the Studio and one read of the list per tap, the 60 s pause and the back-off of
// readerService.ts apply to both, nothing happens without a tap. Fake Studio, fake clock and sleep: no waiting.
import { describe, expect, it } from "vitest";
import { askAndWait, createDigestRefresh } from "../../src/app/readerRefresh";
import { CHECK_PAUSE_MS, createReaderService } from "../../src/app/readerService";
import type { StudioClient } from "../../src/studio/client";
import type { ReadingPost } from "../../src/studio/reading";
import type { ChangeMarks } from "../../src/ui/ReaderView";

const post = (id: string): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "S", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2026-11-10T00:00:00Z", created: null, isReply: false, contentHtml: "<p>x</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null });
const ok = <T>(value: T) => ({ kind: "ok" as const, value });

function studio(opts: { pollFails?: boolean } = {}) {
  const clock = { t: 5_000_000 };
  const calls: string[] = [];
  let subs = 0;
  const client = {
    pollSubscriptions: () => (calls.push("poll"), Promise.resolve(opts.pollFails ? ({ kind: "error" as const, status: 503, message: "down" }) : ok({ polling: 2 }))),
    changes: () => (calls.push("changes"), Promise.resolve(ok({ epoch: "e", domains: { reading: 1, subscriptions: (subs += 1) } }))),
    listReading: () => (calls.push("list"), Promise.resolve(ok({ posts: [post("a"), post("b")], next: null, complete: true, stopped: false, unreadable: 0 }))),
    listInboundMentions: () => (calls.push("mentions"), Promise.resolve(ok({ mentions: [], unreadable: 0 }))),
    listOwnReading: () => (calls.push("own"), Promise.resolve(ok({ posts: [] }))),
  } as unknown as StudioClient;
  const service = createReaderService({ build: () => ({ ok: true, studio: { client, address: { origin: "https://studio.example.com" } } }), now: () => clock.t, rememberPosts: () => undefined, warn: () => undefined });
  const wrote: number[] = [];
  const refresh = createDigestRefresh({ ...service, writeCache: (d) => void wrote.push(d.posts.length) }, () => clock.t);
  const sleep = (ms: number): Promise<void> => (clock.t += ms, Promise.resolve());
  return { clock, calls, service, refresh, wrote, sleep };
}
const count = (calls: string[], name: string): number => calls.filter((c) => c === name).length;

describe("askAndWait", () => {
  it("asks once, then watches the counters until every blyg has reported", async () => {
    const asked: boolean[] = [];
    const seen: ChangeMarks[] = [];
    let subs = 0;
    const lines: string[] = [];
    const got = await askAndWait(
      { checkForNew: (f) => (asked.push(f), Promise.resolve({ asked: true as const, polling: 2 })), changeMarks: () => Promise.resolve({ epoch: "e", reading: 0, subscriptions: subs++ }) },
      { force: true, noteMarks: (m) => (seen.push(m), true), alive: () => true, status: (t) => void lines.push(t), sleep: () => Promise.resolve() },
    );
    expect(got).toEqual({ kind: "done" });
    expect(asked).toEqual([true]);
    expect(lines.at(-1)).toBe("Checking blygs · 2/2");
  });
  it("is cancelled when a newer check replaced it, and gives up after half a minute of silence", async () => {
    let alive = true;
    const t = { now: 0 };
    const ports = { checkForNew: () => Promise.resolve({ asked: true as const, polling: 9 }), changeMarks: () => Promise.resolve({ epoch: "e", reading: 0, subscriptions: 0 }) };
    const slept: number[] = [];
    const done = await askAndWait(ports, { force: true, noteMarks: () => false, alive: () => alive, status: () => undefined, sleep: (ms) => (slept.push(ms), (t.now += ms), Promise.resolve()), now: () => t.now });
    expect(done).toEqual({ kind: "done" });
    expect(t.now).toBeGreaterThanOrEqual(30_000);
    alive = false;
    expect(await askAndWait(ports, { force: true, noteMarks: () => false, alive: () => alive, status: () => undefined, sleep: () => Promise.resolve() })).toEqual({ kind: "cancelled" });
  });
  it("is skipped, with the reason, when the Studio was not asked", async () => {
    const got = await askAndWait({ checkForNew: () => Promise.resolve({ asked: false as const, reason: "wait" }), changeMarks: () => Promise.resolve(null) }, { force: true, noteMarks: () => false, alive: () => true, status: () => undefined });
    expect(got).toEqual({ kind: "skipped", reason: "wait" });
  });
});

describe("the digest's Refresh is the feed's", () => {
  it("makes no request until it is tapped", () => {
    const t = studio();
    expect(t.calls).toEqual([]);
  });
  it("one tap: one poll and one read of the list, then the list is saved for the next session", async () => {
    const t = studio();
    const sleep = t.sleep;
    // the injected clock moves with the sleeps, so the waiting costs nothing
    const orig = globalThis.window;
    (globalThis as unknown as { window: unknown }).window = { setTimeout: (f: () => void, ms: number) => (void sleep(ms), f(), 0) };
    try {
      const r = await t.refresh({ held: null, alive: () => true, status: () => undefined });
      expect(r.ok).toBe(true);
    } finally {
      (globalThis as unknown as { window: unknown }).window = orig;
    }
    expect(count(t.calls, "poll")).toBe(1);
    expect(count(t.calls, "list")).toBe(1);
    expect(t.wrote).toEqual([2]);
  });
  it("a second tap inside the 60 s pause asks no blyg again (one list read), after the pause it asks once more", async () => {
    const t = studio();
    const orig = globalThis.window;
    (globalThis as unknown as { window: unknown }).window = { setTimeout: (f: () => void, ms: number) => (void t.sleep(ms), f(), 0) };
    try {
      await t.refresh({ held: null, alive: () => true, status: () => undefined });
      const polls = count(t.calls, "poll");
      const again = await t.refresh({ held: null, alive: () => true, status: () => undefined });
      expect(again.ok).toBe(true);
      expect(count(t.calls, "poll")).toBe(polls); // within the pause: no new poll, the list is still read once more
      expect(count(t.calls, "list")).toBe(2);
      t.clock.t += CHECK_PAUSE_MS;
      await t.refresh({ held: null, alive: () => true, status: () => undefined });
      expect(count(t.calls, "poll")).toBe(polls + 1);
    } finally {
      (globalThis as unknown as { window: unknown }).window = orig;
    }
  });
  it("shares the feed's memory of when the whole window was last read: the first tap reads it all, a tap within the minute reads only the newest rows", async () => {
    const t = studio();
    const sync = { lastFullAt: 0, readingMoved: false, movedWithoutNew: false };
    const refresh = createDigestRefresh({ ...t.service, writeCache: () => undefined }, () => t.clock.t, undefined, () => sync);
    const orig = globalThis.window;
    (globalThis as unknown as { window: unknown }).window = { setTimeout: (f: () => void, ms: number) => (void t.sleep(ms), f(), 0) };
    try {
      await refresh({ held: null, alive: () => true, status: () => undefined });
      expect(sync.lastFullAt).toBeGreaterThan(0);
      const first = sync.lastFullAt;
      await refresh({ held: { posts: [post("a"), post("b")], mentions: [] }, alive: () => true, status: () => undefined });
      expect(sync.lastFullAt).toBe(first); // an incremental read leaves it alone
      expect(count(t.calls, "mentions")).toBe(1); // (the quick look asks for no mentions)
    } finally {
      (globalThis as unknown as { window: unknown }).window = orig;
    }
  });
  it("a failing poll still reads the list once, says why, as the feed does", async () => {
    const t = studio({ pollFails: true });
    const r = await t.refresh({ held: null, alive: () => true, status: () => undefined });
    expect(r.ok && r.note).toMatch(/could not be asked/);
    expect(count(t.calls, "poll")).toBe(1);
    expect(count(t.calls, "list")).toBe(1);
    // (the list read that follows worked, so the back-off the failed poll started is lifted again: as in the feed)
  });
});
