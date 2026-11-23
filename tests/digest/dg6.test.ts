// DG6 (digest v2): order, scroll memory, the summary as a link, the reader's chip, bylines, lines for single posts, reading time, the table of contents, overflow CSS, no automatic check.
// Fake transport and a fake DOM; invented names only.
process.env.TZ = "Europe/Berlin";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    addEventListener(_t: string, fn: () => void) { this.handlers.push(fn); }
    click() { this.handlers.forEach((h) => h()); }
    empty() { this.children = []; }
    scrollIntoView() { this.scrolled++; }
    all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  }
  class ItemView {
    contentEl = new FakeEl();
    constructor(public leaf: unknown) {}
  }
  return { ItemView, setIcon: (el: { attrs?: Record<string, string> }, n: string) => void (el.attrs ??= {}, el.attrs["data-icon"] = n) };
});

import { clusterPosts, postTime, type Cluster } from "../../src/digest/cluster";
import { emptyStore, writeDigest, type LlmDeps, type LlmStore, type Written } from "../../src/digest/llm";
import { Editions, rememberWrite } from "../../src/digest/editionHost";
import { parseEditions } from "../../src/digest/edition";
import { buildPast, parseHistory, type PastEdition } from "../../src/digest/history";
import { byNewestPost, drawnSections } from "../../src/digest/order";
import { sectionOfPost } from "../../src/digest/postSection";
import { clearScrolls, recalledScroll, rememberScroll, requestJump, scrollKey, takeJump } from "../../src/digest/scrollMemory";
import { existingSections, recordSections } from "../../src/digest/sectionRecord";
import { buildSectionsRequest, MAX_ABOUT_CHARS, MAX_LINE_CHARS, parseSectionsCache, plainAbout, plainLine, readPlacement, SECTIONS_PROMPT_VERSION } from "../../src/digest/sections";
import { groupOf } from "../../src/digest/stable";
import { GROUPING_NOTE } from "../../src/digest/layout";
import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import { drawToc, TOC_OPEN_MAX } from "../../src/ui/DigestToc";
import { drawDigestChip, setDigestChips } from "../../src/ui/readerDigestChip";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import type { ReadingPost } from "../../src/studio/reading";

const NOW = Date.parse("2030-03-10T12:00:00Z");
const KEY = "sk-test-0123456789abcdefghijklmnop";
let n = 0;
const post = (text: string, author: string | null, over: Partial<ReadingPost> = {}): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: `dg${String(++n).padStart(6, "0")}`.padEnd(26, "x"), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: `<p>${text}</p>`, contentMd: "", authorName: author, authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; cls: Set<string>; attrs: Record<string, string>; scrollTop: number; scrolled: number; click(): void; all(): El[] };
const cls = (e: El, c: string): boolean => e.cls.has(c);
const tocLink = (all: El[], name: string): El | undefined => all.find((e) => cls(e, "blyg-toc-link") && e.all().some((c) => cls(c, "blyg-toc-name") && c.text === name));

beforeEach(() => clearScrolls());

describe("the order of the page", () => {
  const mk = (text: string, mins: number, over: Partial<ReadingPost> = {}): ReadingPost => post(text, "Ann", { observedAt: new Date(NOW - mins * 60_000).toISOString(), ...over });
  it("stories in a section go by their NEWEST post, newest first, whatever order the numbers or the record have", () => {
    const pair = (text: string, a: number, b: number): Cluster[] => {
      const lead = mk(text, a);
      return clusterPosts([lead, mk(`Reply to ${text}`, b, { isReply: true, stubTarget: { id: lead.remoteId } as never })]);
    };
    const old = pair("Alpha quilt thread needle.", 600, 590);
    const mid = pair("Beta harbour tide lantern.", 300, 100); // first post old, last post newest of all
    const fresh = pair("Gamma orchard cider press.", 200, 150);
    const front = [...old, ...mid, ...fresh]; // positions 0, 1, 2
    const d = drawnSections([{ name: "S", ids: [0, 1, 2] }], front, new Map());
    expect(d[0]?.stories).toEqual([1, 2, 0]);
  });
  it("single posts go newest first; sections by their newest item, Other last", () => {
    const a = mk("single a", 500);
    const b = mk("single b", 10);
    const c = mk("single c", 200);
    const lead = mk("Delta kiln glaze recipe.", 400);
    const front = clusterPosts([lead, mk("Reply kiln.", 399, { isReply: true, stubTarget: { id: lead.remoteId } as never })]);
    const byId = new Map([a, b, c].map((p) => [p.remoteId, p]));
    const d = drawnSections([{ name: "Other", ids: [], posts: [b.remoteId] }, { name: "Old", ids: [0] }, { name: "Mixed up", ids: [], posts: [a.remoteId, c.remoteId] }], front, byId);
    expect(d.map((s) => s.name)).toEqual(["Mixed up", "Old", "Other"]); // newest item first (200 min, 399 min); Other last although it holds the newest post (10 min)
    expect(d.find((s) => s.name === "Mixed up")?.singles.map((p) => p.remoteId)).toEqual([c.remoteId, a.remoteId]);
    expect([a, b, c].sort(byNewestPost).map((p) => p.remoteId)).toEqual([b.remoteId, c.remoteId, a.remoteId]);
  });
  it("the time is a number, not text: a post 9 minutes ago is newer than one 10 minutes ago, and one 100 minutes ago is older", () => {
    const ps = [mk("x", 100), mk("y", 9), mk("z", 10)];
    expect(ps.sort(byNewestPost).map(postTime)).toEqual([NOW - 9 * 60_000, NOW - 10 * 60_000, NOW - 100 * 60_000]);
  });
  it("groupOf puts the biggest story first, then the newest, even when the record holds them in another order (a story that grew moves up)", () => {
    const small = [mk("Alpha quilt thread needle.", 30), mk("Reply quilt.", 29, { isReply: true })];
    const big = [mk("Beta harbour tide lantern.", 500), mk("R1 harbour.", 499, { isReply: true }), mk("R2 harbour.", 498, { isReply: true })];
    const rec = { id: 1, createdAt: 1, n: 3, stories: [{ id: "s1", posts: small.map((p) => p.remoteId) }, { id: "s2", posts: big.map((p) => p.remoteId) }], mixed: [], seen: {} };
    // (replies must name their lead so the posts form stories: the lead of each is the first post)
    const posts = [...small, ...big].map((p, i, all) => (p.isReply ? { ...p, stubTarget: { origin: "o", id: (i < 2 ? all[0] : all[2])!.remoteId } } : p));
    const g = groupOf(rec, posts);
    expect(g.clusters.map((c) => c.id)).toEqual(["s2", "s1"]);
  });
  it("the help text says the rule", () => {
    expect(GROUPING_NOTE.join(" ")).toMatch(/newest/);
  });
});

