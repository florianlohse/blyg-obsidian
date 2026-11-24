// SH1: the reader's side of Save for later (src/ui/readerShelf.ts): what a tap does, when nothing is drawn, and the Saved view. The shelf itself is a fake here
// (tests/studio/shelf.test.ts covers the Studio conversation); the screen is a recorder.
import { describe, expect, it } from "vitest";
import type { ShelfFacade, ShelfResult } from "../src/app/shelfService";
import type { ReadingPost } from "../src/studio/reading";
import { ShelfControl } from "../src/ui/readerShelf";

const post = (remoteId: string, over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s", subscriptionTitle: "T", origin: null, remoteId, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });

function fakeShelf(over: Partial<Omit<ShelfFacade, "saved">> & { saved?: Set<string>; list?: ReadingPost[] | null; answer?: ShelfResult } = {}) {
  const { saved: savedIds, list, answer, ...facadeOver } = over;
  const saved = savedIds ?? new Set<string>();
  const calls: string[] = [];
  const facade: ShelfFacade = {
    on: () => true,
    ready: () => true,
    has: (p) => saved.has(p.remoteId),
    count: () => saved.size,
    full: () => saved.size >= 50,
    opening: () => { calls.push("opening"); return Promise.resolve(); },
    reset: () => void calls.push("reset"),
    toggle: (p) => {
      calls.push(`toggle ${p.remoteId}`);
      if (answer) return Promise.resolve(answer);
      const was = saved.has(p.remoteId);
      if (was) saved.delete(p.remoteId); else saved.add(p.remoteId);
      return Promise.resolve({ ok: true, saved: !was });
    },
    saved: () => { calls.push("saved"); return Promise.resolve(list === undefined ? [] : list); },
    ...facadeOver,
  };
  return { facade, saved, calls };
}
function screenOf(posts: ReadingPost[]) {
  const log: string[] = [];
  return { log, screen: { status: (l: string) => void log.push(`status:${l}`), refresh: (p: ReadingPost) => void log.push(`refresh:${p.remoteId}`), body: () => void log.push("body"), posts: () => posts } };
}
/** A parent that records what is drawn into it (only what the controller uses). */
const parentOf = () => {
  const made: Array<{ cls?: string; text?: string }> = [];
  return { made, el: { createSpan: (o: { cls?: string; text?: string }) => void made.push(o) } as unknown as HTMLElement };
};

describe("Save for later in the reader", () => {
  it("a tap saves (shown as 'Saving…' while it is on its way), says so, and draws the post again", async () => {
    const { facade, saved } = fakeShelf();
    const { log, screen } = screenOf([post("a")]);
    const ui = new ShelfControl(() => facade, screen);
    const done = ui.toggle(post("a"));
    expect(log[0]).toBe("refresh:a"); // the button reads "Saving…" now
    await done;
    expect(saved.has("a")).toBe(true);
    expect(log).toContain("status:Saved for later.");
    expect(log.at(-1)).toBe("refresh:a");
  });
  it("a refusal is said in the status line and nothing is shown as saved", async () => {
    const { facade, saved } = fakeShelf({ answer: { ok: false, message: "Your shelf is full (50 posts). Remove one from Saved first; nothing was dropped." } });
    const { log, screen } = screenOf([post("a")]);
    await new ShelfControl(() => facade, screen).toggle(post("a"));
    expect(saved.size).toBe(0);
    expect(log).toContain("status:Your shelf is full (50 posts). Remove one from Saved first; nothing was dropped.");
  });
  it("a second tap on the same post while the first is on its way is ignored", async () => {
    const { facade, calls } = fakeShelf();
    const ui = new ShelfControl(() => facade, screenOf([]).screen);
    await Promise.all([ui.toggle(post("a")), ui.toggle(post("a"))]);
    expect(calls.filter((c) => c.startsWith("toggle"))).toEqual(["toggle a"]);
  });
  it("the saved mark is drawn for a saved post only, and nothing at all while the shelf is off or not read", () => {
    const on = fakeShelf({ saved: new Set(["a"]) }).facade;
    const ui = new ShelfControl(() => on, screenOf([]).screen);
    const yes = parentOf();
    ui.mark(yes.el, post("a"));
    expect(yes.made).toEqual([expect.objectContaining({ cls: "blyg-reader-savedmark", text: "saved" })]);
    const no = parentOf();
    ui.mark(no.el, post("b"));
    expect(no.made).toEqual([]);
    for (const off of [undefined, fakeShelf({ ready: () => false, saved: new Set(["a"]) }).facade]) {
      const p = parentOf();
      new ShelfControl(() => off, screenOf([]).screen).mark(p.el, post("a"));
      expect(p.made).toEqual([]);
    }
  });
  it("the Save button: 'Save', 'Saved', disabled with the reason on a full shelf, absent for posts that cannot be saved or when there is no shelf", () => {
    const draw = (facade: ShelfFacade | undefined, p: ReadingPost) => {
      const out: Array<{ text: string; opts: { disabled?: boolean; title?: string; cls?: string } }> = [];
      new ShelfControl(() => facade, screenOf([]).screen).button({} as HTMLElement, p, (_parent, text, _run, opts) => { out.push({ text, opts }); return {} as HTMLButtonElement; });
      return out;
    };
    const { facade } = fakeShelf({ saved: new Set(["a"]) });
    expect(draw(facade, post("b")).map((b) => b.text)).toEqual(["Save"]);
    const savedButton = draw(facade, post("a"));
    expect(savedButton.map((b) => b.text)).toEqual(["Saved"]);
    expect(savedButton[0]?.opts.cls).toContain("is-saved");
    const full = fakeShelf({ full: () => true, saved: new Set(["a"]) }).facade;
    const fullButton = draw(full, post("b"))[0];
    expect(fullButton?.opts.disabled).toBe(true);
    expect(fullButton?.opts.title).toMatch(/shelf is full \(50 posts\)/);
    expect(draw(full, post("a"))[0]?.opts.disabled).toBe(false); // a saved post can always be taken off
    expect(draw(facade, post("x", { subscriptionId: "" }))).toEqual([]);
    expect(draw(facade, post("w", { withdrawn: true }))).toEqual([]);
    expect(draw(undefined, post("b"))).toEqual([]);
    expect(draw(fakeShelf({ ready: () => false }).facade, post("b"))).toEqual([]);
  });
  it("the long-press entry follows the shelf live and is absent until the shelf has been read", () => {
    const state = fakeShelf({ saved: new Set(["a"]) });
    const ui = new ShelfControl(() => state.facade, screenOf([]).screen);
    expect(ui.actions(post("a")).state()).toEqual({ saved: true, full: false });
    expect(ui.actions(post("b")).state()).toEqual({ saved: false, full: false });
    expect(new ShelfControl(() => fakeShelf({ ready: () => false }).facade, screenOf([]).screen).actions(post("a")).state()).toBeNull();
  });
  it("a reader opening resets the shelf and reads it once; with the feature off it asks nothing", async () => {
    const on = fakeShelf();
    new ShelfControl(() => on.facade, screenOf([post("a")]).screen).opening();
    expect(on.calls).toEqual(["reset", "opening"]);
    const off = fakeShelf({ on: () => false });
    new ShelfControl(() => off.facade, screenOf([]).screen).opening();
    expect(off.calls).toEqual([]);
  });

  it("the Saved view: the loaded saved posts at once, then the shelf's own list (older posts included) in shelf order; leaving it shows everything", async () => {
    const loaded = [post("a"), post("b"), post("c")];
    const { facade, calls } = fakeShelf({ saved: new Set(["b", "z"]), list: [post("z"), post("b", { subscriptionTitle: "lean copy" })] });
    const { log, screen } = screenOf(loaded);
    const ui = new ShelfControl(() => facade, screen);
    const shown = ui.show(true);
    expect(ui.view?.map((p) => p.remoteId)).toEqual(["b"]); // instant, from the cache, no request
    await shown;
    expect(calls).toEqual(["saved"]); // one read
    expect(ui.view?.map((p) => p.remoteId)).toEqual(["z", "b"]);
    expect(ui.view?.[1]).toBe(loaded[1]); // the loaded post (richer) is kept over the shelf's lean row
    await ui.show(false);
    expect(ui.view).toBeNull();
    expect(log.filter((l) => l === "body").length).toBe(3);
  });
  it("the Saved view when the list cannot be read: the loaded saved posts stay, and it says so", async () => {
    const { facade } = fakeShelf({ saved: new Set(["a"]), list: null });
    const { log, screen } = screenOf([post("a"), post("b")]);
    const ui = new ShelfControl(() => facade, screen);
    await ui.show(true);
    expect(ui.view?.map((p) => p.remoteId)).toEqual(["a"]);
    expect(log.some((l) => /saved list could not be read/.test(l))).toBe(true);
  });
  it("taking a post off while the Saved view is open removes it from the view; the shelf is never refilled from the view", async () => {
    const { facade, saved } = fakeShelf({ saved: new Set(["a", "b"]), list: [post("a"), post("b")] });
    const ui = new ShelfControl(() => facade, screenOf([post("a"), post("b")]).screen);
    await ui.show(true);
    await ui.toggle(post("a"));
    expect(ui.view?.map((p) => p.remoteId)).toEqual(["b"]);
    expect([...saved]).toEqual(["b"]);
  });
});
