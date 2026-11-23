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
import type { Written } from "../../src/digest/llm";
import type { ReadingPost } from "../../src/studio/reading";

const NOW = Date.parse("2030-03-10T12:00:00Z");
const evil = `<img src=x onerror=alert(1)> & <b>bold</b>`;
const p = (over: Partial<ReadingPost>): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Blyg", origin: "https://one.example.com/", remoteId: "a".repeat(26), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: "<p>Hello there, a long enough sentence.</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; click(): void; all(): El[]; contentEl?: unknown };

async function mount(list: Awaited<ReturnType<DigestHost["loadList"]>>, ai?: DigestHost["ai"]) {
  const opened: string[] = [];
  const leaves: unknown[] = [];
  const host: DigestHost = {
    loadList: () => Promise.resolve(list),
    edition: () => Promise.resolve({ since: NOW - 6 * 3600_000, until: NOW }),
    ...(ai ? { ai } : {}),
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
  it("dims posts already read, and marks a story's new posts with +N and a quiet highlight", async () => {
    const a = p({ remoteId: "a".repeat(26), contentHtml: "<p>Shared topic about gardens and tomatoes in spring.</p>", authorName: "Ann", readVersion: 1 });
    const b = p({ remoteId: "b".repeat(26), isReply: true, stubTarget: { id: a.remoteId } as never, contentHtml: "<p>My tomatoes did badly this spring.</p>", authorName: "Bo" });
    const lone = p({ remoteId: "z".repeat(26), contentHtml: "<p>A lone post nobody answers at all.</p>", authorName: "Cy", readVersion: 1 });
    const ai: DigestHost["ai"] = { enabled: () => true, cached: async () => [{ headline: "Gardens", summary: "Tomatoes.", model: "m", posts: 1, fresh: [b.remoteId] }], write: async () => ({ written: [], status: "ok" }) };
    const { root } = await mount({ posts: [a, b, lone], mentions: [], savedAt: NOW }, ai);
    const cls = (e: unknown): Set<string> => (e as { cls: Set<string> }).cls;
    expect(root.all().some((e) => e.text === " +1 new post")).toBe(true);
    root.all().find((e) => cls(e).has("blyg-daily-headline"))?.click();
    const rows = root.all().filter((e) => cls(e).has("blyg-daily-member"));
    expect(rows.filter((r) => cls(r).has("blyg-is-new"))).toHaveLength(1);
    expect(rows.filter((r) => cls(r).has("blyg-is-read"))).toHaveLength(1); // Ann's post was read; Bo's was not
    expect(root.all().filter((e) => cls(e).has("blyg-story-mixed") && cls(e).has("blyg-is-read"))).toHaveLength(1); // the lone post, read
  });
  it("Write the digest with nothing to send says so, and the button is back", async () => {
    const ai: DigestHost["ai"] = { enabled: () => true, cached: async () => [], write: async () => ({ written: [], status: "nothing-to-send" }) };
    const { root } = await mount({ posts: [p({ authorName: "Ann" })], mentions: [], savedAt: NOW }, ai);
    const btn = root.all().find((e) => (e as unknown as { cls: Set<string> }).cls.has("blyg-story-write"));
    expect(btn).toBeDefined(); // shown even with no story
    btn?.click();
    await new Promise((r) => setTimeout(r, 0));
    const after = root.all();
    expect(after.some((e) => e.text === "Nothing to write. 1 single post is in the Mixed bag; it gets no AI text.")).toBe(true);
    expect(after.some((e) => e.text === "Writing the digest…")).toBe(false);
  });
  it("has no HTML sink in the view or the digest code", () => {
    for (const f of ["src/ui/DigestView.ts", "src/digest/register.ts", "src/digest/daily.ts", "src/digest/cluster.ts", "src/digest/stable.ts", "src/digest/editionHost.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|sanitizeHTMLToDom|createEl\([^)]*\bhtml\b/);
    }
  });
});

describe("the Daily view with sections that hold single posts", () => {
  const cls = (e: unknown): Set<string> => (e as { cls: Set<string> }).cls;
  const words = ["alpha", "beta", "gamma", "delta"];
  const storyPosts = words.flatMap((w, i) => {
    const a = p({ remoteId: `a${i}`.padEnd(26, "x"), contentHtml: `<p>Wholly distinct ${w} subject only here.</p>`, authorName: "Ann" });
    return [a, p({ remoteId: `b${i}`.padEnd(26, "x"), isReply: true, stubTarget: { id: a.remoteId } as never, contentHtml: `<p>Reply ${w}.</p>`, authorName: "Bo" })];
  });
  const lone = [["Cy", "Mushrooms grow quietly under old oak trees."], ["Di", "Trains between cities were delayed again."], ["Ed", "Violin practice requires patient evenings."]].map(([who, text], i) => p({ remoteId: `z${i}`.padEnd(26, "x"), contentHtml: `<p>${text} And a second sentence.</p>`, authorName: who }));
  const written = (i: number): Written => ({ headline: `Story ${i}`, summary: `Summary ${i}.`, model: "m", posts: 2 });
  const list = { posts: [...storyPosts, ...lone], mentions: [], savedAt: NOW };

  it("draws each section's stories first, then its single posts; the Mixed bag holds only the unplaced; a single post opens in the reader", async () => {
    const ai: DigestHost["ai"] = {
      enabled: () => true,
      cached: async (c) => c.map((_, i) => written(i)),
      cachedSections: async (_c, singles) => [
        { name: "Garden", ids: [2], posts: [singles[0]!.remoteId] },
        { name: "Town", ids: [0, 1, 3], posts: [singles[1]!.remoteId] },
      ],
      write: async () => ({ written: [], status: "ok" }),
    };
    const { root, opened } = await mount(list, ai);
    const all = root.all().map((e) => e.text);
    const texts = all.slice(all.indexOf("Front page")); // the table of contents above the page also names the sections (tested below)
    const at = (t: string): number => texts.indexOf(t);
    const garden = at("Garden");
    const town = at("Town");
    const mixed = at("Mixed bag");
    expect(garden).toBeGreaterThan(-1);
    expect(town).toBeGreaterThan(garden);
    expect(mixed).toBeGreaterThan(town);
    // inside "Town": its non-lead story (index 3) and then its single post, before the Mixed bag
    const townPart = texts.slice(town, mixed);
    expect(townPart.indexOf("Story 3")).toBeGreaterThan(-1);
    expect(townPart.some((t) => /^Di$|^Cy$|^Ed$/.test(t))).toBe(true);
    expect(townPart.findIndex((t) => t === "Story 3")).toBeLessThan(townPart.findIndex((t) => /^Di$|^Cy$|^Ed$/.test(t)));
    // exactly one single post is left in the Mixed bag
    const mixedRows = root.all().filter((e) => cls(e).has("blyg-story-mixed"));
    expect(mixedRows).toHaveLength(3); // two in sections, one in the Mixed bag
    const bag = texts.slice(mixed).filter((t) => /^(Cy|Di|Ed)$/.test(t));
    expect(bag).toHaveLength(1);
    // a section row opens the post like every entry
    root.all().find((e) => e.text === "Di" || e.text === "Cy" || e.text === "Ed")?.click();
    expect(opened).toHaveLength(1);
  });
  it("with the AI off the plain Mixed bag holds every single post and no section is drawn", async () => {
    const { root } = await mount(list);
    const texts = root.all().map((e) => e.text);
    expect(texts).toContain("Mixed bag");
    expect(texts).not.toContain("Garden");
    expect(texts.filter((t) => /^(Cy|Di|Ed)$/.test(t))).toHaveLength(3);
    expect(texts).not.toContain("Re-sort sections");
  });
  it("a section the page cannot match is cleaned: unknown numbers and posts dropped, a story no section holds goes to Other", async () => {
    const ai: DigestHost["ai"] = {
      enabled: () => true,
      cached: async (c) => c.map((_, i) => written(i)),
      cachedSections: async () => [{ name: "Garden", ids: [2, 99], posts: ["nobody".padEnd(26, "x")] }],
      write: async () => ({ written: [], status: "ok" }),
    };
    const { root } = await mount(list, ai);
    const texts = root.all().map((e) => e.text);
    expect(texts).toContain("Other");
    expect(texts.filter((t) => /^(Cy|Di|Ed)$/.test(t))).toHaveLength(3); // all still in the Mixed bag
  });
  it("Re-sort sections asks for a full sort; the plain Write does not", async () => {
    const calls: Array<{ resort?: boolean } | undefined> = [];
    const ai: DigestHost["ai"] = {
      enabled: () => true,
      cached: async (c) => c.map((_, i) => written(i)),
      cachedSections: async () => [{ name: "Garden", ids: [0, 1, 2, 3] }],
      write: async (c, _s, opts) => (calls.push(opts), { written: c.map((_, i) => written(i)), sections: [{ name: "Garden", ids: [0, 1, 2, 3] }], status: "ok" }),
    };
    const { root } = await mount(list, ai);
    root.all().find((e) => cls(e).has("blyg-story-write"))?.click();
    await new Promise((r) => setTimeout(r, 0));
    root.all().find((e) => e.text === "Re-sort sections")?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c?.resort === true)).toEqual([false, true]);
  });
});
