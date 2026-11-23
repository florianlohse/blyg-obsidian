import { describe, expect, it, vi } from "vitest";
import { mastheadDate, ordinal } from "../../src/digest/window";
import { GROUPING_NOTE, previewOf, summarizeRest } from "../../src/digest/layout";
import { FRONT_PAGE_MAX } from "../../src/digest/daily";
import { MIN_SHARED_TERMS, type Cluster } from "../../src/digest/cluster";
import type { ReadingPost } from "../../src/studio/reading";

vi.mock("obsidian", () => ({ ItemView: class {} }));
import { ReturnPoint } from "../../src/ui/readerExtras";

const post = (id: string, html = "<p>Some words here.</p>"): ReadingPost =>
  ({ subscriptionId: "s", subscriptionTitle: "B", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "2030-03-10T10:00:00Z", created: null, isReply: false, stubTarget: null, contentHtml: html, contentMd: "", authorName: null, authorUrl: null, sourceUrl: null });
const cluster = (...ids: string[]): Cluster => ({ posts: ids.map((i) => post(i)), newest: 0, headline: "h", terms: [] });

describe("the masthead", () => {
  it("names the weekday and the date in the given locale", () => {
    const t = new Date(2030, 2, 10, 12).getTime();
    expect(mastheadDate(t, "en-US")).toBe("Sunday, March 10th, 2030");
    expect(mastheadDate(t, "de-DE")).toBe("Sonntag, 10. März 2030");
  });
  it("uses English ordinals for every edge of the month", () => {
    const want: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 10: "10th", 11: "11th", 12: "12th", 13: "13th", 14: "14th", 20: "20th", 21: "21st", 22: "22nd", 23: "23rd", 24: "24th", 30: "30th", 31: "31st" };
    for (const [day, text] of Object.entries(want)) {
      expect(ordinal(Number(day))).toBe(text);
      expect(mastheadDate(new Date(2030, 0, Number(day), 12).getTime(), "en-US")).toContain(`January ${text}, 2030`);
    }
    expect(mastheadDate(new Date(2026, 10, 23, 12).getTime(), "en-GB")).toBe("Monday, 23rd November 2026");
  });
});

describe("what is not in the Top stories", () => {
  it("is empty when nothing is left over", () => {
    expect(summarizeRest([])).toEqual({ line: "", posts: [] });
  });
  it("counts the stories beyond the front page", () => {
    const r = summarizeRest([cluster("a", "b"), cluster("c", "d", "e")]);
    expect(r.line).toBe("2 more stories (5 posts) not in the Top stories");
    expect(r.posts.map((p) => p.remoteId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(summarizeRest([cluster("a", "b")]).line).toBe("1 more story (2 posts) not in the Top stories");
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