describe("where the digest was scrolled to", () => {
  const NOWL = NOW;
  const list = { posts: [post("A single post that is long enough to be a row.", "Ann")], mentions: [], savedAt: NOWL };
  async function mount(edition: number | undefined, ai?: DigestHost["ai"]) {
    const opened: string[] = [];
    const host: DigestHost = {
      loadList: () => Promise.resolve(list),
      edition: () => Promise.resolve({ ...(edition !== undefined ? { id: edition } : {}), since: NOWL - 6 * 3600_000, until: NOWL }),
      ...(ai ? { ai } : {}),
      font: () => "serif", showFeed: () => Promise.resolve(), openPost: (p) => Promise.resolve(void opened.push(p.remoteId)), openWeb: () => undefined,
    };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    return { view, root: (view as unknown as { contentEl: El }).contentEl, opened };
  }
  it("opening a post keeps the position; a new view of the same edition goes back to it (Back from the reader)", async () => {
    const a = await mount(5);
    a.root.scrollTop = 840;
    a.root.all().find((e) => cls(e, "blyg-story-who"))?.click();
    expect(a.opened).toHaveLength(1);
    expect(recalledScroll(scrollKey(5))).toBe(840);
    const b = await mount(5); // the leaf shows the digest again: a new view
    expect(b.root.scrollTop).toBe(840);
  });
  it("is kept per edition: another edition does not take it, and a re-draw keeps it", async () => {
    rememberScroll(scrollKey(5), 300);
    const other = await mount(6);
    expect(other.root.scrollTop).toBe(0);
    const same = await mount(5);
    expect(same.root.scrollTop).toBe(300);
    same.root.scrollTop = 410;
    (same.view as unknown as { render(m: unknown): void }).render(null); // a redraw (after a write finished, a switch)
    await (same.view as unknown as { refresh(): Promise<void> }).refresh();
    expect(same.root.scrollTop).toBe(410);
  });
  it("a jump request (the reader's chip) is taken once, and scrolls to the section", async () => {
    requestJump(5, "Garden");
    expect(takeJump()).toEqual({ edition: 5, section: "Garden" });
    expect(takeJump()).toBeNull();
  });
});

describe("the summary of a story", () => {
  it("does what the headline does: opens the story's posts, from which a post opens in the reader", async () => {
    const a = post("Shared topic about gardens and tomatoes in spring.", "Ann");
    const b = post("My tomatoes did badly this spring, sadly.", "Bo", { isReply: true, stubTarget: { id: a.remoteId } as never });
    const opened: string[] = [];
    const ai: DigestHost["ai"] = { enabled: () => true, cached: async () => [{ headline: "Gardens", summary: "Tomatoes struggled.", model: "m", posts: 2 }], write: async () => ({ written: [], status: "ok" }) };
    const host: DigestHost = { loadList: () => Promise.resolve({ posts: [a, b], mentions: [], savedAt: NOW }), edition: () => Promise.resolve({ since: NOW - 6 * 3600_000, until: NOW }), ai, font: () => "serif", showFeed: () => Promise.resolve(), openPost: (p) => Promise.resolve(void opened.push(p.remoteId)), openWeb: () => undefined };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    const root = (view as unknown as { contentEl: El }).contentEl;
    const summary = root.all().find((e) => cls(e, "blyg-story-summary"));
    expect(summary?.tag).toBe("button");
    expect(root.all().some((e) => e.text === "Bo (reply)")).toBe(false);
    summary?.click();
    root.all().find((e) => e.text === "Bo (reply)")?.click();
    expect(opened).toEqual([b.remoteId]);
  });
});

