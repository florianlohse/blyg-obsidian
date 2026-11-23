// DG8 part B (reader integration): the reader's mode in one place, a reader that asks the Studio for nothing when it is made to show a post, Next / Previous walking a story,
// and "In the digest: <section>" naming the heading the current post is really under. Fake DOM, fake clock, fake Studio; invented names only.
process.env.TZ = "Europe/Berlin";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FakeEl {
    cls = new Set<string>();
    text = "";
    children: FakeEl[] = [];
    handlers: Array<() => void> = [];
    scrollTop = 0;
    scrolled = 0;
    isConnected = true;
    attrs: Record<string, string> = {};
    constructor(public tag = "div") {}
    addClass(c: string) { this.cls.add(c); }
    toggleClass(c: string, on: boolean) { if (on) this.cls.add(c); else this.cls.delete(c); }
    setAttr(k: string, v: string) { this.attrs[k] = v; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    private make(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) {
      const el = new FakeEl(tag);
      if (o?.cls) o.cls.split(" ").forEach((c) => el.cls.add(c));
      if (o?.text) el.text = o.text;
      Object.assign(el.attrs, o?.attr ?? {});
      this.children.push(el);
      return el;
    }
    createDiv(o?: { cls?: string; text?: string }) { return this.make("div", o); }
    createSpan(o?: { cls?: string; text?: string }) { return this.make("span", o); }
    createEl(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.make(tag, o); }
    addEventListener(t: string, fn: () => void) { if (!/^(touch|context)/.test(t)) this.handlers.push(fn); } // the quick menu's touch and context handlers are not clicks
    click() { this.handlers.forEach((h) => h()); }
    empty() { this.children = []; }
    appendText(t: string) { const n = new FakeEl("#text"); n.text = t; this.children.push(n); }
    scrollIntoView() { this.scrolled++; }
    all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  }
  class ItemView {
    contentEl = new FakeEl();
    constructor(public leaf: unknown) {}
  }
  return { ItemView, setIcon: () => undefined };
});

import { digestAvailable, drawModeToggle, DIGEST_VIEW, FEED_VIEW, readerMode, reopenInLastMode, setReaderMode, switchMode, useReaderMode, type ReaderMode } from "../../src/ui/readerMode";
import { forgetSession, noteListLoaded, startReader, type Saved, type StartPorts } from "../../src/ui/readerStart";
import { stepCount, StoryWalk } from "../../src/ui/readerSteps";
import { placedSection, publishPlacement } from "../../src/digest/placement";
import { sectionOfPost } from "../../src/digest/postSection";
import { drawDigestChip, setDigestChips } from "../../src/ui/readerDigestChip";
import { clearScrolls, requestJump } from "../../src/digest/scrollMemory";
import { migrateSettings } from "../../src/settings/migrate";
import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import type { Written } from "../../src/digest/llm";
import type { EditionRec } from "../../src/digest/edition";
import type { ReadingPost } from "../../src/studio/reading";

const NOW = Date.parse("2030-03-10T12:00:00Z");
let n = 0;
const post = (text: string, author: string | null, over: Partial<ReadingPost> = {}): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: `b${String(++n).padStart(6, "0")}`.padEnd(26, "x"), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000 - n * 1000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: `<p>${text}</p>`, contentMd: "", authorName: author, authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; cls: Set<string>; scrolled: number; click(): void; all(): El[]; children: El[] };
const has = (e: El, c: string): boolean => e.cls.has(c);
const textOf = (e: El): string => e.text + e.children.map(textOf).join("");

let saved: ReaderMode = "feed";
const store = { get: () => saved, set: (m: ReaderMode) => void (saved = m) };
beforeEach(() => {
  saved = "feed";
  useReaderMode(store);
  forgetSession();
  clearScrolls();
  publishPlacement(undefined, null);
  vi.stubGlobal("window", { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) });
});
afterEach(() => {
  useReaderMode(null);
  vi.useRealTimers();
});

