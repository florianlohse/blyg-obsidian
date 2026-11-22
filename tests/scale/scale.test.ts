// HK4 scale harness: how the reader's pure parts and its Studio reads behave with a large list. Budgets are deliberately loose (CI machines differ): they
// catch a change that makes something several times worse, not a few percent. Each timed test prints its numbers (`npx vitest run tests/scale --reporter=verbose`).
import { describe, expect, it } from "vitest";
import { syntheticPosts, syntheticRows } from "../../src/dev/syntheticPosts";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { readReadingPost, type ReadingPost } from "../../src/studio/reading";
import { cardOf, arrange, DEFAULT_FILTER } from "../../src/ui/readerFeed";
import { keyOf, knownOf, mergeFresh, READER_PAGE, READER_PAGES, reachedKnown } from "../../src/ui/readerSync";
import { parseReaderCache, readerCacheOf } from "../../src/ui/readerCache";
import { idleTimers } from "../helpers";
import { SCALE_HOST, SCALE_TOKEN, ScaleStudio } from "./scaleStudio";

const N = 10_000;
const ms = (): number => performance.now();
function timed<T>(label: string, f: () => T): { value: T; took: number } {
  const t0 = ms();
  const value = f();
  const took = ms() - t0;
  console.info(`[scale] ${label}: ${took.toFixed(0)} ms`);
  return { value, took };
}

describe("the generator", () => {
  it("is repeatable and makes distinct posts, newest first, with placeholder addresses only", () => {
    const a = syntheticPosts(50);
    const b = syntheticPosts(50);
    expect(a).toEqual(b);
    expect(new Set(a.map(keyOf)).size).toBe(50);
    const times = a.map((p) => Date.parse(p.observedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(JSON.stringify(a)).not.toMatch(/https?:\/\/(?![a-z0-9.-]*example\.test)/);
    expect(syntheticPosts(50, { seed: 2 })).not.toEqual(a);
  });
  it("spreads the posts over the blygs asked for, and its rows are read back as the same posts", () => {
    const posts = syntheticPosts(400, { blygs: 200 });
    expect(new Set(posts.map((p) => p.subscriptionId)).size).toBe(200);
    const rows = syntheticRows(400, { blygs: 200 });
    const back = rows.map(readReadingPost);
    expect(back.every((p) => p !== null)).toBe(true);
    expect(back).toEqual(posts.map((p) => ({ ...p })));
  });
});

describe(`${N} posts: parse, sort, card text`, () => {
  const rows = syntheticRows(N);
  const posts = syntheticPosts(N);

  it("parses 10,000 rows within the budget", () => {
    const { value, took } = timed("parse 10000 rows", () => rows.map(readReadingPost));
    expect(value.filter((p) => p === null)).toHaveLength(0);
    expect(took).toBeLessThan(2000);
  });

  it("merges fresh rows into 10,000 held and sorts them within the budget", () => {
    const fresh = posts.slice(0, 100).map((p) => ({ ...p, version: 2 }));
    const { value, took } = timed("mergeFresh 10000 held + 100 fresh (keep all)", () => mergeFresh(posts, fresh, N));
    expect(value).toHaveLength(N);
    expect(value[0]?.version).toBe(2);
    expect(took).toBeLessThan(1500);
    const sorted = timed("arrange newest, default filter, 10000", () => arrange(posts, DEFAULT_FILTER));
    expect(sorted.value).toHaveLength(N);
    expect(sorted.took).toBeLessThan(1500);
    for (const sort of ["oldest", "shortest", "longest"] as const) {
      const t = timed(`arrange ${sort}, 10000`, () => arrange(posts, { ...DEFAULT_FILTER, sort }));
      expect(t.took).toBeLessThan(3000);
    }
  });

  it("makes the card text of 10,000 posts within the budget", () => {
    const { value, took } = timed("cardOf x 10000", () => posts.map((p) => cardOf(p)));
    expect(value.every((c) => c.words.length <= 320)).toBe(true);
    expect(took).toBeLessThan(6000);
  });

  it("builds the saved list from 10,000 posts and keeps the newest 200 only", () => {
    const { value, took } = timed("readerCacheOf 10000", () => readerCacheOf(posts, [], "https://studio.example.test", 1));
    expect(value.posts).toHaveLength(200);
    expect(parseReaderCache(JSON.parse(JSON.stringify(value)) as unknown, "https://studio.example.test", 2)?.posts).toHaveLength(200);
    expect(took).toBeLessThan(1500);
  });
});

function client(studio: ScaleStudio, timers = idleTimers) {
  const address = studioAddress({ baseUrl: SCALE_HOST, mount: "" });
  if (!address) throw new Error("address");
  return createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers, address }), token: SCALE_TOKEN });
}