describe("the reader's chip: In the digest", () => {
  const story = (id: string, posts: string[], section?: string) => ({ id, posts, ...(section ? { section } : {}) });
  const rec = { id: 20, createdAt: 1, n: 3, stories: [story("s1", ["p1", "p2"], "Garden"), story("s2", ["p3", "p4"])], mixed: ["p5", "p6"], postSections: { p5: "Town" }, seen: {} };
  const past = (id: number, over: Partial<PastEdition> = {}): PastEdition => ({ id, at: id, stories: [{ headline: "h", summary: "", posts: ["q1", "q2"] }], singles: ["q3"], sections: [{ name: "Sport", stories: [0], posts: ["q3"] }], who: {}, ...over });
  it("finds the section of a story's post and of a single post in the current edition, then in the history, newest first", () => {
    expect(sectionOfPost("p2", rec, [])).toEqual({ edition: 20, section: "Garden" });
    expect(sectionOfPost("p5", rec, [])).toEqual({ edition: 20, section: "Town" });
    expect(sectionOfPost("p3", rec, [])).toBeNull(); // a story with no section yet
    expect(sectionOfPost("p6", rec, [])).toBeNull();
    expect(sectionOfPost("q2", rec, [past(10)])).toEqual({ edition: 10, section: "Sport" });
    expect(sectionOfPost("q3", rec, [past(10), past(12, { sections: [{ name: "Art", stories: [], posts: ["q3"] }] })])).toEqual({ edition: 12, section: "Art" });
    expect(sectionOfPost("nobody", rec, [past(10)])).toBeNull();
  });
  it("draws a chip that opens that edition at that section, only when there is one", async () => {
    const opened: Array<[number, string]> = [];
    setDigestChips({ sectionOf: async (p) => (p.remoteId === "x" ? { edition: 7, section: "Garden" } : null), open: (e, s) => opened.push([e, s]) });
    const line = new (await import("obsidian").then(() => class { cls = new Set(); children: unknown[] = []; isConnected = true; createSpan(o: { text: string }) { this.children.push(o); return this; } createEl(_t: string, o: { text: string }) { const a = { text: o.text, handlers: [] as Array<(e: { preventDefault(): void }) => void>, addEventListener(_n: string, f: (e: { preventDefault(): void }) => void) { a.handlers.push(f); } }; this.children.push(a); return a; } }))();
    drawDigestChip(line as never, post("t", "A", { remoteId: "none" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(line.children).toHaveLength(0);
    drawDigestChip(line as never, post("t", "A", { remoteId: "x" }));
    await new Promise((r) => setTimeout(r, 0));
    const chip = line.children.find((c) => (c as { text: string }).text === "In the digest: Garden") as { handlers: Array<(e: { preventDefault(): void }) => void> };
    expect(chip).toBeDefined();
    chip.handlers[0]?.({ preventDefault: () => undefined });
    expect(opened).toEqual([[7, "Garden"]]);
    setDigestChips(null);
  });
  it("a record that still holds the old name 'Front page' shows as 'Top stories' in the chip, and the tap still hands the stored name on (the record is not rewritten)", async () => {
    const opened: Array<[number, string]> = [];
    const stored = { edition: 4, section: "Front page" };
    setDigestChips({ sectionOf: async () => stored, open: (e, s) => opened.push([e, s]) });
    const line = new (await import("obsidian").then(() => class { cls = new Set(); children: unknown[] = []; isConnected = true; createSpan(o: { text: string }) { this.children.push(o); return this; } createEl(_t: string, o: { text: string }) { const c = { ...o, handlers: [] as unknown[], addEventListener(_e: string, f: unknown) { this.handlers.push(f); } }; this.children.push(c); return c; } }))();
    drawDigestChip(line as never, post("t", "A", { remoteId: "old" }));
    await new Promise((r) => setTimeout(r, 0));
    const chip = line.children.find((c) => (c as { text: string }).text === "In the digest: Top stories") as { handlers: Array<(e: { preventDefault(): void }) => void> };
    expect(chip).toBeDefined();
    expect(line.children.some((c) => (c as { text: string }).text.includes("Front page"))).toBe(false);
    chip.handlers[0]?.({ preventDefault: () => undefined });
    expect(opened).toEqual([[4, "Front page"]]); // the page maps it to its heading (sectionLabel); the stored name stays as it was
    expect(stored.section).toBe("Front page");
    setDigestChips(null);
  });
  it("the reader gains no lines: the chip's code is in its own module and ReaderView stays under its cap", () => {
    const caps = JSON.parse(readFileSync("scripts/size-caps.json", "utf8")) as Record<string, number>;
    expect(readFileSync("src/ui/ReaderView.ts", "utf8").split("\n").length - 1).toBeLessThanOrEqual(caps["src/ui/ReaderView.ts"] as number);
  });
});

describe("the AI's byline for a section and line for a single post", () => {
  it("reads a byline strictly: plain, at most 90 characters, no markup, no address", () => {
    expect(plainAbout("Prices, tariffs and the harbour market")).toBe("Prices, tariffs and the harbour market");
    expect(plainAbout("**Bold** and <b>tags</b> and [a link](https://evil.example.com)")).toBe("Bold and tags and a link");
    expect(plainAbout("See https://evil.example.com now")).toBe("");
    expect(plainAbout("x".repeat(300)).length).toBeLessThanOrEqual(MAX_ABOUT_CHARS);
    expect(plainAbout(42)).toBe("");
    expect(plainAbout(`${"word ".repeat(40)}`).length).toBeLessThanOrEqual(MAX_ABOUT_CHARS);
  });
  it("reads a line strictly: '<Author> on <topic>', author from the data, no quotes, at most 80 characters", () => {
    expect(plainLine("Ann on lake swimming in autumn", "Ann")).toBe("Ann on lake swimming in autumn");
    expect(plainLine('Ann on "quoted" topic', "Ann")).toBe("Ann on quoted topic");
    expect(plainLine("Mallory on lake swimming", "Ann")).toBe(""); // a name that is not in the data
    expect(plainLine("Ann says lake swimming", "Ann")).toBe(""); // not the shape
    expect(plainLine("Ann on", "Ann")).toBe("");
    expect(plainLine("Ann on https://evil.example.com", "Ann")).toBe("");
    expect(plainLine(`Ann on ${"long ".repeat(40)}`, "Ann").length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(plainLine("<b>Ann</b> on tea", "Ann")).toBe("Ann on tea");
    expect(plainLine("Ann on tea", "")).toBe("");
  });
  it("readPlacement keeps bylines and lines (numbers alone still work), validated per post's author, a bad line is just dropped", () => {
    const text = JSON.stringify({ sections: [
      { name: "Garden", about: "Soil, seeds and spring", stories: [1], posts: [{ id: 1, line: "Ann on tomatoes in March" }, { id: 2, line: "Zed on a made-up author" }] },
      { name: "Town", about: "https://x.example.com", stories: [], posts: [3] },
      { name: "Third", stories: [2], posts: [] },
    ] });
    const wrap = JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] });
    const p = readPlacement(wrap, 2, 3, undefined, ["Ann", "Bo", "Cy"]);
    expect(p.find((s) => s.name === "Garden")).toMatchObject({ about: "Soil, seeds and spring", singles: [0, 1], lines: { 0: "Ann on tomatoes in March" } });
    expect(p.find((s) => s.name === "Garden")?.lines?.[1]).toBeUndefined(); // the invented author
    expect(p.find((s) => s.name === "Town")?.about).toBeUndefined(); // an address
    expect(p.find((s) => s.name === "Third")?.about).toBeUndefined(); // none given: none shown
  });
  it("the prompt version is bumped, and an old cache is not trusted", () => {
    expect(SECTIONS_PROMPT_VERSION).toBe("4");
    const c = parseSectionsCache({ k: { at: 1, sections: [{ name: "A", about: "<b>x</b> https://e.example.com", ids: [0], posts: ["p1"], lines: { p1: 'Ann on "tea"', zz: "stranger" } }] } });
    expect(c.k?.sections[0]?.about).toBeUndefined(); // an address: no byline
    expect(c.k?.sections[0]?.lines).toEqual({ p1: "Ann on tea" });
  });
});

// A write end to end with a fake provider.
const wrapAnswer = (text: string): RawResponse => ({ status: 200, headers: {}, text: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } }) });
const contentOf = (r: RawRequest): string => (JSON.parse(r.body ?? "") as { messages: Array<{ content: string }> }).messages[0]?.content ?? "";
const idsOf = (c: string, tag: string): number[] => [...c.matchAll(new RegExp(`<${tag} id="(\\d+)"`, "g"))].map((m) => Number(m[1]));
const authors = (c: string): string[] => [...c.matchAll(/<post id="\d+" author="([^"]*)"/g)].map((m) => m[1] as string);