describe("the reader's mode", () => {
  it("is one value, kept in the store, and only exists while the Daily is on", () => {
    expect(readerMode()).toBe("feed");
    setReaderMode("digest");
    expect(saved).toBe("digest");
    expect(readerMode()).toBe("digest");
    useReaderMode(store); // the plugin starts again: the reader comes up in the mode it was left in
    expect(readerMode()).toBe("digest");
    useReaderMode(null);
    expect(digestAvailable()).toBe(false);
    expect(readerMode()).toBe("feed"); // the Daily is off: only the Feed
  });
  it("draws two small tabs, the current one pressed and inert, the other one switching", () => {
    const host = new (BlygDailyView as unknown as new (l: unknown, h: unknown) => { contentEl: El })({}, {}).contentEl;
    const picked: ReaderMode[] = [];
    drawModeToggle(host as never, "feed", (m) => picked.push(m));
    const btns = host.all().filter((e) => has(e, "blyg-modebtn"));
    expect(btns.map((b) => b.text)).toEqual(["Feed", "Digest"]);
    expect(has(btns[0]!, "is-active")).toBe(true);
    btns[0]!.click();
    btns[1]!.click();
    expect(picked).toEqual(["digest"]);
    useReaderMode(null);
    const none = new (BlygDailyView as unknown as new (l: unknown, h: unknown) => { contentEl: El })({}, {}).contentEl;
    expect(drawModeToggle(none as never, "feed", () => undefined)).toBeNull();
  });
  it("switchMode records the mode and shows that list in the leaf; Open reader reopens the Digest when that was the last mode", async () => {
    const shown: unknown[] = [];
    const leaf = { setViewState: (s: unknown) => (shown.push(s), Promise.resolve()) };
    switchMode(leaf, "digest");
    expect(saved).toBe("digest");
    expect(shown).toEqual([{ type: DIGEST_VIEW, active: true }]);
    const opened = vi.fn(() => Promise.resolve());
    useReaderMode(store, opened);
    expect(await reopenInLastMode()).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    setReaderMode("feed");
    expect(await reopenInLastMode()).toBe(false);
  });
  it("the two view types are the ones the views register", () => {
    expect(readFileSync("src/ui/ReaderView.ts", "utf8")).toContain(`export const BLYG_READER_VIEW = "${FEED_VIEW}"`);
    expect(readFileSync("src/ui/DigestView.ts", "utf8")).toContain(`export const BLYG_DAILY_VIEW = "${DIGEST_VIEW}"`);
  });
  it("the setting is read back and anything but the Digest is the Feed", () => {
    const base = { schemaVersion: 3 } as Record<string, unknown>;
    expect(migrateSettings({ ...base, readerPane: { mode: "digest" } }).settings.readerPane.mode).toBe("digest");
    expect(migrateSettings({ ...base, readerPane: { mode: "x" } }).settings.readerPane.mode).toBeUndefined();
  });
});

