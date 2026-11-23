import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FakeEl {
    cls = new Set<string>();
    text = "";
    children: FakeEl[] = [];
    handlers: Array<() => void> = [];
    constructor(public tag = "div") {}
    addClass(c: string) {
      this.cls.add(c);
    }
    toggleClass(c: string, on: boolean) {
      if (on) this.cls.add(c);
      else this.cls.delete(c);
    }
    attrs: Record<string, string> = {};
    setAttr(k: string, v: string) {
      this.attrs[k] = v;
    }
    removeAttribute(k: string) {
      delete this.attrs[k];
    }
    private make(tag: string, o?: { cls?: string; text?: string }) {
      const el = new FakeEl(tag);
      if (o?.cls) o.cls.split(" ").forEach((c) => el.cls.add(c));
      if (o?.text) el.text = o.text;
      this.children.push(el);
      return el;
    }
    createDiv(o?: { cls?: string; text?: string }) {
      return this.make("div", o);
    }
    createSpan(o?: { cls?: string; text?: string }) {
      return this.make("span", o);
    }
    createEl(tag: string, o?: { cls?: string; text?: string }) {
      return this.make(tag, o);
    }
    addEventListener(_t: string, fn: () => void) {
      this.handlers.push(fn);
    }
    click() {
      this.handlers.forEach((h) => h());
    }
    empty() {
      this.children = [];
    }
    all(): FakeEl[] {
      return [this, ...this.children.flatMap((c) => c.all())];
    }
  }
  class ItemView {
    contentEl = new FakeEl();
    constructor(public leaf: unknown) {}
  }
  return { ItemView, setIcon: (el: { attrs?: Record<string, string> }, n: string) => void (el.attrs ??= {}, el.attrs["data-icon"] = n) };
});

import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import { clearScrolls } from "../../src/digest/scrollMemory";
import { Editions } from "../../src/digest/editionHost";
import type { ReadingPost } from "../../src/studio/reading";

// The digest's Refresh adds the new posts to the CURRENT edition with no AI request: a new post joins the story it matches (stable stories) or the Mixed bag, marked
// "new"; the page is drawn once (no "Reading your list…" blank page), the edition's own record keeps its stories. Fake clock, fake Studio, real Editions.
beforeEach(() => clearScrolls());
const NOW = Date.parse("2030-03-10T12:00:00");
const p = (id: string, text: string, over: Partial<ReadingPost> = {}): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Blyg", origin: "https://one.example.com/", remoteId: id.padEnd(26, "x"), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: `<p>${text}</p>`, contentMd: "", authorName: "Ann", authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; cls: Set<string>; children: El[]; click(): void; all(): El[] };
const story = [p("a1", "Harbour tide lantern festival tonight on the quay."), p("a2", "Harbour tide lantern reply from the quay.", { isReply: true, stubTarget: { origin: "https://one.example.com/", id: "a1".padEnd(26, "x") } })];

async function mount(first: ReadingPost[], second: ReadingPost[]) {
  let store: unknown = null;
  const editions = new Editions({ read: () => Promise.resolve(store), write: (t) => Promise.resolve(void (store = JSON.parse(t))), now: () => NOW, time: () => "07:00" });
  const calls = { edition: 0, refresh: 0, write: 0, loadList: 0, held: [] as number[] };
  const host: DigestHost = {
    loadList: () => (calls.loadList++, Promise.resolve({ posts: first, mentions: [], savedAt: NOW })),
    refresh: (o) => (calls.refresh++, calls.held.push(o.held?.posts.length ?? -1), o.status("Checking blygs · 1/1"), Promise.resolve({ ok: true as const, list: { posts: second, mentions: [] } })),
    edition: (posts) => (calls.edition++, editions.open(posts)),
    font: () => "serif",
    showFeed: () => Promise.resolve(),
    openPost: () => Promise.resolve(),
    openWeb: () => undefined,
    ai: { enabled: () => true, cached: () => Promise.resolve([]), write: () => (calls.write++, Promise.reject(new Error("a Refresh must not reach the AI layer"))) },
  };
  const view = new BlygDailyView({} as never, host);
  await view.onOpen();
  const root = (view as unknown as { contentEl: El }).contentEl;
  const tap = async (): Promise<void> => {
    root.all().find((e) => e.cls.has("blyg-daily-refresh"))?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { root, calls, tap, view };
}

describe("the digest's Refresh", () => {
  it("puts a new post into the story it matches and a new unrelated post into the Mixed bag, both marked new, with no AI request", async () => {
    const reply2 = p("a3", "Harbour tide lantern follow up from the quay.", { isReply: true, stubTarget: { origin: "https://one.example.com/", id: "a1".padEnd(26, "x") } });
    const lone = p("z9", "Mushrooms grow quietly under old oak trees in the wood.", { authorName: "Cy" });
    const t = await mount(story, [...story, reply2, lone]);
    const before = t.root.all().map((e) => e.text);
    expect(before).not.toContain("new");
    await t.tap();
    const texts = t.root.all().map((e) => e.text);
    expect(texts.some((x) => /\+1 new post$/.test(x.trim()))).toBe(true); // the story shows its new post
    const rows = t.root.all().filter((e) => e.cls.has("blyg-is-new"));
    expect(rows.length).toBeGreaterThan(0);
    expect(texts).toContain("new"); // the new single post in the Mixed bag
    expect(texts).toContain("2 new posts");
    expect(t.calls.write).toBe(0);
    expect(t.calls.refresh).toBe(1);
    expect(t.calls.loadList).toBe(1); // the saved list was read once, by opening; the tap reads from the Studio
  });
  it("keeps the page element and its bar, says 'Nothing new' when nothing is, and draws once", async () => {
    const t = await mount(story, story);
    const el = t.root;
    await t.tap();
    expect(t.root).toBe(el);
    expect(t.root.all().map((x) => x.text)).toContain("Nothing new");
    expect(t.root.all().map((x) => x.text)).not.toContain("Reading your list…");
    expect(t.calls.edition).toBe(2); // once for opening, once for the tap
  });
  it("ignores a second tap while one is running and shows the busy state on both buttons", async () => {
    let release: (() => void) | null = null;
    const t = await mount(story, story);
    const host = (t.view as unknown as { host: DigestHost }).host;
    host.refresh = () => new Promise((res) => (release = () => res({ ok: true, list: { posts: story, mentions: [] } })));
    const btn = (): El[] => t.root.all().filter((e) => e.cls.has("blyg-daily-refresh") || e.cls.has("blyg-daily-refreshbtn"));
    btn()[0]?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(btn().every((b) => b.cls.has("is-busy"))).toBe(true);
    btn()[0]?.click();
    btn()[1]?.click();
    expect(release).not.toBeNull();
    (release as unknown as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(btn().every((b) => !b.cls.has("is-busy"))).toBe(true);
  });
  it("says what happened when the Studio could not be reached, and leaves the page alone", async () => {
    const t = await mount(story, story);
    (t.view as unknown as { host: DigestHost }).host.refresh = () => Promise.resolve({ ok: false as const, message: "The Studio did not answer." });
    await t.tap();
    expect(t.root.all().map((x) => x.text || (x as unknown as { textContent?: string }).textContent)).toContain("The Studio did not answer."); // (the status line is set in place: textContent)
    expect(t.root.all().some((x) => x.cls.has("blyg-daily-bar"))).toBe(true);
  });
});