function harness() {
  const sent: RawRequest[] = [];
  let store: LlmStore = emptyStore();
  const deps: LlmDeps = {
    settings: () => ({ endpoint: "https://api.example.com/", model: "claude-sonnet-5-5" }),
    transport: async (r) => {
      sent.push(r);
      const c = contentOf(r);
      if (c.includes("<cluster id=")) return wrapAnswer(JSON.stringify({ clusters: idsOf(c, "cluster").map((id) => ({ id, headline: `Headline ${id}`, summary: `Summary ${id}.` })) }));
      const known = [...c.matchAll(/<section[^>]*>([^<]*)<\/section>/g)].map((m) => m[1] as string);
      const s = idsOf(c, "story");
      const ps = idsOf(c, "post");
      const au = authors(c);
      const lines = ps.map((id, k) => ({ id, line: `${au[k]} on topic ${id}` }));
      if (known.length > 0) return wrapAnswer(JSON.stringify({ sections: [{ name: known[0], about: "IGNORED for an old section", stories: s, posts: lines }] }));
      const names = ["Alpha", "Beta", "Gamma"];
      return wrapAnswer(JSON.stringify({ sections: names.map((name, k) => ({ name, about: `About ${name}`, stories: s.filter((i) => i % 3 === k), posts: lines.filter((_, j) => ps[j]! % 3 === k) })) }));
    },
    getKey: () => KEY, confirm: async () => true, askConsent: async () => true,
    load: async () => structuredClone(store), save: async (x) => void (store = structuredClone(x)), now: () => NOW,
  };
  return { deps, sent };
}

