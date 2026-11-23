// DG8 (digest v3): "Mark read" in the digest (one write per post, serialised, unread only, never twice), single-post lines (content first), the contents with post counts,
// a tap anywhere on a post of an unfolded story, and the unfolded state kept across Back. Fake DOM, fake clock, fake Studio; invented names only.
process.env.TZ = "Europe/Berlin";
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

import { MARK_GAP_MS, MarkQueue, resetMarks } from "../../src/digest/markQueue";
import { byLine, contentLine, topicOf } from "../../src/digest/singleLine";
import { useReaderMode } from "../../src/ui/readerMode";
import { clearScrolls } from "../../src/digest/scrollMemory";
import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import type { ReadingPost } from "../../src/studio/reading";

const NOW = Date.parse("2030-03-10T12:00:00Z");
let n = 0;
const post = (text: string, author: string | null, over: Partial<ReadingPost> = {}): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: `m${String(++n).padStart(6, "0")}`.padEnd(26, "x"), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000 - n * 1000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: `<p>${text}</p>`, contentMd: "", authorName: author, authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; cls: Set<string>; attrs: Record<string, string>; click(): void; all(): El[] };
const has = (e: El, c: string): boolean => e.cls.has(c);
const flush = async (): Promise<void> => void (await new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  vi.stubGlobal("window", { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
  clearScrolls();
  resetMarks();
});

describe("the mark queue", () => {
  const make = () => {
    const asked: string[] = [];
    const unasked: string[] = [];
    const naps: number[] = [];
    const gone: string[] = [];
    let changes = 0;
    let fail: string | null = null;
    const q = new MarkQueue({
      mark: (p) => (asked.push(p.remoteId), Promise.resolve(fail === null ? { ok: true } : { ok: false, message: fail })),
      unmark: (p) => (unasked.push(p.remoteId), Promise.resolve(fail === null ? { ok: true } : { ok: false, message: fail })),
      sleep: (ms) => (naps.push(ms), Promise.resolve()),
      now: () => 100,
      onChange: () => void changes++,
      onReverted: (_p, m) => void gone.push(m),
    });
    return { q, asked, unasked, naps, gone, changes: () => changes, failWith: (m: string | null) => (fail = m) };
  };
  it("shows the new state at once, asks the Studio once per unread post, one after the other with a pause", async () => {
    const t = make();
    const ps = [post("one", "Ann"), post("two", "Bo"), post("three", "Cy")];
    const done = t.q.enqueue(ps);
    expect(ps.every((p) => p.readVersion === 1)).toBe(true); // before any request has answered
    await done;
    expect(t.asked).toEqual(ps.map((p) => p.remoteId));
    expect(t.naps).toEqual([MARK_GAP_MS, MARK_GAP_MS]); // no burst: a pause between two writes, none before the first
  });
  it("marks read posts unread again: only the read ones, one write each with the pause, put back on a refusal, remembered over an older saved copy", async () => {
    const t = make();
    const ps = [post("one", "Ann", { readVersion: 1 }), post("two", "Bo"), post("three", "Cy", { readVersion: 1 }), post("own", "Me", { own: true, readVersion: 1 })];
    const done = t.q.enqueueUnread(ps);
    expect(ps.map((p) => p.readVersion)).toEqual([null, null, null, 1]); // at once; the owner's own is left alone
    await done;
    expect(t.unasked).toEqual([ps[0]!.remoteId, ps[2]!.remoteId]);
    expect(t.asked).toEqual([]);
    expect(t.naps).toEqual([MARK_GAP_MS]);
    await t.q.enqueueUnread(ps);
    expect(t.unasked).toHaveLength(2); // never twice
    const stale = [{ ...ps[0]!, readVersion: 1 }];
    t.q.apply(stale, 50);
    expect(stale[0]!.readVersion).toBeNull();
    const u = make();
    const r = [post("a", "Ann", { readVersion: 1 }), post("b", "Bo", { readVersion: 1 })];
    u.failWith("no token");
    await u.q.enqueueUnread(r);
    expect(r.map((p) => p.readVersion)).toEqual([1, 1]);
    expect(u.unasked).toEqual([r[0]!.remoteId]); // the refusal stops the rest
    expect(u.gone).toEqual(["no token"]);
  });
  it("marks only unread posts and never the same post twice", async () => {
    const t = make();
    const read = post("read", "Ann", { readVersion: 1 });
    const own = post("own", "Me", { own: true });
    const gone = post("gone", "Di", { withdrawn: true });
    const fresh = post("fresh", "Ed");
    await t.q.enqueue([read, own, gone, fresh]);
    await t.q.enqueue([read, own, gone, fresh]);
    expect(t.asked).toEqual([fresh.remoteId]);
  });
  it("a post updated since it was read is unread again and is marked at its new version", async () => {
    const t = make();
    const p = post("x", "Ann", { version: 3, readVersion: 2 });
    await t.q.enqueue([p]);
    expect(t.asked).toHaveLength(1);
    expect(p.readVersion).toBe(3);
  });
  it("a refusal stops the batch, puts back every mark not made, and says why; the post marked before it stays marked", async () => {
    const t = make();
    const ps = [post("one", "Ann"), post("two", "Bo"), post("three", "Cy")];
    let k = 0;
    const q = new MarkQueue({ mark: (p) => (t.asked.push(p.remoteId), Promise.resolve(++k === 1 ? { ok: true } : { ok: false, message: "needs reading:state" })), sleep: () => Promise.resolve(), now: () => 1, onChange: () => undefined, onReverted: (_p, m) => t.gone.push(m) });
    await q.enqueue(ps);
    expect(t.asked).toHaveLength(2); // the third was never asked
    expect(ps.map((p) => p.readVersion)).toEqual([1, null, null]);
    expect(t.gone).toEqual(["needs reading:state"]);
    await q.enqueue([ps[1]!]); // after a refusal it may be tried again, by the person
    expect(t.asked).toHaveLength(3);
  });
  it("remembers a mark for a list read from an older saved copy, and lets a newer copy decide", async () => {
    const t = make();
    const p = post("x", "Ann");
    await t.q.enqueue([p]);
    const older = [{ ...p, readVersion: null }];
    t.q.apply(older, 50); // saved before the mark (at 100)
    expect(older[0]!.readVersion).toBe(1);
    const newer = [{ ...p, readVersion: null }];
    t.q.apply(newer, 200); // saved after: it knows what it knows
    expect(newer[0]!.readVersion).toBeNull();
  });
});

describe("single-post lines", () => {
  const p = post("Mushrooms grow quietly under old oak trees. And more.", "Cy");
  it("cuts a leading author off a stored line, keeps any other line as it is", () => {
    expect(topicOf("Cy on old oak mushrooms", p)).toBe("Old oak mushrooms");
    expect(topicOf("Someone else on mushrooms", p)).toBe("Someone else on mushrooms");
    expect(topicOf("Cy on", p)).toBe("Cy on");
  });
  it("is the content first (the line's topic, else the first sentence) and 'by Author' after it", () => {
    expect(contentLine(p, "Cy on old oak mushrooms")).toBe("Old oak mushrooms");
    expect(contentLine(p)).toBe("Mushrooms grow quietly under old oak trees.");
    expect(byLine(p)).toBe("by Cy");
  });
});

describe("the digest page", () => {
  const story = (t: string): ReadingPost[] => {
    const a = post(`Wholly distinct ${t} subject only here, long enough.`, "Ann");
    return [a, post(`Reply on ${t}.`, "Bo", { isReply: true, stubTarget: { id: a.remoteId } as never })];
  };
  async function mount(posts: ReadingPost[], marked: string[] = [], opened: string[] = [], leaf: unknown = {}, unmarked: string[] = [], refuse = false) {
    const host: DigestHost = {
      loadList: () => Promise.resolve({ posts, mentions: [], savedAt: NOW }),
      edition: () => Promise.resolve({ id: 7, since: NOW - 6 * 3600_000, until: NOW }),
      font: () => "serif",
      showFeed: () => Promise.resolve(),
      openPost: (p) => Promise.resolve(void opened.push(p.remoteId)),
      openWeb: () => undefined,
      markRead: (p) => (marked.push(p.remoteId), Promise.resolve({ ok: true })),
      markUnread: (p) => (unmarked.push(p.remoteId), Promise.resolve(refuse ? { ok: false, message: "no" } : { ok: true })),
    };
    const view = new BlygDailyView(leaf as never, host);
    await view.onOpen();
    return { root: (view as unknown as { contentEl: El }).contentEl, view };
  }
  const buttons = (root: El, label: string): El[] => root.all().filter((e) => e.tag === "button" && (e.attrs["aria-label"] === label || e.text === label));

  it("a single post has a Mark read button that marks it and dims the row; a story has one for all its posts", async () => {
    const [a, b] = story("harbour");
    const lone = post("A lone post nobody answers.", "Cy");
    const marked: string[] = [];
    const { root } = await mount([a!, b!, lone], marked);
    expect(buttons(root, "Mark story read")).toHaveLength(1);
    expect(buttons(root, "Mark read")).toHaveLength(1);
    buttons(root, "Mark read")[0]!.click();
    await flush();
    expect(marked).toEqual([lone.remoteId]);
    expect(buttons(root, "Mark read")).toHaveLength(0); // gone at once
    expect(root.all().filter((e) => has(e, "blyg-story-mixed") && has(e, "blyg-is-read"))).toHaveLength(1);
    buttons(root, "Mark story read")[0]!.click();
    await flush();
    await vi.waitFor(() => expect(marked).toEqual([lone.remoteId, a!.remoteId, b!.remoteId])); // one request per post, in the story's order
    expect(buttons(root, "Mark story read")).toHaveLength(0);
    expect(root.all().filter((e) => has(e, "blyg-story") && has(e, "blyg-is-read"))).toHaveLength(1);
  });
  it("marks nothing when everything is read: the symbol shows read, and a tap marks every read post unread again, one write each", async () => {
    const [a, b] = story("orchard");
    a!.readVersion = 1;
    b!.readVersion = 1;
    const marked: string[] = [];
    const unmarked: string[] = [];
    const { root } = await mount([a!, b!], marked, [], {}, unmarked);
    expect(buttons(root, "Mark story read")).toHaveLength(0);
    expect(marked).toEqual([]);
    const sym = buttons(root, "Mark story unread");
    expect(sym).toHaveLength(1);
    expect(sym[0]!.attrs["data-icon"]).toBe("check-circle-2");
    expect(sym[0]!.text).toBe(""); // a symbol, not a word
    sym[0]!.click();
    await vi.waitFor(() => expect(unmarked).toEqual([a!.remoteId, b!.remoteId]));
    expect([a!.readVersion, b!.readVersion]).toEqual([null, null]); // shown at once, kept
    expect(buttons(root, "Mark story read")).toHaveLength(1);
    expect(marked).toEqual([]);
  });
  it("a read single post is put back to unread by a tap; a refusal puts the read mark back", async () => {
    const lone = post("A lone read post.", "Cy", { readVersion: 1 });
    const unmarked: string[] = [];
    const first = await mount([lone], [], [], {}, unmarked, true);
    expect(buttons(first.root, "Mark unread")[0]!.attrs["aria-pressed"]).toBe("true");
    buttons(first.root, "Mark unread")[0]!.click();
    expect(lone.readVersion).toBeNull(); // at once
    await vi.waitFor(() => expect(lone.readVersion).toBe(1)); // the Studio refused: put back
    expect(unmarked).toEqual([lone.remoteId]);
    expect(first.root.all().filter((e) => has(e, "blyg-story-mixed") && has(e, "blyg-is-read"))).toHaveLength(1);
  });
  it("a story with some posts read still offers Mark story read, and unmarking leaves unread posts alone", async () => {
    const [a, b] = story("tide");
    a!.readVersion = 1;
    const unmarked: string[] = [];
    const { root, view } = await mount([a!, b!], [], [], {}, unmarked);
    expect(buttons(root, "Mark story unread")).toHaveLength(0);
    const q = (view as unknown as { queue(): MarkQueue }).queue();
    await q.enqueueUnread([a!, b!]);
    expect(unmarked).toEqual([a!.remoteId]); // only the read one
  });
  it("a story with one unread post marks only that one", async () => {
    const [a, b] = story("glacier");
    a!.readVersion = 1;
    const marked: string[] = [];
    const { root } = await mount([a!, b!], marked);
    buttons(root, "Mark story read")[0]!.click();
    await flush();
    expect(marked).toEqual([b!.remoteId]);
  });
  it("a correction leads with the change note (bold) and the headline is secondary; without a note the line is as before", async () => {
    const withNote = post("Corrected harbour figure here.", "Ann", { version: 2, changeNote: "Fixed the March total" });
    const plain = post("Another revised piece appears.", "Bo", { version: 2 });
    const { root } = await mount([withNote, plain]);
    const notes = root.all().filter((e) => has(e, "blyg-correction-note"));
    expect(notes.map((e) => e.text)).toEqual(["Fixed the March total"]);
    expect(root.all().filter((e) => has(e, "blyg-correction-headline")).map((e) => e.text)).toEqual(["Corrected harbour figure here."]);
    expect(root.all().some((e) => e.text === "Bo · revised to v2")).toBe(true);
  });
  it("the sticky bar keeps the title, the dateline, the Feed | Digest toggle (in .blyg-modeslot) and one menu icon; the other controls are folded away until the menu is tapped", async () => {
    const [a, b] = story("lantern");
    useReaderMode({ get: () => "digest", set: () => undefined });
    const { root } = await mount([a!, b!]);
    useReaderMode(null);
    const bar = root.all().find((e) => has(e, "blyg-daily-bar"))!;
    expect(bar.all().some((e) => has(e, "blyg-daily-date"))).toBe(true);
    expect(bar.all().find((e) => has(e, "blyg-modeslot"))!.all().filter((e) => has(e, "blyg-modebtn")).map((e) => e.text)).toEqual(["Feed", "Digest"]);
    const menus = bar.all().filter((e) => has(e, "blyg-daily-menu"));
    expect(menus).toHaveLength(1);
    expect(menus[0]!.attrs["data-icon"]).toBe("menu");
    const panel = bar.all().find((e) => has(e, "blyg-daily-panel"))!;
    expect(panel.cls.has("is-open")).toBe(false);
    expect(panel.all().some((e) => e.text === "Refresh")).toBe(true); // inside the folded panel
    expect(bar.all().filter((e) => e.text === "Refresh" && !panel.all().includes(e))).toHaveLength(0);
    menus[0]!.click();
    expect(panel.cls.has("is-open")).toBe(true);
  });
  it("a tap anywhere on a post of an unfolded story opens it; Back finds the story still unfolded", async () => {
    const [a, b] = story("market");
    const opened: string[] = [];
    const first = await mount([a!, b!], [], opened);
    first.root.all().find((e) => has(e, "blyg-daily-headline"))?.click();
    const row = first.root.all().find((e) => has(e, "blyg-daily-member"))!;
    row.click(); // the row itself, not its name button
    expect(opened).toEqual([a!.remoteId]);
    const again = await mount([a!, b!], [], opened); // the view is made again on Back
    expect(again.root.all().filter((e) => has(e, "blyg-daily-member"))).toHaveLength(2);
    again.root.all().find((e) => has(e, "blyg-daily-headline"))?.click(); // a second tap folds it
    expect(again.root.all().filter((e) => has(e, "blyg-daily-member"))).toHaveLength(0);
  });
  it("posts of a past edition and single posts have no reading time", async () => {
    const { root } = await mount([post("A lone post nobody answers.", "Cy")]);
    expect(root.all().some((e) => has(e, "blyg-story-time"))).toBe(false);
    expect(root.all().some((e) => /\d+ min$/.test(e.text))).toBe(false);
  });
});
