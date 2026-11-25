// The Daily's read look (DG18): posts already read stay where they are in a muted colour, a story whose posts are all read has its headline and summary muted too; and the one
// Refresh: it fetches, then writes only the missing texts when the automatic write is on (and sends nothing when it is off); the manual writes sit under "Advanced".
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FakeEl {
    cls = new Set<string>();
    text = "";
    children: FakeEl[] = [];
    handlers: Array<() => void> = [];
    attrs: Record<string, string> = {};
    scrollTop = 0;
    isConnected = true;
    constructor(public tag = "div") {}
    addClass(c: string) { this.cls.add(c); }
    toggleClass(c: string, on: boolean) { if (on) this.cls.add(c); else this.cls.delete(c); }
    setAttr(k: string, v: string) { this.attrs[k] = v; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    hasAttribute(k: string) { return k in this.attrs; }
    private make(tag: string, o?: { cls?: string; text?: string }) {
      const el = new FakeEl(tag);
      if (o?.cls) o.cls.split(" ").forEach((c) => el.cls.add(c));
      if (o?.text) el.text = o.text;
      this.children.push(el);
      return el;
    }
    createDiv(o?: { cls?: string; text?: string }) { return this.make("div", o); }
    createSpan(o?: { cls?: string; text?: string }) { return this.make("span", o); }
    createEl(tag: string, o?: { cls?: string; text?: string }) { return this.make(tag, o); }
    addEventListener(t: string, fn: () => void) { if (!/^(touch|context|toggle)/.test(t)) this.handlers.push(fn); }
    click() { this.handlers.forEach((h) => h()); }
    empty() { this.children = []; }
    prepend() { /* not needed */ }
    all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  }
  class ItemView {
    contentEl = new FakeEl();
    constructor(public leaf: unknown) {}
  }
  return { ItemView, setIcon: () => undefined };
});

import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import { clearScrolls } from "../../src/digest/scrollMemory";
import type { Written } from "../../src/digest/llm";
import type { ReadingPost } from "../../src/studio/reading";

beforeEach(() => clearScrolls());
const NOW = Date.parse("2030-03-10T12:00:00Z");
let n = 0;
const p = (over: Partial<ReadingPost>): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Blyg", origin: "https://one.example.com/", remoteId: `r${String(++n).padStart(5, "0")}`.padEnd(26, "x"), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: "<p>Hello there, a long enough sentence.</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; cls: Set<string>; children: El[]; click(): void; all(): El[] };
const has = (e: El, c: string): boolean => e.cls.has(c);
const textOf = (e: El): string => e.text + e.children.map(textOf).join("");
const story = (read: [boolean, boolean]): ReadingPost[] => {
  const a = p({ contentHtml: "<p>Shared topic about gardens and tomatoes in spring.</p>", authorName: "Ann", ...(read[0] ? { readVersion: 1 } : {}) });
  const b = p({ isReply: true, stubTarget: { id: a.remoteId } as never, contentHtml: "<p>My tomatoes did badly this spring.</p>", authorName: "Bo", ...(read[1] ? { readVersion: 1 } : {}) });
  return [a, b];
};
const written = (c: readonly unknown[]): Written[] => c.map((_, i) => ({ headline: `Story ${i}`, summary: `Summary ${i}.`, model: "m", posts: 2 }));

async function mount(posts: ReadingPost[], over: Partial<DigestHost> = {}): Promise<{ root: El; view: BlygDailyView }> {
  const host: DigestHost = {
    loadList: () => Promise.resolve({ posts, mentions: [], savedAt: NOW }),
    edition: () => Promise.resolve({ since: NOW - 6 * 3600_000, until: NOW }),
    font: () => "serif",
    showFeed: () => Promise.resolve(),
    openPost: () => Promise.resolve(),
    openWeb: () => undefined,
    ...over,
  };
  const view = new BlygDailyView({} as never, host);
  await view.onOpen();
  return { root: (view as unknown as { contentEl: El }).contentEl, view };
}