describe("a write with bylines and lines", () => {
  const topics = ["harbour tide lantern", "orchard cider press", "glacier survey drone", "market ledger tariff", "stadium league referee", "budget parliament vote"];
  const world = () => {
    let k = 0;
    let stored: unknown = null;
    const ed = new Editions({ read: async () => stored, write: async (t) => void (stored = JSON.parse(t)), now: () => NOW, time: () => "07:00" });
    const items: ReadingPost[] = [];
    topics.forEach((t, i) => {
      const a = post(`Alpha ${t} storybody${i} for the day.`, `Lead${i}`);
      items.push(a, post(`Reply on ${t} storybody${i}.`, `Rep${i}`, { isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId } }));
    });
    const lone = ["Ann", "Bo", "Cy", "Di"].map((who) => post(`Single number ${++k} about weather and tea and more.`, who));
    return { ed, items, lone };
  };
  async function write(h: ReturnType<typeof harness>, ed: Editions, posts: ReadingPost[]) {
    const info = await ed.open(posts);
    const rec = await ed.current();
    const c = info.grouped.clusters;
    const m = info.grouped.mixed;
    const out = await writeDigest(h.deps, c, { singles: m, existing: existingSections(rec, c, m) });
    await rememberWrite(h.deps, ed, info.id, c, out, m);
    return { out, info };
  }
  it("stores the bylines and the lines in the edition record, and the record gives them back", async () => {
    const w = world();
    const h = harness();
    const { info } = await write(h, w.ed, [...w.items, ...w.lone]);
    const rec = await w.ed.current();
    expect(rec?.sectionAbout).toEqual({ Alpha: "About Alpha", Beta: "About Beta", Gamma: "About Gamma" });
    const lines = rec?.postLines ?? {};
    expect(Object.keys(lines).sort()).toEqual(info.grouped.mixed.map((p) => p.remoteId).sort());
    for (const p of info.grouped.mixed) expect(lines[p.remoteId]).toMatch(new RegExp(`^${p.authorName} on topic \\d+$`));
    const secs = recordSections(rec, info.grouped.clusters, info.grouped.mixed) ?? [];
    expect(secs.find((s) => s.name === "Beta")?.about).toBe("About Beta");
    expect(secs.flatMap((s) => Object.keys(s.lines ?? {})).sort()).toEqual(Object.keys(lines).sort());
    expect(parseEditions(JSON.parse(JSON.stringify({ editions: [rec] }))).editions[0]?.sectionAbout).toEqual(rec?.sectionAbout); // survives the file
  });
  it("a later write sends only the NEW single posts, keeps every old line and byline, and takes no byline for an old section", async () => {
    const w = world();
    const h = harness();
    await write(h, w.ed, [...w.items, ...w.lone]);
    const before = structuredClone(await w.ed.current());
    h.sent.length = 0;
    const fresh = post("A brand new thought about moonlight FRESHBODY.", "Zed", { observedAt: new Date(NOW - 600_000).toISOString() });
    await write(h, w.ed, [...w.items, ...w.lone, fresh]);
    const reqs = h.sent.filter((r) => !contentOf(r).includes("<cluster id="));
    expect(reqs).toHaveLength(1);
    expect(authors(contentOf(reqs[0] as RawRequest))).toEqual(["Zed"]); // only the new single
    const after = await w.ed.current();
    for (const [id, line] of Object.entries(before?.postLines ?? {})) expect(after?.postLines?.[id]).toBe(line);
    expect(after?.postLines?.[fresh.remoteId]).toMatch(/^Zed on topic/);
    expect(after?.sectionAbout).toEqual(before?.sectionAbout); // the old section keeps its byline
  });
  it("a request still tells the model to treat posts as data, and the history keeps the byline and the lines", async () => {
    const w = world();
    const h = harness();
    const { out, info } = await write(h, w.ed, [...w.items, ...w.lone]);
    const system = (JSON.parse((h.sent.find((r) => !contentOf(r).includes("<cluster id=")) as RawRequest).body ?? "") as { system: string }).system;
    expect(system).toMatch(/DATA derived from posts written by strangers/);
    expect(system).toMatch(/<Author> on <short topic>/);
    const past = buildPast(info.id, info.grouped.clusters, out, info.grouped.mixed, NOW);
    expect(past.sections?.map((s) => s.about)).toEqual(["About Alpha", "About Beta", "About Gamma"]);
    expect(Object.keys(past.lines ?? {}).length).toBe(info.grouped.mixed.length);
    const back = parseHistory(JSON.parse(JSON.stringify({ editions: [past] }))).editions[0];
    expect(back?.sections?.[0]?.about).toBe("About Alpha");
    expect(back?.lines).toEqual(past.lines);
    expect(back?.stories[0]?.newest).toBe(past.stories[0]?.newest);
  });
});

