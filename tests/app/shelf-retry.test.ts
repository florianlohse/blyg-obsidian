// SH1 follow-up: a save that fails for want of a connection leaves the button usable (it returns to Save, with one line saying so), and tapping again tries again.
import { describe, expect, it } from "vitest";
import { createShelf } from "../../src/app/shelfService";
import type { ShelfFacade } from "../../src/app/shelfService";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import type { ReadingPost } from "../../src/studio/reading";
import { ShelfControl } from "../../src/ui/readerShelf";
import { idleTimers } from "../helpers";
import { FAR_FUTURE, FakeStudio, makeToken, STUDIO_HOST } from "../studio/fake-studio";

const TOKEN = makeToken({ expSeconds: FAR_FUTURE, scope: "owner:read owner:draft owner:publish owner:manage" });
const post = (remoteId: string): ReadingPost => ({ subscriptionId: "sub1", subscriptionTitle: "B", origin: null, remoteId, kind: "fragment", withdrawn: false, version: 1, readVersion: 1, observedAt: "", created: null, isReply: false, contentHtml: "", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null });
const after = (ms: number, fn: () => void) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};
const LOST_SAVE = "Could not save, no connection. Tap Save to try again.";

function setup(timeoutMs?: number) {
  const studio = new FakeStudio();
  studio.contractVersion = "6.2.0";
  studio.token = TOKEN;
  for (const id of ["a", "b"]) studio.importItem({ remote_id: id, content_md: `Post ${id}.` });
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: TOKEN });
  const shelf = createShelf({ build: () => ({ ok: true, studio: { client }, token: TOKEN }), enabled: () => true, after, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  return { studio, shelf };
}
const parent = () => {
  const made: Array<{ text: string; disabled?: boolean; cls?: string; run: () => void }> = [];
  const make = (_p: HTMLElement, text: string, run: () => void, o: { disabled?: boolean; cls?: string }) => (made.push({ text, run, ...o }), {} as HTMLButtonElement);
  return { made, make };
};

describe("a save that loses its connection", () => {
  it("answers with one line, changes nothing, and the next tap saves", async () => {
    const { studio, shelf } = setup();
    await shelf.opening();
    studio.forced.set("PUT /api/shelf", new Error("offline"));
    expect(await shelf.toggle(post("a"))).toEqual({ ok: false, message: LOST_SAVE });
    expect(shelf.has(post("a"))).toBe(false); // nothing is shown as saved that is not
    expect(await shelf.toggle(post("a"))).toEqual({ ok: true, saved: true }); // tapping again retries
    expect(studio.shelf.map((e) => e.remoteId)).toEqual(["a"]);
  });
  it("a request that never answers counts as lost after the time limit, and the next tap goes through", async () => {
    const { studio } = setup();
    const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
    if (!address) throw new Error("address");
    const real = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: TOKEN });
    let hang = true;
    const client = { ...real, putShelf: (...a: Parameters<typeof real.putShelf>) => (hang ? new Promise<never>(() => undefined) : real.putShelf(...a)) };
    const shelf = createShelf({ build: () => ({ ok: true, studio: { client }, token: TOKEN }), enabled: () => true, after, timeoutMs: 20 });
    await shelf.opening();
    expect(await shelf.toggle(post("a"))).toEqual({ ok: false, message: LOST_SAVE });
    hang = false;
    expect(await shelf.toggle(post("a"))).toEqual({ ok: true, saved: true });
  });
  it("when the shelf could not even be read, Save is still offered, and a tap reads again before it saves", async () => {
    const { studio, shelf } = setup();
    studio.forced.set("GET /api/shelf", new Error("offline"));
    shelf.reset();
    await shelf.opening();
    expect(shelf.ready()).toBe(false);
    expect(shelf.lost?.()).toBe(true);
    studio.forced.set("GET /api/shelf", new Error("still offline"));
    expect(await shelf.toggle(post("a"))).toEqual({ ok: false, message: LOST_SAVE }); // the read is tried again by the tap; no write is sent
    expect(studio.seen.filter((s) => s.method === "PUT" && s.path === "/api/shelf")).toHaveLength(0);
    expect(await shelf.toggle(post("a"))).toEqual({ ok: true, saved: true }); // the connection is back
    expect(shelf.ready() && shelf.lost?.()).toBe(false);
  });
});

describe("the Save button after a failure", () => {
  it("is back as Save (not Saving…, not disabled), says the line, and a second tap retries", async () => {
    const answers = [{ ok: false as const, message: LOST_SAVE }, { ok: true as const, saved: true }];
    let saved = false;
    const status: string[] = [];
    const facade = { on: () => true, ready: () => true, has: () => saved, count: () => 0, full: () => false, opening: () => Promise.resolve(), reset: () => undefined, saved: () => Promise.resolve([]), toggle: () => { const a = answers.shift() ?? { ok: false as const, message: "" }; if (a.ok) saved = true; return Promise.resolve(a); } } as ShelfFacade;
    const ui = new ShelfControl(() => facade, { status: (l) => void status.push(l), refresh: () => undefined, body: () => undefined, posts: () => [] });
    await ui.toggle(post("a"));
    expect(status.at(-1)).toBe(LOST_SAVE);
    const { made, make } = parent();
    ui.button({} as HTMLElement, post("a"), make);
    expect(made[0]).toMatchObject({ text: "Save", disabled: false });
    await ui.toggle(post("a"));
    expect(status.at(-1)).toBe("Saved for later.");
  });
  it("a toggle that throws or rejects still frees the button, with the same line", async () => {
    const facade = { on: () => true, ready: () => true, has: () => false, count: () => 0, full: () => false, opening: () => Promise.resolve(), reset: () => undefined, saved: () => Promise.resolve([]), toggle: () => Promise.reject(new Error("boom")) } as ShelfFacade;
    const status: string[] = [];
    const ui = new ShelfControl(() => facade, { status: (l) => void status.push(l), refresh: () => undefined, body: () => undefined, posts: () => [] });
    await ui.toggle(post("a"));
    expect(status.at(-1)).toBe(LOST_SAVE);
    const { made, make } = parent();
    ui.button({} as HTMLElement, post("a"), make);
    expect(made[0]).toMatchObject({ text: "Save", disabled: false });
  });
  it("keeps room for Save while the shelf is being read, and offers it when the read had no connection", () => {
    let state: "settling" | "lost" | "absent" = "settling";
    const facade = { on: () => true, ready: () => false, has: () => false, count: () => 0, full: () => false, opening: () => Promise.resolve(), reset: () => undefined, saved: () => Promise.resolve([]), toggle: () => Promise.resolve({ ok: true, saved: true }), settling: () => state === "settling", lost: () => state === "lost" } as unknown as ShelfFacade;
    const ui = new ShelfControl(() => facade, { status: () => undefined, refresh: () => undefined, body: () => undefined, posts: () => [] });
    for (const [s, expected] of [["settling", { disabled: true, cls: "blyg-reader-savebtn is-pending" }], ["lost", { disabled: false, cls: "blyg-reader-savebtn" }]] as const) {
      state = s;
      const { made, make } = parent();
      ui.button({} as HTMLElement, post("a"), make);
      expect(made[0]).toMatchObject(expected);
    }
    state = "absent";
    const { made, make } = parent();
    ui.button({} as HTMLElement, post("a"), make);
    expect(made).toHaveLength(0); // a Studio without a shelf: no button
  });
});
