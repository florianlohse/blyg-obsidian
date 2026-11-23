import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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
  return { ItemView };
});

import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import type { ReadingPost } from "../../src/studio/reading";

const NOW = Date.parse("2030-03-10T12:00:00Z");
const evil = `<img src=x onerror=alert(1)> & <b>bold</b>`;
const p = (over: Partial<ReadingPost>): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Blyg", origin: "https://one.example.com/", remoteId: "a".repeat(26), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: "<p>Hello there, a long enough sentence.</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; click(): void; all(): El[]; contentEl?: unknown };

async function mount(list: Awaited<ReturnType<DigestHost["loadList"]>>) {
  const opened: string[] = [];
  const leaves: unknown[] = [];
  const host: DigestHost = {
    loadList: () => Promise.resolve(list),
    window: () => Promise.resolve({ since: NOW - 6 * 3600_000, until: NOW }),
    font: () => "serif",
    showFeed: () => Promise.resolve(),
    openPost: (post, leaf) => Promise.resolve(void (opened.push(post.remoteId), leaves.push(leaf))),
    openWeb: () => undefined,
  };
  const leaf = { id: "leaf" };
  const view = new BlygDailyView(leaf as never, host);
  await view.onOpen();
  const root = (view as unknown as { contentEl: El }).contentEl;
  return { root, opened, leaves, leaf };
}

describe("the Daily view", () => {
  it("shows foreign text as text only", async () => {
    const { root } = await mount({ posts: [p({ contentHtml: `<p>${evil.replace(/</g, "&lt;").replace(/>/g, "&gt;")} is the headline here.</p>`, authorName: "Ann" })], mentions: [], savedAt: NOW });
    const texts = root.all().map((e) => e.text).join("\n");
    expect(texts).toContain("<img src=x onerror=alert(1)>");
    expect(texts).toContain("Front page");
    expect(root.all().every((e) => ["div", "h1", "h3", "button", "details", "summary", "p"].includes(e.tag))).toBe(true); // no element is made from the post's markup
    expect((root as unknown as { cls: Set<string> }).cls.has("is-font-serif")).toBe(true); // the type follows the reader's font
  });
  it("opens a single post from the Mixed bag, in this leaf", async () => {
    const { root, opened, leaves, leaf } = await mount({ posts: [p({})], mentions: [], savedAt: NOW });
    root.all().find((e) => e.text === "Blyg")?.click(); // the row's author button (here the blyg's title)
    expect(opened).toEqual(["a".repeat(26)]);
    expect(leaves).toEqual([leaf]);
  });
  it("says so when there is no saved list", async () => {
    const { root } = await mount(null);
    expect(root.all().some((e) => e.text.includes("no saved list"))).toBe(true);
  });
  it("unfolds a story into previews and has no Web button", async () => {
    const a = p({ remoteId: "a".repeat(26), contentHtml: "<p>Shared topic about gardens and tomatoes in spring.</p>", authorName: "Ann" });
    const b = p({ remoteId: "b".repeat(26), isReply: true, stubTarget: { id: a.remoteId } as never, contentHtml: "<p>My tomatoes did badly this spring, sadly.</p>", authorName: "Bo" });
    const { root, opened } = await mount({ posts: [a, b], mentions: [], savedAt: NOW });
    root.all().find((e) => (e as unknown as { cls: Set<string> }).cls.has("blyg-daily-headline"))?.click();
    const texts = root.all().map((e) => e.text);
    expect(texts).toContain("Bo (reply)");
    expect(texts.some((t) => t.startsWith("My tomatoes did badly"))).toBe(true);
    expect(texts).not.toContain("Web");
    root.all().find((e) => e.text === "Bo (reply)")?.click();
    expect(opened).toEqual(["b".repeat(26)]);
  });
  it("puts single posts in the Mixed bag and says so when no story has several posts", async () => {
    const { root } = await mount({ posts: [p({ authorName: "Ann" })], mentions: [], savedAt: NOW });
    const texts = root.all().map((e) => e.text);
    expect(texts).toContain("No stories with several posts yet.");
    expect(texts).toContain("Mixed bag");
    expect(texts).toContain("Ann");
    expect(texts).toContain("How this is grouped");
    expect(texts.some((t) => /\bgroups?\b/i.test(t))).toBe(false);
  });
  it("lists stories on the front page and the rest of the posts below, with the 15-story cap", async () => {
    const words = ["alpha", "beta", "gamma", "delta", "kappa", "sigma", "omega", "theta", "iota", "zeta", "eta", "rho", "tau", "phi", "chi", "psi", "nu"];
    const posts = words.flatMap((w, i) => {
      const a = p({ remoteId: `a${i}`.padEnd(26, "x"), contentHtml: `<p>Wholly distinct ${w} subject only here.</p>`, authorName: "Ann" });
      return [a, p({ remoteId: `b${i}`.padEnd(26, "x"), isReply: true, stubTarget: { id: a.remoteId } as never, contentHtml: `<p>Reply ${w}.</p>`, authorName: "Bo" })];
    });
    const { root } = await mount({ posts: [...posts, p({ remoteId: "z".repeat(26), contentHtml: "<p>A lone post nobody answers at all.</p>", authorName: "Cy" })], mentions: [], savedAt: NOW });
    expect(root.all().filter((e) => (e as unknown as { cls: Set<string> }).cls.has("blyg-story")).length).toBe(15);
    expect(root.all().some((e) => /^2 more stories \(4 posts\)/.test(e.text))).toBe(true);
    expect(root.all().some((e) => e.text === "Mixed bag")).toBe(true);
  });
  it("sets each headline in the reader's font", async () => {
    const a = p({ remoteId: "a".repeat(26), contentHtml: "<p>Shared topic about gardens and tomatoes in spring.</p>", authorName: "Ann" });
    const b = p({ remoteId: "b".repeat(26), isReply: true, stubTarget: { id: a.remoteId } as never, contentHtml: "<p>My tomatoes did badly this spring.</p>", authorName: "Bo" });
    const { root } = await mount({ posts: [a, b], mentions: [], savedAt: NOW });
    const h = root.all().find((e) => (e as unknown as { cls: Set<string> }).cls.has("blyg-story-headline")) as unknown as { cls: Set<string> };
    expect(h.cls.has("blyg-story-font-serif")).toBe(true); // the test host's font() is "serif"
    expect(root.all().some((e) => e.text === "2 posts in 1 blyg · by Ann, Bo" || e.text.startsWith("2 posts in 1 blyg · by Ann, Bo"))).toBe(true);
  });
  it("has no HTML sink in the view or the digest code", () => {
    for (const f of ["src/ui/DigestView.ts", "src/digest/register.ts", "src/digest/daily.ts", "src/digest/cluster.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|sanitizeHTMLToDom|createEl\([^)]*\bhtml\b/);
    }
  });
});