describe("the page: bylines, lines, reading time, table of contents", () => {
  const stories = (names: string[]): Cluster[] => clusterPosts(names.flatMap((t, i) => {
    const a = post(`Wholly distinct ${t} subject only here ${i}.`, "Ann");
    return [a, post(`Reply ${t}.`, "Bo", { isReply: true, stubTarget: { id: a.remoteId } as never })];
  }));
  it("shows a section's byline muted below the heading, none when absent; singles show the content line in bold and the author under it, with no reading time; the contents show post counts, no bylines", async () => {
    const lone = [post("Mushrooms grow quietly under old oak trees. And more.", "Cy"), post(`${"word ".repeat(450)}end.`, "Di")];
    const list = { posts: [...stories(["alpha", "beta", "gamma", "delta"]).flatMap((c) => c.posts), ...lone], mentions: [], savedAt: NOW };
    const ai: DigestHost["ai"] = {
      enabled: () => true,
      cached: async (c) => c.map((_, i): Written => ({ headline: `Story ${i}`, summary: `Summary ${i}.`, model: "m", posts: 2 })),
      cachedSections: async (_c, singles) => [
        { name: "Garden", about: "Soil and seeds", ids: [2, 3], posts: [singles[0]!.remoteId], lines: { [singles[0]!.remoteId]: `${singles[0]!.authorName} on old oak mushrooms` } },
        { name: "Town", ids: [0, 1], posts: [singles[1]!.remoteId] },
      ],
      write: async () => ({ written: [], status: "ok" }),
    };
    const host: DigestHost = { loadList: () => Promise.resolve(list), edition: () => Promise.resolve({ id: 9, since: NOW - 6 * 3600_000, until: NOW }), ai, font: () => "serif", showFeed: () => Promise.resolve(), openPost: () => Promise.resolve(), openWeb: () => undefined };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    const root = (view as unknown as { contentEl: El }).contentEl;
    const all = root.all();
    const text = (c: string): string[] => all.filter((e) => cls(e, c)).map((e) => e.text);
    expect(text("blyg-section-about")).toEqual(["Soil and seeds"]); // Town has none: nothing drawn
    expect(text("blyg-story-line")[0]).toBe("Old oak mushrooms"); // the AI line without its "<Author> on " prefix
    expect(text("blyg-story-line")[1]).toMatch(/^word word/); // no line: the first sentence
    expect(text("blyg-story-by").sort()).toEqual(["by Cy", "by Di"]);
    expect(text("blyg-story-time")).toEqual([]); // no reading time on a single post
    // the table of contents: both sections with the byline, in page order, and a tap scrolls
    const toc = all.filter((e) => cls(e, "blyg-toc-name")).map((e) => e.text);
    expect(toc).toEqual(["Top stories", "Garden", "Town"]); // name, then the post count (a story's posts plus the singles)
    expect(text("blyg-toc-about")).toEqual([]);
    expect(text("blyg-toc-count")).toEqual(["4 items", "5 items", "1 item"]); // Top stories, Garden, Town: in the order drawn; // what is drawn under each heading (the lead block holds the other stories)
    const heading = all.find((e) => e.tag === "h3" && e.text === "Town");
    expect(heading).toBeDefined();
    tocLink(all, "Town")?.click();
    // (the section's box scrolls; its element is the heading's parent: counted through the view's map)
    const boxes = (view as unknown as { sectionEls: Map<string, El> }).sectionEls;
    expect(boxes.get("Town")?.scrolled).toBe(1);
  });
  it("the table of contents is open up to 8 sections and collapsed behind one line above 8; a tap goes to the section", () => {
    const mk = (k: number) => Array.from({ length: k }, (_, i) => ({ name: `S${i}`, count: i + 1 }));
    const gone: string[] = [];
    // a real fake element from the mock
    const host = new (BlygDailyView as unknown as new (l: unknown, h: unknown) => { contentEl: El })({}, {}).contentEl;
    drawToc(host as never, mk(TOC_OPEN_MAX), (n) => gone.push(n));
    expect(host.all().some((e) => e.tag === "details")).toBe(false);
    tocLink(host.all(), "S3")?.click();
    expect(gone).toEqual(["S3"]);
    const many = new (BlygDailyView as unknown as new (l: unknown, h: unknown) => { contentEl: El })({}, {}).contentEl;
    drawToc(many as never, mk(TOC_OPEN_MAX + 1), () => undefined);
    expect(many.all().some((e) => e.tag === "details")).toBe(true);
    expect(many.all().find((e) => e.tag === "summary")?.text).toBe("Contents (9)");
    expect(many.all().filter((e) => cls(e, "blyg-toc-link"))).toHaveLength(9);
  });
  it("a past edition has the table of contents, bylines and lines too", async () => {
    const lone = post("Mushrooms grow quietly under old oak trees.", "Cy");
    const past: PastEdition = {
      id: 3, at: 3, stories: [{ headline: "Old", summary: "Told.", posts: ["x1", "x2"], newest: 5 }, { headline: "Newer", summary: "", posts: ["x3", "x4"], newest: 9 }], singles: [lone.remoteId],
      sections: [{ name: "Garden", about: "Soil and seeds", stories: [0, 1], posts: [lone.remoteId] }], who: { x1: "Ann" }, lines: { [lone.remoteId]: "Cy on old oak mushrooms" },
    };
    const host: DigestHost = { loadList: () => Promise.resolve({ posts: [lone], mentions: [], savedAt: NOW }), edition: () => Promise.resolve({ id: 9, since: NOW - 6 * 3600_000, until: NOW }), history: () => Promise.resolve({ editions: [past], capped: false }), font: () => "serif", showFeed: () => Promise.resolve(), openPost: () => Promise.resolve(), openWeb: () => undefined };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    const root = (view as unknown as { contentEl: El }).contentEl;
    root.all().find((e) => e.tag === "button" && e.text === "‹")?.click();
    const all = root.all();
    expect(all.filter((e) => cls(e, "blyg-toc-name")).map((e) => e.text)).toEqual(["Garden"]); // a past edition has no lead block, so no Top stories line
    expect(all.filter((e) => cls(e, "blyg-section-about")).map((e) => e.text)).toEqual(["Soil and seeds"]);
    expect(all.filter((e) => cls(e, "blyg-story-line")).map((e) => e.text)).toEqual(["Old oak mushrooms"]);
    expect(all.filter((e) => cls(e, "blyg-daily-headline")).map((e) => e.text)).toEqual(["Newer", "Old"]); // newest story first
  });
});

