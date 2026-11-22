// HK4 "load older" against the scale Studio: the whole service (app/readerService.ts) over the real client, a long synthetic list, cursor paging and its failures.
import { describe, expect, it } from "vitest";
import { createReaderService } from "../../src/app/readerService";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import type { ReadingPost } from "../../src/studio/reading";
import { keyOf, OLDER_MAX } from "../../src/ui/readerSync";
import { idleTimers } from "../helpers";
import { SCALE_HOST, SCALE_TOKEN, ScaleStudio } from "./scaleStudio";

function setup(posts: number) {
  const studio = new ScaleStudio(posts, 200);
  const address = studioAddress({ baseUrl: SCALE_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: SCALE_TOKEN });
  const clock = { t: 1_000_000 };
  const service = createReaderService({ build: () => ({ ok: true, studio: { client, address: { origin: SCALE_HOST } } }), now: () => clock.t, rememberPosts: () => {}, warn: () => {} });
  const firstLoad = async () => {
    const got = await service.load(undefined, { force: true, mentions: false });
    if (!got.ok) throw new Error(got.message);
    return got.data;
  };
  return { studio, service, firstLoad, clock };
}
const listRequests = (s: ScaleStudio): number => s.countOf(/GET \/api\/reading\/imported/);

describe("load older, over the cursor", () => {
  it("a whole read says there are older posts; each press reads 200 more with 2 requests, no row twice, in order", async () => {
    const t = setup(1200);
    const first = await t.firstLoad();
    expect(first.posts).toHaveLength(200);
    expect(first.moreOlder).toBe(true);
    const all = [...first.posts];
    const before = listRequests(t.studio);
    for (let press = 1; press <= 5; press++) {
      const got = await t.service.loadOlder();
      expect(got).toMatchObject({ ok: true, more: press < 5, capped: false });
      if (got.ok) all.push(...got.posts);
      expect(listRequests(t.studio) - before).toBe(press * 2);
    }
    expect(all).toHaveLength(1200);
    expect(new Set(all.map(keyOf)).size).toBe(1200);
    const times = all.map((p) => Date.parse(p.observedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // the list is at its end: nothing more is asked
    expect(await t.service.loadOlder()).toEqual({ ok: true, posts: [], more: false, capped: false });
    expect(listRequests(t.studio) - before).toBe(10);
  });

  it("a list of 250 ends at the first press", async () => {
    const t = setup(250);
    await t.firstLoad();
    expect(await t.service.loadOlder()).toMatchObject({ ok: true, more: false });
    expect(await t.service.loadOlder()).toMatchObject({ ok: true, posts: [] });
  });

  it("a list that fits the window says there is nothing older", async () => {
    const t = setup(150);
    expect((await t.firstLoad()).moreOlder).toBe(false);
    expect(await t.service.loadOlder()).toMatchObject({ ok: true, posts: [], more: false });
  });

  it("when the list changed the cursor is dead (409): the walk starts again from the top down to the depth held and goes on", async () => {
    const t = setup(1200);
    await t.firstLoad();
    await t.service.loadOlder(); // depth 400
    t.studio.bump();
    t.studio.requests.length = 0;
    const got = await t.service.loadOlder();
    expect(got.ok && got.posts).toHaveLength(600); // the whole walk again: 400 held + 200 new; the reader merges by key
    expect(t.studio.requests.map((r) => r.status)).toEqual([409, 200, 200, 200, 200, 200, 200]);
    expect(got).toMatchObject({ ok: true, more: true });
    t.studio.requests.length = 0;
    const next = await t.service.loadOlder(); // the cursor is good again: 2 requests
    expect(next.ok && next.posts).toHaveLength(200);
    expect(next.ok && next.posts[0]?.remoteId).toBe("item600");
    expect(t.studio.requests).toHaveLength(2);
  });

  it("a whole read made after posts were loaded does not move the depth back: the next press goes on from the deepest post", async () => {
    const t = setup(1200);
    await t.firstLoad();
    await t.service.loadOlder();
    await t.service.loadOlder(); // depth 600
    t.clock.t += 120_000;
    await t.firstLoad(); // Refresh: the newest window again
    t.studio.requests.length = 0;
    const got = await t.service.loadOlder();
    expect(got.ok && got.posts.at(-1)?.remoteId).toBe("item799");
    expect(got.ok && got.posts).toHaveLength(800); // from the top to 800: 8 pages
    expect(listRequests(t.studio)).toBe(8);
  });

  it("stops at the reader's own limit and says so", async () => {
    const t = setup(OLDER_MAX + 1000);
    await t.firstLoad();
    let last: Awaited<ReturnType<typeof t.service.loadOlder>> = { ok: true, posts: [], more: true, capped: false };
    let held = 200;
    while (last.ok && last.more) {
      last = await t.service.loadOlder();
      if (last.ok) held += last.posts.length;
    }
    expect(held).toBe(OLDER_MAX);
    expect(last).toMatchObject({ ok: true, more: false, capped: true });
    const requests = t.studio.requests.length;
    expect(await t.service.loadOlder()).toMatchObject({ ok: true, posts: [], capped: true });
    expect(t.studio.requests).toHaveLength(requests);
  });

  it("a 429 on the page is reported in words, backs the reader off, and the press can be repeated", async () => {
    const t = setup(1200);
    await t.firstLoad();
    t.studio.faults.push({ match: /GET \/api\/reading\/imported/, answer: { status: 429, headers: { "retry-after": "120" }, text: "{}" }, times: 1 });
    const got = await t.service.loadOlder();
    expect(got).toEqual({ ok: false, message: "The Studio is limiting requests. Wait a minute and try again." });
    expect(t.service.state.trouble.failures).toBe(1);
    const again = await t.service.loadOlder(); // a person's press is not held back by the back-off
    expect(again).toMatchObject({ ok: true });
    expect(t.service.state.trouble.failures).toBe(0);
  });

  it("two presses at once read once", async () => {
    const t = setup(1200);
    await t.firstLoad();
    t.studio.requests.length = 0;
    const [a, b] = await Promise.all([t.service.loadOlder(), t.service.loadOlder()]);
    expect(a).toBe(b);
    expect(listRequests(t.studio)).toBe(2);
  });

  it("older posts are kept without their Markdown", async () => {
    const t = setup(500);
    await t.firstLoad();
    const got = await t.service.loadOlder();
    expect(got.ok && got.posts.every((p: ReadingPost) => p.contentMd === "")).toBe(true);
  });
});
