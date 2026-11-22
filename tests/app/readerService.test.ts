// Characterization of the reader's Studio conversation (app/readerService.ts): the pause, the back-off, the messages, the quick look.
// These pin what the reader did when this logic lived in main.ts; a change that breaks one of them changes what a person sees.
import { describe, expect, it } from "vitest";
import { CHECK_PAUSE_MS, createReaderService, type ReaderStudio } from "../../src/app/readerService";
import { M } from "../../src/publish/messages";
import type { StudioClient } from "../../src/studio/client";
import type { InboundMention, ReadingPost } from "../../src/studio/reading";
import type { StudioResult } from "../../src/studio/types";
import { backoffDelay, knownOf } from "../../src/ui/readerSync";

const post = (id: string, over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "S", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2026-11-10T00:00:00Z", created: null, isReply: false, contentHtml: "<p>x</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });
const ok = <T>(value: T): StudioResult<T> => ({ kind: "ok", value });
const serverError: StudioResult<never> = { kind: "error", status: 503, message: "down" };
const forbidden: StudioResult<never> = { kind: "forbidden", message: "no" };

type Script = Partial<{ [K in keyof StudioClient]: (...args: Parameters<StudioClient[K]>) => unknown }>;

function setup(script: Script, opts: { start?: number; build?: ReaderStudio } = {}) {
  const clock = { t: opts.start ?? 1_000_000 };
  const calls: string[] = [];
  const remembered: ReadingPost[][] = [];
  const warnings: string[] = [];
  const client = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { calls.push(name); const fn = (script as Record<string, (...a: unknown[]) => unknown>)[name]; if (!fn) throw new Error(`unscripted ${name}`); return Promise.resolve(fn(...args)); } }) as unknown as StudioClient;
  let built: ReaderStudio = opts.build ?? { ok: true, studio: { client, address: { origin: "https://studio.example.com" } } };
  const service = createReaderService({ build: () => built, now: () => clock.t, rememberPosts: (p) => remembered.push(p), warn: (l) => warnings.push(l) });
  return { service, clock, calls, remembered, warnings, setBuild: (b: ReaderStudio) => void (built = b) };
}

describe("checkForNew", () => {
  it("asks the Studio and reports how many blygs it is polling", async () => {
    const t = setup({ pollSubscriptions: () => ok({ polling: 3 }) });
    expect(await t.service.checkForNew(false)).toEqual({ asked: true, polling: 3 });
  });
  it("pauses 60 s after a check that worked, forced or not, without asking again", async () => {
    const t = setup({ pollSubscriptions: () => ok({ polling: 1 }) });
    await t.service.checkForNew(false);
    t.clock.t += CHECK_PAUSE_MS - 1;
    expect(await t.service.checkForNew(true)).toEqual({ asked: false });
    expect(await t.service.checkForNew(false)).toEqual({ asked: false });
    expect(t.calls).toEqual(["pollSubscriptions"]);
    t.clock.t += 1;
    expect((await t.service.checkForNew(false)).asked).toBe(true);
    expect(t.calls).toHaveLength(2);
  });
  it("the pause is 60 seconds", () => expect(CHECK_PAUSE_MS).toBe(60_000));
  it("backs off after an error: not forced is told to wait (minutes rounded up), forced asks anyway", async () => {
    const t = setup({ pollSubscriptions: () => serverError });
    expect(await t.service.checkForNew(false)).toEqual({ asked: false, reason: "The Studio could not be asked to check for new posts. The list shows what it already has." });
    expect(await t.service.checkForNew(false)).toEqual({ asked: false, reason: "The Studio is not answering; the reader tries again in about 1 min (Refresh asks now)." });
    expect(t.calls).toHaveLength(1);
    await t.service.checkForNew(true);
    expect(t.calls).toHaveLength(2);
    // two failures: 60 s of back-off, so "about 1 min" at once, and "2 min" after the third (120 s) failure
    await t.service.checkForNew(true);
    expect(await t.service.checkForNew(false)).toEqual({ asked: false, reason: "The Studio is not answering; the reader tries again in about 2 min (Refresh asks now)." });
  });
  it("asks again once the back-off has passed, and a success clears it", async () => {
    let answer: StudioResult<{ polling: number }> = serverError;
    const t = setup({ pollSubscriptions: () => answer });
    await t.service.checkForNew(false);
    t.clock.t += backoffDelay(1);
    answer = ok({ polling: 2 });
    expect(await t.service.checkForNew(false)).toEqual({ asked: true, polling: 2 });
    t.clock.t += CHECK_PAUSE_MS;
    answer = serverError;
    await t.service.checkForNew(false); // failure count starts over: 30 s again, not 60 s
    t.clock.t += backoffDelay(1);
    answer = ok({ polling: 1 });
    expect((await t.service.checkForNew(false)).asked).toBe(true);
  });
  it("a forbidden token gets its own words and does not back off", async () => {
    const t = setup({ pollSubscriptions: () => forbidden });
    expect(await t.service.checkForNew(false)).toEqual({ asked: false, reason: "Your token cannot ask the Studio to check for new posts (it needs the permission “owner:manage”). The list shows what the Studio already has." });
    expect(((await t.service.checkForNew(false)) as { reason?: string }).reason).toMatch(/permission/);
    expect(t.calls).toHaveLength(2);
  });
  it("an unreachable Studio (a throw) says so and backs off", async () => {
    const t = setup({ pollSubscriptions: () => { throw new Error("offline"); } });
    expect(await t.service.checkForNew(false)).toEqual({ asked: false, reason: "The Studio could not be reached to check for new posts." });
    expect(((await t.service.checkForNew(false)) as { reason?: string }).reason).toMatch(/not answering/);
  });
  it("a failed check does not start the 60 s pause", async () => {
    const t = setup({ pollSubscriptions: () => serverError });
    await t.service.checkForNew(false);
    await t.service.checkForNew(true);
    expect(t.calls).toHaveLength(2);
  });
  it("without a Studio: the not-configured text is the reader's own, other problems pass through", async () => {
    const t = setup({}, { build: { ok: false, message: M.studioNotConfigured } });
    expect(await t.service.checkForNew(false)).toEqual({ asked: false, reason: "Connect your Studio to read followed blygs: Settings → Blyg." });
    t.setBuild({ ok: false, message: "No token." });
    expect(await t.service.checkForNew(false)).toEqual({ asked: false, reason: "No token." });
  });
});