describe("no sideways scroll (CSS) and no automatic checking (reader)", () => {
  const css = readFileSync("styles.css", "utf8");
  it("the digest page wraps long unbroken text and never scrolls sideways", () => {
    expect(css).toMatch(/\.view-content\.blyg-daily \{[^}]*overflow-x: hidden/);
    expect(css).toMatch(/button\.blyg-daily-link \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.blyg-story-summary[^{]*\{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.blyg-story-main[^{]*\{[^}]*min-width: 0/); // a flex child that may shrink
    expect(css).toMatch(/\.blyg-daily-head, \.blyg-daily-switcher \{ flex-wrap: wrap/);
  });
  it("the reader has no watcher: its only interval is the clock of the status line, and nothing reads the counters outside Refresh", () => {
    const src = readFileSync("src/ui/ReaderView.ts", "utf8");
    expect(src.match(/registerInterval/g)).toHaveLength(1);
    expect(src).not.toMatch(/lookForMoves/);
    const callers = src.split("\n").map((l, i) => [i, l] as const).filter(([, l]) => l.includes("host.changeMarks()"));
    const refresh = src.indexOf("private async checkForNew");
    const refreshEnd = src.indexOf("/** Mark read or unread");
    for (const [i] of callers) {
      const at = src.split("\n").slice(0, i).join("\n").length;
      expect(at).toBeGreaterThan(refresh);
      expect(at).toBeLessThan(refreshEnd);
    }
  });
});

describe("placement: a post goes to a section only when it fits", () => {
  it("the later request shows each existing section's byline and tells the model to use Other for what does not fit; an Other answer lands in Other", () => {
    const req = buildSectionsRequest([], { endpoint: "https://api.example.com", model: "m" }, KEY, [{ id: "p", author: "Fred", excerpt: "An essay on ideology and politics" }], ["Studio releases", "Other"], { "Studio releases": "Blygger Studio versions, fixes and clients" });
    const body = JSON.parse(req.body) as { system: string; messages: Array<{ content: string }> };
    expect(body.messages[0]?.content).toContain('<section about="Blygger Studio versions, fixes and clients">Studio releases</section>');
    expect(body.system).toMatch(/ONLY when it clearly fits/);
    expect(body.system).toMatch(/goes in Other/);
    const placed = readPlacement(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ sections: [{ name: "Other", stories: [], posts: [{ id: 1, line: "Fred on ideology" }] }] }) }] }), 0, 1, ["Studio releases", "Other"], ["Fred"]);
    expect(placed.map((s) => s.name)).toEqual(["Other"]);
  });
  it("read stories and posts sink below unread ones inside a section, keeping their order otherwise", () => {
    const mk = (m: number, read: boolean): ReadingPost => post(`s${m}`, "Ann", { observedAt: new Date(NOW - m * 60_000).toISOString(), readVersion: read ? 1 : null });
    const a = mk(10, true);
    const b = mk(50, false);
    const c = mk(30, false);
    const d = drawnSections([{ name: "S", ids: [], posts: [a.remoteId, b.remoteId, c.remoteId] }], [], new Map([a, b, c].map((p) => [p.remoteId, p])));
    expect(d[0]?.singles.map((p) => p.remoteId)).toEqual([c.remoteId, b.remoteId, a.remoteId]);
  });
});

describe("the view does not shadow Obsidian's own View methods", () => {
  it("defines no open, close, load or unload of its own: Obsidian calls view.open(parentEl) to start a view, and an override with another meaning left the Daily blank", () => {
    const own = Object.getOwnPropertyNames(BlygDailyView.prototype);
    for (const name of ["open", "close", "load", "unload", "onload", "onunload", "setState", "getState"]) expect(own).not.toContain(name);
  });
});