describe("how many requests a refresh makes with 200 blygs", () => {
  // The Studio allows 600 requests a minute, shared by every token client of the owner. The reading list is paged by posts, not by blygs.
  it("a whole read is the newest 200 posts: 2 pages, plus mentions, plus the owner's own posts: 6 requests at most, whatever the number of blygs", async () => {
    const studio = new ScaleStudio(N, 200);
    const c = client(studio);
    const reading = await c.listReading(READER_PAGES, undefined, { pageSize: READER_PAGE });
    expect(reading).toMatchObject({ kind: "ok", value: { complete: false } });
    expect(reading.kind === "ok" && reading.value.posts).toHaveLength(200);
    await c.listInboundMentions();
    await c.listOwnReading();
    console.info(`[scale] whole read, 10000 posts over 200 blygs: ${studio.requests.length} requests (${studio.requests.map((r) => r.path.replace("/api", "")).join(", ")})`);
    expect(studio.countOf(/GET \/api\/reading\/imported/)).toBe(2);
    expect(studio.requests.length).toBeLessThanOrEqual(6);
  });

  it("a quick look stops at the first page that ends in known territory: 1 request for the list", async () => {
    const studio = new ScaleStudio(N, 200);
    const c = client(studio);
    const first = await c.listReading(READER_PAGES, undefined, { pageSize: READER_PAGE });
    const held = first.kind === "ok" ? first.value.posts : [];
    studio.requests.length = 0;
    const known = knownOf(held);
    const again = await c.listReading(READER_PAGES, undefined, { pageSize: READER_PAGE, stopAfter: (rows: ReadingPost[]) => reachedKnown(rows, known) });
    expect(again).toMatchObject({ kind: "ok", value: { stopped: true } });
    expect(studio.requests.length).toBe(1); // nothing is new: the first page ends in rows that are held, so the second page is never asked for
  });

  it("the walk never asks for more pages than the window, however long the list is", async () => {
    const studio = new ScaleStudio(N, 200);
    await client(studio).listReading(READER_PAGES, undefined, { pageSize: READER_PAGE });
    expect(studio.requests.length).toBeLessThanOrEqual(READER_PAGES);
  });
});