describe("a reader that asks the Studio for nothing when it is made to show a post", () => {
  /** A fake Studio: every request is counted; the ports are what the reader view gives startReader. */
  const world = (forPost: boolean, cache: Saved | null) => {
    const calls: string[] = [];
    let data = false;
    const ports: StartPorts = {
      alive: () => true,
      forPost: () => forPost,
      hasData: () => data,
      readCache: () => Promise.resolve(cache),
      showSaved: () => void (data = true),
      walk: () => (calls.push("walk"), Promise.resolve(void noteListLoaded())),
      load: () => {
        calls.push("load");
        data = true;
        noteListLoaded();
        return Promise.resolve();
      },
      mine: (ask) => void (ask && calls.push("mine")),
      failed: () => calls.push("failed"),
    };
    return { calls, ports };
  };
  const cache: Saved = { posts: [], mentions: [], savedAt: 1, studioOrigin: "https://studio.example.com" };

  it("open a post from the digest, go Back, wait: zero requests", async () => {
    vi.useFakeTimers();
    const w = world(true, cache); // the digest made the reader to show a post
    await startReader(w.ports);
    vi.advanceTimersByTime(30 * 60_000); // half an hour on the fake clock
    await startReader(world(true, cache).ports); // and again (a second post, Back, a third)
    expect(w.calls).toEqual([]);
  });
  it("the first time the reader opens from nothing it reads once, behind the saved list; later it does not", async () => {
    const first = world(false, cache);
    await startReader(first.ports);
    expect(first.calls).toEqual(["mine", "walk"]);
    const second = world(false, cache); // the Feed again after a visit to the Digest
    await startReader(second.ports);
    expect(second.calls).toEqual([]);
  });
  it("a reader made again starts from the list the last one held, even when the file keeps none (an empty feed)", async () => {
    noteListLoaded({ posts: [], mentions: [], savedAt: 5, studioOrigin: "https://studio.example.com" });
    const w = world(false, null);
    await startReader(w.ports);
    expect(w.calls).toEqual([]);
  });
  it("with nothing saved a post still needs a list: one load", async () => {
    const w = world(true, null);
    await startReader(w.ports);
    expect(w.calls).toEqual(["load"]);
  });
  it("the view source holds no other automatic request (no timer, no focus or visibility hook calls the Studio)", () => {
    const src = readFileSync("src/ui/ReaderView.ts", "utf8");
    expect(src).not.toMatch(/visibilitychange|active-leaf-change|onLayoutReady\([^)]*checkForNew/);
    expect(src).toMatch(/this\.loadMine\("cached"\)/); // opening a post reads nothing of its own
    expect(src).not.toMatch(/setTimeout\(\(\) => \(this\.mineAsked = false\)/); // the 5-minute re-ask is gone
  });
});

describe("Next and Previous in a story", () => {
  const ps = [post("one", "Ann"), post("two", "Bo"), post("three", "Cy"), post("four", "Di")];
  it("walk the posts of that story in the order given, with a counter naming it", () => {
    const w = new StoryWalk();
    w.set({ title: "Harbour lights", posts: ps });
    const at = w.where(ps[1]!);
    expect(at).toMatchObject({ at: 1, story: "Harbour lights" });
    expect(at!.keys).toHaveLength(4);
    expect(w.post(at!.keys[2]!)).toBe(ps[2]);
    const host = new (BlygDailyView as unknown as new (l: unknown, h: unknown) => { contentEl: El })({}, {}).contentEl;
    stepCount(host as never, at!);
    expect(textOf(host)).toBe("Story: Harbour lights · 2 of 4");
    w.clear();
    expect(w.where(ps[1]!)).toBeNull(); // from a single post or the feed: the feed's order, as before
  });
  it("a post that is not in the story, or a story of one, has no walk", () => {
    const w = new StoryWalk();
    w.set({ title: "Alone", posts: [ps[0]!] });
    expect(w.where(ps[0]!)).toBeNull();
    w.set({ title: "Two", posts: [ps[0]!, ps[1]!] });
    expect(w.where(ps[2]!)).toBeNull();
  });
});

describe("the digest chip names the heading the current post is under", () => {
  const rec = (over: Partial<EditionRec>): EditionRec => ({ id: 9, createdAt: 1, n: 1, stories: [], mixed: [], seen: {}, ...over });
  const mk = (postId: string): ReadingPost => post("x", "Ann", { remoteId: postId });
  it("a post in section A and another in B give their own sections, one after the other", async () => {
    const current = rec({ sections: ["A", "B"], stories: [{ id: "s1", posts: ["pa"], section: "A" }, { id: "s2", posts: ["pb"], section: "B" }] as never });
    const seen: string[] = [];
    setDigestChips({ sectionOf: (p) => Promise.resolve(sectionOfPost(p.remoteId, current, [])), open: () => undefined });
    const line = (): El => {
      const l = new (BlygDailyView as unknown as new (l: unknown, h: unknown) => { contentEl: El })({}, {}).contentEl;
      return l;
    };
    for (const id of ["pa", "pb", "pa"]) {
      const l = line();
      drawDigestChip(l as never, mk(id));
      await Promise.resolve();
      await Promise.resolve();
      seen.push(l.all().find((e) => has(e, "blyg-reader-digestchip"))?.text ?? "none");
    }
    expect(seen).toEqual(["In the digest: A", "In the digest: B", "In the digest: A"]);
    setDigestChips(null);
  });
  it("a story the record gives no section is under Other (the page draws it there), not under an older edition's section", () => {
    const current = rec({ sections: ["A"], stories: [{ id: "s1", posts: ["pa"] }] as never });
    const past = [{ id: 3, at: 3, stories: [], singles: [], who: {}, sections: [{ name: "Old", stories: [], posts: ["pa"] }] }] as never;
    expect(sectionOfPost("pa", current, past)).toEqual({ edition: 9, section: "Other" });
  });
  it("the page publishes where it drew each post: the lead block is Front page, not its section", async () => {
    const stories = ["alpha", "beta", "gamma", "delta"].map((t, i) => {
      const a = post(`Wholly distinct ${t} subject only here ${i}.`, "Ann");
      return [a, post(`Reply ${t}.`, "Bo", { isReply: true, stubTarget: { id: a.remoteId } as never })];
    });
    const lone = post("A lone post nobody answers.", "Cy");
    const posts = [...stories.flat(), lone];
    const ai: DigestHost["ai"] = {
      enabled: () => true,
      cached: async (c) => c.map((_, i): Written => ({ headline: `Story ${i}`, summary: `Summary ${i}.`, model: "m", posts: 2 })),
      cachedSections: async (_c, singles) => [{ name: "Garden", ids: [2, 3], posts: [singles[0]!.remoteId] }, { name: "Town", ids: [0, 1] }],
      write: async () => ({ written: [], status: "ok" }),
    };
    const host: DigestHost = { loadList: () => Promise.resolve({ posts, mentions: [], savedAt: NOW }), edition: () => Promise.resolve({ id: 9, since: NOW - 6 * 3600_000, until: NOW }), ai, font: () => "serif", showFeed: () => Promise.resolve(), openPost: () => Promise.resolve(), openWeb: () => undefined };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    const where = (id: string): string | undefined => placedSection(id, 9)?.section;
    const names = new Set(posts.map((p) => where(p.remoteId)));
    expect(names.has("Front page")).toBe(true); // the biggest stories are the lead block
    expect(where(lone.remoteId)).toBe("Garden");
    expect(placedSection(lone.remoteId, 8)).toBeNull(); // another edition: no claim
    // and a tap on the chip scrolls that edition's page to that section
    requestJump(9, "Garden");
    const again = new BlygDailyView({} as never, host);
    await again.onOpen();
    const boxes = (again as unknown as { sectionEls: Map<string, El> }).sectionEls;
    expect(boxes.get("Garden")?.scrolled).toBeGreaterThan(0);
    expect(boxes.get("Town")?.scrolled ?? 0).toBe(0);
  });
});

describe("opening a post from a story", () => {
  it("hands the reader the story's posts in the unfolded order and its title; a single post hands none", async () => {
    const a = post("Shared topic about gardens and tomatoes in spring, quite long.", "Ann");
    const b = post("Reply about tomatoes.", "Bo", { isReply: true, stubTarget: { id: a.remoteId } as never });
    const lone = post("A lone post nobody answers.", "Cy");
    const given: Array<{ id: string; story?: { title: string; posts: readonly ReadingPost[] } }> = [];
    const host: DigestHost = {
      loadList: () => Promise.resolve({ posts: [a, b, lone], mentions: [], savedAt: NOW }),
      edition: () => Promise.resolve({ id: 7, since: NOW - 6 * 3600_000, until: NOW }),
      font: () => "serif",
      showFeed: () => Promise.resolve(),
      openPost: (p, _l, story) => Promise.resolve(void given.push({ id: p.remoteId, ...(story ? { story } : {}) })),
      openWeb: () => undefined,
    };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    expect(readerMode()).toBe("digest"); // the Daily is shown: the mode is the Digest
    const root = (view as unknown as { contentEl: El }).contentEl;
    root.all().find((e) => has(e, "blyg-daily-headline"))?.click();
    root.all().filter((e) => has(e, "blyg-daily-member"))[1]!.click(); // the whole row, the second post
    root.all().find((e) => has(e, "blyg-story-line"))?.click(); // the single post
    expect(given[0]?.id).toBe(b.remoteId);
    expect(given[0]?.story?.posts.map((p) => p.remoteId)).toEqual([a.remoteId, b.remoteId]);
    expect(given[0]?.story?.title).toBeTruthy();
    expect(given[1]).toEqual({ id: lone.remoteId });
    // the masthead has the small Feed | Digest switch, not a row of buttons
    expect(root.all().filter((e) => has(e, "blyg-modebtn")).map((e) => e.text)).toEqual(["Feed", "Digest"]);
    expect(root.all().some((e) => e.tag === "button" && e.text === "Feed")).toBe(true);
  });
});