describe("DG11: the contents are the headings the page draws, in the order drawn, with what is drawn under each", () => {
  const stories = (names: string[]): Cluster[] => clusterPosts(names.flatMap((t, i) => {
    const a = post(`Wholly distinct ${t} subject only here ${i}.`, "Ann");
    return [a, post(`Reply ${t}.`, "Bo", { isReply: true, stubTarget: { id: a.remoteId } as never })];
  }));
  const mountList = async (list: { posts: ReadingPost[]; mentions: never[]; savedAt: number }, ai?: DigestHost["ai"], history?: PastEdition[]) => {
    const host: DigestHost = { loadList: () => Promise.resolve(list), edition: () => Promise.resolve({ id: 9, since: NOW - 6 * 3600_000, until: NOW }), ...(ai ? { ai } : {}), ...(history ? { history: () => Promise.resolve({ editions: history, capped: false }) } : {}), font: () => "serif", showFeed: () => Promise.resolve(), openPost: () => Promise.resolve(), openWeb: () => undefined };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    return (view as unknown as { contentEl: El }).contentEl;
  };
  const contents = (root: El): Array<[string, string]> => {
    const names = root.all().filter((e) => cls(e, "blyg-toc-name")).map((e) => e.text);
    const counts = root.all().filter((e) => cls(e, "blyg-toc-count")).map((e) => e.text);
    return names.map((n, i): [string, string] => [n, counts[i] ?? ""]);
  };
  const headings = (root: El): string[] => root.all().filter((e) => e.tag === "h3").map((e) => e.text);
  it("with AI sections: Top stories first, then each section as drawn, then the Mixed bag; counts are posts", async () => {
    const lone = [post("Mushrooms grow quietly under old oak trees.", "Cy"), post("Trains were late again today for everyone.", "Di"), post("A third lone remark about the weather outside.", "Ed")];
    const list = { posts: [...stories(["alpha", "beta", "gamma", "delta"]).flatMap((c) => c.posts), ...lone], mentions: [] as never[], savedAt: NOW };
    const ai: DigestHost["ai"] = {
      enabled: () => true,
      cached: async (c) => c.map((_, i): Written => ({ headline: `Story ${i}`, summary: `Summary ${i}.`, model: "m", posts: 2 })),
      cachedSections: async (_c, singles) => [{ name: "Garden", ids: [2, 3], posts: [singles[0]!.remoteId] }, { name: "Town", ids: [0, 1], posts: [singles[1]!.remoteId] }],
      write: async () => ({ written: [], status: "ok" }),
    };
    const root = await mountList(list, ai);
    const toc = contents(root);
    expect(toc.map(([n]) => n)).toEqual(headings(root)); // the same lines in the same order as the headings
    expect(toc[0]).toEqual(["Top stories", "4 items"]); // the lead block: 2 stories of 2 posts; it is the FIRST entry
    expect(toc.map(([n]) => n)).toContain("Mixed bag");
    expect(toc.at(-1)).toEqual(["Mixed bag", "1 item"]); // the singles no section holds
    // a section's counter: its stories' posts plus its single posts, equal to what its card says
    const garden = toc.find(([n]) => n === "Garden");
    expect(garden?.[1]).toBe("5 items");
  });
  it("without AI sections (the plain page): Top stories first, then Letters and the Mixed bag as drawn", async () => {
    const lone = [post("Mushrooms grow quietly under old oak trees.", "Cy"), post("Trains were late again today for everyone.", "Di")];
    const list = { posts: [...stories(["alpha", "beta"]).flatMap((c) => c.posts), ...lone], mentions: [] as never[], savedAt: NOW };
    const root = await mountList(list);
    const toc = contents(root);
    expect(toc).toEqual([["Top stories", "4 items"], ["Mixed bag", "2 items"]]);
    expect(toc.map(([n]) => n)).toEqual(headings(root));
  });
  it("a past edition: the contents are its headings in the order drawn, counts are the posts under each (a plain one starts with Top stories)", async () => {
    const lone = post("Mushrooms grow quietly under old oak trees.", "Cy");
    const sectioned: PastEdition = {
      id: 3, at: 3, stories: [{ headline: "Old", summary: "", posts: ["x1", "x2"], newest: 5 }, { headline: "Newer", summary: "", posts: ["x3", "x4", "x5"], newest: 9 }, { headline: "Loose", summary: "", posts: ["x6", "x7"], newest: 1 }],
      singles: [lone.remoteId, "z9"], sections: [{ name: "Garden", stories: [0, 1], posts: [lone.remoteId] }], who: {},
    };
    const plain: PastEdition = { id: 2, at: 2, stories: [{ headline: "One", summary: "", posts: ["a1", "a2"], newest: 1 }], singles: ["b1"], who: {}, sections: null };
    const old: PastEdition = { id: 1, at: 1, stories: [{ headline: "Two", summary: "", posts: ["c1", "c2"], newest: 1 }], singles: [], who: {}, sections: [{ name: "Front page", stories: [0], posts: [] }, { name: "Sport", stories: [], posts: ["d1"] }] };
    const root = await mountList({ posts: [lone], mentions: [], savedAt: NOW }, undefined, [sectioned, plain, old]);
    const go = (n: number): void => { for (let i = 0; i < n; i++) root.all().find((e) => e.tag === "button" && e.text === "‹")?.click(); };
    go(1);
    expect(contents(root)).toEqual([["Garden", "6 items"], ["Other", "2 items"], ["Mixed bag", "1 item"]]); // Garden: 2 + 3 + 1; the story no section holds is under Other; one single is not in any section
    expect(contents(root).map(([n]) => n)).toEqual(headings(root));
    go(1);
    expect(contents(root)).toEqual([["Top stories", "2 items"], ["Mixed bag", "1 item"]]);
    expect(contents(root).map(([n]) => n)).toEqual(headings(root));
    go(1);
    // an old record whose section is called "Front page" is shown under the new label; the stored name is not changed
    expect(contents(root).map(([n]) => n)).toEqual(["Top stories", "Sport"]);
    expect(headings(root)).toEqual(["Top stories", "Sport"]);
    expect(old.sections?.[0]?.name).toBe("Front page");
  });
});
