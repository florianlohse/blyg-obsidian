// DG14: stories are typography, not boxes. The tap mark is a hidden "›" in the meta line, aria-expanded stays on the headline and summary, and the stylesheet draws no card.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addStoryMark } from "../../src/ui/storyOpen";

class El {
  cls = new Set<string>();
  attrs: Record<string, string> = {};
  kids: Array<{ cls: string; text: string; attr: Record<string, string> }> = [];
  toggleClass(c: string, on: boolean) { if (on) this.cls.add(c); else this.cls.delete(c); }
  setAttr(k: string, v: string) { this.attrs[k] = v; }
  createSpan(o: { cls: string; text: string; attr: Record<string, string> }) { this.kids.push(o); return this; }
}

describe("the story's tap mark and open state", () => {
  it("adds one hidden › to the meta line, no button and no icon, and paints open/closed on the story and its controls", () => {
    const story = new El(), meta = new El(), head = new El(), summary = new El();
    const paint = addStoryMark(story as never, meta as never, [head as never, summary as never]);
    expect(meta.kids).toEqual([{ cls: "blyg-story-more", text: "›", attr: { "aria-hidden": "true" } }]);
    paint(true);
    expect(story.cls.has("is-open")).toBe(true);
    expect([head.attrs["aria-expanded"], summary.attrs["aria-expanded"]]).toEqual(["true", "true"]);
    paint(false);
    expect(story.cls.has("is-open")).toBe(false);
    expect([head.attrs["aria-expanded"], summary.attrs["aria-expanded"]]).toEqual(["false", "false"]);
  });
});

describe("the stylesheet", () => {
  const css = readFileSync("styles.css", "utf8");
  it("has no chevron and sets no background, radius or shadow on a story", () => {
    expect(css).not.toMatch(/blyg-story-chevron/);
    const rules = css.split("\n").filter((l) => /^\.blyg-daily-cluster\.blyg-story[^{]*\{/.test(l));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/background:\s+(?!none)\S|border-radius:\s*[1-9]|box-shadow:\s+(?!none)\S/);
  });
});
