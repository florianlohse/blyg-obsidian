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
  it("opens a post from a single-post cluster, in this leaf", async () => {
    const { root, opened, leaves, leaf } = await mount({ posts: [p({})], mentions: [], savedAt: NOW });
    root.all().find((e) => e.text.startsWith("Hello there"))?.click();
    expect(opened).toEqual(["a".repeat(26)]);
    expect(leaves).toEqual([leaf]);
  });
  it("says so when there is no saved list", async () => {
    const { root } = await mount(null);
    expect(root.all().some((e) => e.text.includes("no saved list"))).toBe(true);
  });
  it("unfolds a group into previews and has no Web button", async () => {
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
  it("says how many posts are not grouped and lists them collapsed", async () => {
    const posts = Array.from({ length: 17 }, (_, i) => p({ remoteId: String.fromCharCode(97 + i).repeat(26), contentHtml: `<p>Wholly distinct ${["alpha", "beta", "gamma", "delta", "kappa", "sigma", "omega", "theta", "iota", "zeta", "eta", "rho", "tau", "phi", "chi", "psi", "nu"][i]} subject only.</p>` }));
    const { root } = await mount({ posts, mentions: [], savedAt: NOW });
    expect(root.all().some((e) => /^2 single posts, not grouped/.test(e.text))).toBe(true);
    expect(root.all().some((e) => e.text === "Other posts (2)")).toBe(true);
    expect(root.all().some((e) => e.text === "How this is grouped")).toBe(true);
  });
  it("has no HTML sink in the view or the digest code", () => {
    for (const f of ["src/ui/DigestView.ts", "src/digest/register.ts", "src/digest/daily.ts", "src/digest/cluster.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|sanitizeHTMLToDom|createEl\([^)]*\bhtml\b/);
    }
  });
});
