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
  const commits: number[] = [];
  const host: DigestHost = {
    loadList: () => Promise.resolve(list),
    window: () => Promise.resolve({ since: NOW - 86_400_000, until: NOW, commit: () => Promise.resolve(void commits.push(1)) }),
    openPost: (post) => Promise.resolve(void opened.push(post.remoteId)),
    openWeb: () => undefined,
  };
  const view = new BlygDailyView({} as never, host);
  await view.onOpen();
  const root = (view as unknown as { contentEl: El }).contentEl;
  return { root, opened, commits };
}

describe("the Daily view", () => {
  it("shows foreign text as text only, and remembers the opening after showing a list", async () => {
    const { root, commits } = await mount({ posts: [p({ contentHtml: `<p>${evil.replace(/</g, "&lt;").replace(/>/g, "&gt;")} is the headline here.</p>`, authorName: "Ann" })], mentions: [], savedAt: NOW });
    const texts = root.all().map((e) => e.text).join("\n");
    expect(texts).toContain("<img src=x onerror=alert(1)>");
    expect(texts).toContain("Front page");
    expect(root.all().every((e) => ["div", "h2", "h3", "button"].includes(e.tag))).toBe(true); // no element is made from the post's markup
    expect(commits).toHaveLength(1);
  });
  it("opens a post from a single-post cluster", async () => {
    const { root, opened } = await mount({ posts: [p({})], mentions: [], savedAt: NOW });
    root.all().find((e) => e.text.startsWith("Hello there"))?.click();
    expect(opened).toEqual(["a".repeat(26)]);
  });
  it("says so when there is no saved list, and does not remember an opening", async () => {
    const { root, commits } = await mount(null);
    expect(root.all().some((e) => e.text.includes("no saved list"))).toBe(true);
    expect(commits).toHaveLength(0);
  });
  it("has no HTML sink in the view or the digest code", () => {
    for (const f of ["src/ui/DigestView.ts", "src/digest/register.ts", "src/digest/daily.ts", "src/digest/cluster.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|sanitizeHTMLToDom|createEl\([^)]*\bhtml\b/);
    }
  });
});