describe("a 429 with Retry-After", () => {
  const timersRecording = (waits: number[]) => ({ after: (t: number, fn: () => void) => (t !== 20_000 && (waits.push(t), queueMicrotask(fn)), () => {}) });

  it("a short Retry-After is waited out and the read goes on (the walk is unaffected)", async () => {
    const studio = new ScaleStudio(500, 200);
    studio.faults.push({ match: /GET \/api\/reading\/imported/, answer: { status: 429, headers: { "Retry-After": "2" }, text: "{}" }, times: 1 });
    const waits: number[] = [];
    const got = await client(studio, timersRecording(waits)).listReading(READER_PAGES, undefined, { pageSize: READER_PAGE });
    expect(got).toMatchObject({ kind: "ok" });
    expect(waits).toEqual([2000]);
    expect(studio.requests.map((r) => r.status)).toEqual([429, 200, 200]);
  });

  it("a Retry-After of more than 30 s is not waited for: the read fails with the 429 sentence, and the plugin's backoff then takes over", async () => {
    const studio = new ScaleStudio(500, 200);
    studio.faults.push({ match: /GET \/api\/reading\/imported/, answer: { status: 429, headers: { "Retry-After": "60" }, text: "{}" }, times: 5 });
    const waits: number[] = [];
    const got = await client(studio, timersRecording(waits)).listReading(READER_PAGES, undefined, { pageSize: READER_PAGE });
    expect(got).toEqual({ kind: "error", status: 429, message: "The Studio is limiting requests. Wait a minute and try again." });
    expect(waits).toEqual([]);
    expect(studio.requests).toHaveLength(1);
  });

  it("a 429 on the second page throws the whole walk away (no partial list is returned)", async () => {
    const studio = new ScaleStudio(500, 200);
    const seen: number[] = [];
    let page = 0;
    const base = studio.transport;
    const flaky = (req: Parameters<typeof base>[0]) => (new URL(req.url).pathname === "/api/reading/imported" && ++page === 2 ? Promise.resolve({ status: 429, headers: { "retry-after": "120" }, text: "{}" }) : base(req));
    const address = studioAddress({ baseUrl: SCALE_HOST, mount: "" });
    if (!address) throw new Error("address");
    const c = createStudioClient({ http: createStudioHttp({ transport: flaky, timers: idleTimers, address }), token: SCALE_TOKEN });
    const got = await c.listReading(READER_PAGES, (soFar) => seen.push(soFar.length), { pageSize: READER_PAGE });
    expect(got).toMatchObject({ kind: "error", status: 429 });
    expect(seen).toEqual([100]); // page 1 reached the progress listener, so the list on screen is not blanked
  });

  it("three 429s in a row end in the same 429 sentence, after waiting twice", async () => {
    const studio = new ScaleStudio(500, 200);
    studio.faults.push({ match: /GET \/api\/reading\/imported/, answer: { status: 429, headers: { "retry-after": "1" }, text: "{}" }, times: 3 });
    const waits: number[] = [];
    const got = await client(studio, timersRecording(waits)).listReading(READER_PAGES, undefined, { pageSize: READER_PAGE });
    expect(got).toMatchObject({ kind: "error", status: 429 });
    expect(waits).toEqual([1000, 1000]);
  });
});

describe("a 409 cursor-expired in the middle of a walk", () => {
  it("restarts from page 1 once, never appending to the old prefix", async () => {
    const studio = new ScaleStudio(500, 200);
    let n = 0;
    const base = studio.transport;
    const address = studioAddress({ baseUrl: SCALE_HOST, mount: "" });
    if (!address) throw new Error("address");
    const bumping = (req: Parameters<typeof base>[0]) => {
      if (new URL(req.url).pathname === "/api/reading/imported" && ++n === 2) studio.bump(); // between page 1 and page 2
      return base(req);
    };
    const c = createStudioClient({ http: createStudioHttp({ transport: bumping, timers: idleTimers, address }), token: SCALE_TOKEN });
    const got = await c.listReading(3, undefined, { pageSize: READER_PAGE });
    expect(got.kind).toBe("ok");
    const posts = got.kind === "ok" ? got.value.posts : [];
    expect(posts).toHaveLength(300);
    expect(new Set(posts.map(keyOf)).size).toBe(300); // no row twice: the first prefix was dropped
    expect(studio.requests.map((r) => r.status)).toEqual([200, 409, 200, 200, 200]);
  });

  it("a second expiry is reported, not retried for ever", async () => {
    const studio = new ScaleStudio(500, 200);
    const base = studio.transport;
    const address = studioAddress({ baseUrl: SCALE_HOST, mount: "" });
    if (!address) throw new Error("address");
    let n = 0;
    const always = (req: Parameters<typeof base>[0]) => {
      if (new URL(req.url).pathname === "/api/reading/imported" && n++ % 2 === 1) studio.bump();
      return base(req);
    };
    const c = createStudioClient({ http: createStudioHttp({ transport: always, timers: idleTimers, address }), token: SCALE_TOKEN });
    const got = await c.listReading(3, undefined, { pageSize: READER_PAGE });
    expect(got).toMatchObject({ kind: "error", status: 409 });
    expect(studio.requests.length).toBeLessThanOrEqual(8);
  });
});
