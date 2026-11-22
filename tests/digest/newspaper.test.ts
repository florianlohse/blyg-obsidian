import { describe, expect, it, vi } from "vitest";
import { startOfLocalDay, mastheadDate } from "../../src/digest/window";
import { GROUPING_NOTE, previewOf, summarizeRest } from "../../src/digest/layout";
import { FRONT_PAGE_MAX } from "../../src/digest/daily";
import { MIN_SHARED_TERMS, type Cluster } from "../../src/digest/cluster";
import type { ReadingPost } from "../../src/studio/reading";

vi.mock("obsidian", () => ({ ItemView: class {} }));
import { drawViewSwitch, ReturnPoint } from "../../src/ui/readerExtras";

const post = (id: string, html = "<p>Some words here.</p>"): ReadingPost =>
  ({ subscriptionId: "s", subscriptionTitle: "B", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2030-03-10T10:00:00Z", created: null, isReply: false, stubTarget: null, contentHtml: html, contentMd: "", authorName: null, authorUrl: null, sourceUrl: null });
const cluster = (...ids: string[]): Cluster => ({ posts: ids.map((i) => post(i)), newest: 0, headline: "h", terms: [] });

describe("the day and its masthead", () => {
  it("starts at local midnight", () => {
    const t = new Date(2030, 2, 10, 15, 30).getTime();
    expect(startOfLocalDay(t)).toBe(new Date(2030, 2, 10).getTime());
  });
  it("names the weekday and the date in the given locale", () => {
    const t = new Date(2030, 2, 10, 12).getTime();
    expect(mastheadDate(t, "en-US")).toBe("Sunday, March 10, 2030");
    expect(mastheadDate(t, "de-DE")).toBe("Sonntag, 10. März 2030");
  });
});

describe("what is not on the front page", () => {
  it("is empty when nothing is left over", () => {
    expect(summarizeRest([])).toEqual({ line: "", posts: [] });
  });
  it("counts single posts, not groups", () => {
    const r = summarizeRest([cluster("a"), cluster("b"), cluster("c")]);
    expect(r.line).toBe("3 single posts, not grouped");
    expect(r.posts.map((p) => p.remoteId)).toEqual(["a", "b", "c"]);
    expect(summarizeRest([cluster("a")]).line).toBe("1 single post, not grouped");
  });
  it("says so when smaller groups are among them", () => {
    const r = summarizeRest([cluster("a", "b"), cluster("c")]);
    expect(r.line).toBe("1 single post, not grouped; 1 smaller group (2 posts) not on the front page");
    expect(summarizeRest([cluster("a", "b")]).line).toBe("1 smaller group (2 posts) not on the front page");
  });
});

describe("previews and the grouping note", () => {
  it("cuts a preview at a word and keeps short ones whole", () => {
    expect(previewOf(post("a", "<p>Short one.</p>"))).toBe("Short one.");
    const long = previewOf(post("a", `<p>${"word ".repeat(100)}</p>`), 50);
    expect(long.length).toBeLessThanOrEqual(51);
    expect(long.endsWith("…")).toBe(true);
  });
  it("leaves out what a post quotes", () => {
    const html = `<blockquote class="blyg-transclusion" data-blyg-id="x"><p>Their words.</p></blockquote><p>My words.</p>`;
    expect(previewOf(post("a", html))).toBe("My words.");
  });
  it("names the numbers the code uses", () => {
    const text = GROUPING_NOTE.join(" ");
    expect(text).toContain(String(FRONT_PAGE_MAX));
    expect(text).toContain(String(MIN_SHARED_TERMS));
    expect(text).toMatch(/repl/);
    expect(text).toMatch(/quote the same item/);
  });
});

describe("the way back to the digest", () => {
  it("returns once, then is spent", () => {
    const r = new ReturnPoint();
    expect(r.active).toBe(false);
    expect(r.run()).toBe(false);
    const go = vi.fn();
    r.set(go);
    expect(r.active).toBe(true);
    expect(r.run()).toBe(true);
    expect(go).toHaveBeenCalledTimes(1);
    expect(r.active).toBe(false);
    expect(r.run()).toBe(false);
  });
});

describe("the Feed / Digest switch in Sort & filter", () => {
  it("shows the digest in the same leaf when Digest is pressed", () => {
    const handlers = new Map<string, () => void>();
    const el = (): Record<string, unknown> => ({
      createDiv: () => el(),
      createEl: (_t: string, o: { text: string }) => ({ ...el(), addEventListener: (_e: string, fn: () => void) => handlers.set(o.text, fn) }),
      setAttr: () => undefined,
    });
    const setViewState = vi.fn(() => Promise.resolve());
    drawViewSwitch(el() as never, { setViewState });
    expect([...handlers.keys()]).toEqual(["Digest"]);
    handlers.get("Digest")?.();
    expect(setViewState).toHaveBeenCalledWith({ type: "blyg-daily", active: true });
  });
});