describe("changeMarks", () => {
  it("reads the epoch and the two counters, missing ones as 0", async () => {
    const t = setup({ changes: () => ok({ epoch: "e1", domains: { reading: 5 } }) });
    expect(await t.service.changeMarks()).toEqual({ epoch: "e1", reading: 5, subscriptions: 0 });
  });
  it("is null without a Studio, and when the answer is not ok", async () => {
    expect(await setup({}, { build: { ok: false, message: "x" } }).service.changeMarks()).toBeNull();
    expect(await setup({ changes: () => forbidden }).service.changeMarks()).toBeNull();
  });
  it("an error or a throw backs off (and the next call does not ask); forbidden does not", async () => {
    const t = setup({ changes: () => serverError });
    expect(await t.service.changeMarks()).toBeNull();
    expect(await t.service.changeMarks()).toBeNull();
    expect(t.calls).toEqual(["changes"]);
    const f = setup({ changes: () => forbidden });
    await f.service.changeMarks();
    await f.service.changeMarks();
    expect(f.calls).toHaveLength(2);
    const th = setup({ changes: () => { throw new Error("x"); } });
    await th.service.changeMarks();
    await th.service.changeMarks();
    expect(th.calls).toHaveLength(1);
  });
  it("shares the back-off with checkForNew", async () => {
    const t = setup({ pollSubscriptions: () => serverError, changes: () => ok({ epoch: "e", domains: {} }) });
    await t.service.checkForNew(false);
    expect(await t.service.changeMarks()).toBeNull();
    expect(t.calls).toEqual(["pollSubscriptions"]);
  });
});