describe("posts already read, dimmed in place", () => {
  const ai: DigestHost["ai"] = { enabled: () => true, cached: async (c) => written(c), write: async () => ({ written: [], status: "ok" }) };
  it("a story whose posts are all read is marked read, with its posts; one unread post leaves the story and that post as they were", async () => {
    const allRead = await mount([...story([true, true])], { ai });
    const card = allRead.root.all().find((e) => has(e, "blyg-story"))!;
    expect(has(card, "blyg-is-read")).toBe(true);
    allRead.root.all().find((e) => has(e, "blyg-daily-headline"))?.click();
    expect(allRead.root.all().filter((e) => has(e, "blyg-daily-member")).every((r) => has(r, "blyg-is-read"))).toBe(true);
    clearScrolls(); // (what is unfolded is remembered)
    const some = await mount([...story([true, false])], { ai });
    expect(has(some.root.all().find((e) => has(e, "blyg-story"))!, "blyg-is-read")).toBe(false);
    some.root.all().find((e) => has(e, "blyg-daily-headline"))?.click();
    const rows = some.root.all().filter((e) => has(e, "blyg-daily-member"));
    expect(rows.map((r) => has(r, "blyg-is-read"))).toEqual([true, false]);
    const none = await mount([...story([false, false]), p({ authorName: "Cy" })], { ai });
    expect(none.root.all().some((e) => has(e, "blyg-is-read"))).toBe(false); // unread ones are unchanged
  });
  it("nothing is hidden or folded: the posts and their order are the same read or not", async () => {
    const [a, b] = story([false, false]);
    const lone = p({ authorName: "Cy" });
    const order = async (read: boolean): Promise<string[]> => {
      const mark = (q: ReadingPost): ReadingPost => ({ ...q, readVersion: read ? 1 : null });
      const m = await mount([mark(a!), mark(b!), mark(lone)], { ai });
      return (m.view as unknown as { order: ReadingPost[] }).order.map((q) => q.remoteId);
    };
    expect(await order(true)).toEqual(await order(false));
    expect(await order(true)).toEqual([a!.remoteId, b!.remoteId, lone.remoteId]);
  });
  it("is a muted colour, never opacity or a strike-through, and the hover colour still wins", () => {
    const css = readFileSync("styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/[^{}]*blyg-is-read[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r).not.toMatch(/opacity|line-through|display: none/);
      expect(r).toMatch(/color: var\(--text-muted\)/);
    }
    expect(css.indexOf("blyg-story.blyg-is-read > button.blyg-story-headline")).toBeLessThan(css.indexOf(".blyg-story > button.blyg-story-headline:hover"));
  });
});

describe("one Refresh", () => {
  const base = story([false, false]);
  const fresh = p({ authorName: "Dee", contentHtml: "<p>Zebra crossing paint dries slowly on the new bridge deck.</p>" });
  /** A host whose list grows by `fresh` when Refresh runs. `auto`: the automatic write is on. */
  const setup = async (auto: boolean, writtenNow: (c: readonly unknown[]) => Array<Written | null>): Promise<{ root: El; view: BlygDailyView; writes: Array<{ resort?: boolean; auto?: boolean } | undefined>; note: () => string }> => {
    const writes: Array<{ resort?: boolean; auto?: boolean } | undefined> = [];
    const ai: DigestHost["ai"] = {
      enabled: () => true,
      autoOn: () => Promise.resolve(auto),
      cached: async (c) => writtenNow(c),
      write: async (c, _s, opts) => (writes.push(opts), { written: written(c), status: "ok", tokens: 100, cost: 0.001 }),
    };
    const refresh: DigestHost["refresh"] = () => Promise.resolve({ ok: true, list: { posts: [...base, fresh], mentions: [] } });
    const m = await mount(base, { ai, refresh });
    return { ...m, writes, note: () => (m.view as unknown as { note: string }).note };
  };
  const press = async (m: { root: El }): Promise<void> => {
    m.root.all().find((e) => has(e, "blyg-daily-refreshbtn"))!.click();
    await new Promise((r) => setTimeout(r, 10));
  };
  it("with the automatic write on, writes once, by the automatic rules, after fetching", async () => {
    const m = await setup(true, (c) => c.map(() => null));
    await press(m);
    expect(m.writes).toEqual([{ resort: false, auto: true }]); // never a re-sort, never the manual path (no consent question, the ceiling applies)
    expect(m.note()).toMatch(/^1 new post/);
  });
  it("with the automatic write off, sends nothing and says in one line that the texts are not written", async () => {
    const m = await setup(false, (c) => c.map(() => null));
    await press(m);
    expect(m.writes).toEqual([]);
    expect(m.note()).toMatch(/^1 new post · grouped, texts not written \(automatic writing is off\)$/);
  });
  it("with everything written and nothing new, there is nothing to write and nothing is sent", async () => {
    const writes: unknown[] = [];
    const ai: DigestHost["ai"] = { enabled: () => true, autoOn: () => Promise.resolve(true), cached: async (c) => written(c), write: async () => (writes.push(1), { written: [], status: "ok" }) };
    const m = await mount(base, { ai, refresh: () => Promise.resolve({ ok: true, list: { posts: base, mentions: [] } }) });
    await press(m);
    expect(writes).toEqual([]);
    expect((m.view as unknown as { note: string }).note).toBe("Nothing new");
  });
  it("without the AI layer, Refresh writes nothing and says nothing about texts", async () => {
    const m = await mount(base, { refresh: () => Promise.resolve({ ok: true, list: { posts: [...base, fresh], mentions: [] } }) });
    await press(m);
    expect((m.view as unknown as { note: string }).note).toBe("1 new post");
  });
  it("the menu shows one update action; the manual writes are under Advanced", async () => {
    const m = await setup(false, (c) => written(c));
    const panelEntries = (): El[] => m.root.all().filter((e) => has(e, "blyg-daily-entry"));
    const adv = m.root.all().find((e) => has(e, "blyg-daily-advanced"))!;
    expect(adv.tag).toBe("details");
    expect(adv.children[0]!.text).toBe("Advanced");
    const outside = panelEntries().filter((e) => !adv.all().includes(e));
    expect(outside.map((e) => textOf(e.all().find((b) => b.tag === "button")!))).toEqual(["Refresh"]);
    expect(adv.all().filter((b) => b.tag === "button" && !b.cls.has("blyg-mark")).length).toBeGreaterThanOrEqual(1);
    expect(adv.all().some((b) => has(b, "blyg-story-write"))).toBe(true);
  });
});