describe("load", () => {
  const mention = { id: "m1" } as unknown as InboundMention;
  const reading = (posts: ReadingPost[], over: Partial<{ unreadable: number; stopped: boolean }> = {}) => ok({ posts, complete: true, unreadable: 0, stopped: false, ...over });
  const base: Script = { listReading: () => reading([post("a")]), listInboundMentions: () => ok({ mentions: [mention], complete: true, unreadable: 0 }), listOwnReading: () => ok({ posts: [post("own")] }) };

  it("returns the posts, the mentions, the Studio's origin, and remembers the posts", async () => {
    const t = setup(base);
    const got = await t.service.load();
    expect(got).toEqual({ ok: true, data: { posts: [post("a")], mentions: [mention], mentionsFetched: true, note: "", studioOrigin: "https://studio.example.com", incremental: false } });
    expect(t.remembered).toEqual([[post("a")]]);
    expect(t.calls).not.toContain("listOwnReading");
  });
  it("reads the whole window with the page cap and size, and passes progress through", async () => {
    let seen: unknown[] = [];
    const t = setup({ ...base, listReading: (...args) => { seen = args; return reading([]); } });
    const progress = () => {};
    await t.service.load(progress);
    expect(seen[0]).toBe(2);
    expect(seen[1]).toBe(progress);
    expect(seen[2]).toEqual({ pageSize: 100 });
  });
  it("a quick look hands the walk a stop rule that fires when the page ends on a held post; it never asks for own posts", async () => {
    let opts: { stopAfter?: (rows: ReadingPost[]) => boolean } = {};
    const held = [post("a")];
    const t = setup({ ...base, listReading: (_p, _o, o) => { opts = o as typeof opts; return reading([post("n")], { stopped: true }); } });
    const got = await t.service.load(undefined, { known: knownOf(held), own: true });
    expect(opts.stopAfter?.(held)).toBe(true);
    expect(opts.stopAfter?.([post("new")])).toBe(false);
    expect(got.ok && got.data.incremental).toBe(true);
    expect(t.calls).not.toContain("listOwnReading");
  });
  it("adds the owner's own posts after the read ones, on a whole read only", async () => {
    const t = setup(base);
    const got = await t.service.load(undefined, { own: true });
    expect(got.ok && got.data.posts.map((p) => p.remoteId)).toEqual(["a", "own"]);
    const failing = setup({ ...base, listOwnReading: () => serverError });
    const g2 = await failing.service.load(undefined, { own: true });
    expect(g2.ok && g2.data.posts.map((p) => p.remoteId)).toEqual(["a"]);
  });
  it("mentions: false does not ask for them and says they were not fetched", async () => {
    const t = setup(base);
    const got = await t.service.load(undefined, { mentions: false });
    expect(t.calls).not.toContain("listInboundMentions");
    expect(got.ok && got.data.mentionsFetched).toBe(false);
    expect(got.ok && got.data.mentions).toEqual([]);
  });
  it("mentions failing: the posts still come, with a note, not fetched, and no back-off", async () => {
    const t = setup({ ...base, listInboundMentions: () => serverError });
    const got = await t.service.load();
    expect(got.ok && got.data).toMatchObject({ mentions: [], mentionsFetched: false, note: "Mentions are not available." });
    expect((await t.service.load()).ok).toBe(true);
  });
  it("counts what could not be read, in posts and mentions, and joins the notes", async () => {
    const t = setup({ ...base, listReading: () => reading([post("a")], { unreadable: 2 }), listInboundMentions: () => ok({ mentions: [], complete: true, unreadable: 1 }) });
    expect(await t.service.load()).toMatchObject({ data: { note: "3 could not be read." } });
    const both = setup({ ...base, listReading: () => reading([], { unreadable: 1 }), listInboundMentions: () => forbidden });
    expect(await both.service.load()).toMatchObject({ data: { note: "1 could not be read. Mentions are not available." } });
  });
  it("a failed listing returns the Studio's own words, or the default, and an error backs off", async () => {
    const t = setup({ ...base, listReading: () => serverError });
    expect(await t.service.load()).toEqual({ ok: false, message: "down" });
    expect(await t.service.load()).toEqual({ ok: false, message: "The Studio is not answering; the reader tries again in about 1 min (Refresh asks now)." });
    expect(t.calls.filter((c) => c === "listReading")).toHaveLength(1);
    expect((await t.service.load(undefined, { force: true })).ok).toBe(false);
    expect(t.calls.filter((c) => c === "listReading")).toHaveLength(2);
    const nf = setup({ ...base, listReading: () => ({ kind: "not-found" }) });
    expect(await nf.service.load()).toEqual({ ok: false, message: "The Studio could not list what you read." });
    await nf.service.load();
    expect(nf.calls.filter((c) => c === "listReading")).toHaveLength(2); // not-found does not back off
    expect(t.remembered).toEqual([]);
  });
  it("a throw says the Studio could not be reached, logs it, and backs off", async () => {
    const t = setup({ ...base, listReading: () => { throw new Error("boom"); } });
    expect(await t.service.load()).toEqual({ ok: false, message: "The Studio could not be reached." });
    expect(t.warnings).toEqual(["reader load failed: boom"]);
    expect((await t.service.load()).ok).toBe(false);
    expect(t.calls.filter((c) => c === "listReading")).toHaveLength(1);
  });
  it("without a Studio: the not-configured text is the reader's own", async () => {
    const t = setup({}, { build: { ok: false, message: M.studioNotConfigured } });
    expect(await t.service.load()).toEqual({ ok: false, message: "Connect your Studio to read followed blygs: Settings → Blyg." });
  });
  it("a success clears an earlier failure's back-off", async () => {
    let answer: StudioResult<{ posts: ReadingPost[]; complete: boolean; unreadable: number; stopped: boolean }> = serverError;
    const t = setup({ ...base, listReading: () => answer });
    await t.service.load();
    answer = ok({ posts: [], complete: true, unreadable: 0, stopped: false });
    expect((await t.service.load(undefined, { force: true })).ok).toBe(true);
    expect((await t.service.load()).ok).toBe(true);
  });
});

describe("state (the real-Obsidian scenario sets it from outside)", () => {
  it("a back-off put in from outside is honoured, and clearing it asks again", async () => {
    const t = setup({ pollSubscriptions: () => ok({ polling: 1 }) });
    t.service.state.trouble = { failures: 2, until: t.clock.t + 120_000 };
    expect(((await t.service.checkForNew(false)) as { reason?: string }).reason).toMatch(/about 2 min/);
    t.service.state.trouble = { failures: 0, until: 0 };
    expect((await t.service.checkForNew(false)).asked).toBe(true);
  });
  it("checkedAt = 0 lifts the pause", async () => {
    const t = setup({ pollSubscriptions: () => ok({ polling: 1 }) });
    await t.service.checkForNew(false);
    expect((await t.service.checkForNew(false)).asked).toBe(false);
    t.service.state.checkedAt = 0;
    expect((await t.service.checkForNew(false)).asked).toBe(true);
  });
});
