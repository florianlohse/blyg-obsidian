// DG14 / DG19: stories are typography, not boxes. The tap mark is a "+" (a "−" once open) at the right end of the meta line, aria-expanded stays on the headline and summary, and the stylesheet draws no card and no accent.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addStoryMark } from "../../src/ui/storyOpen";

class El {
  cls = new Set<string>();
  attrs: Record<string, string> = {};
  kids: El[] = [];
  textContent = "";
  handlers: Array<(e?: unknown) => void> = [];
  toggleClass(c: string, on: boolean) { if (on) this.cls.add(c); else this.cls.delete(c); }
  addClass(c: string) { this.cls.add(c); }
  setAttr(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(_t: string, f: (e?: unknown) => void) { this.handlers.push(f); }
  createEl(tag: string, o: { cls: string; text: string; attr: Record<string, string> }) { const e = new El(); e.tag = tag; o.cls.split(" ").forEach((c) => e.cls.add(c)); e.textContent = o.text; Object.assign(e.attrs, o.attr); this.kids.push(e); return e; }
  tag = "div";
}

describe("the story's tap mark and open state", () => {
  it("adds one '+' button to the meta line (no new line, no icon), a '−' while open, and paints open/closed on the story and its controls", () => {
    const story = new El(), meta = new El(), head = new El(), summary = new El();
    let toggled = 0;
    const paint = addStoryMark(story as never, meta as never, [head as never, summary as never], () => void toggled++);
    expect(meta.kids).toHaveLength(1);
    const mark = meta.kids[0] as El;
    expect([mark.tag, mark.textContent, [...mark.cls]]).toEqual(["button", "+", ["blyg-story-more"]]);
    expect(meta.cls.has("blyg-story-metaline")).toBe(true);
    mark.handlers[0]?.({ stopPropagation: () => undefined });
    expect(toggled).toBe(1); // the marker folds and unfolds like a tap on the headline
    paint(true);
    expect(story.cls.has("is-open")).toBe(true);
    expect(mark.textContent).toBe("−");
    expect(mark.attrs["aria-expanded"]).toBe("true");
    expect([head.attrs["aria-expanded"], summary.attrs["aria-expanded"]]).toEqual(["true", "true"]);
    paint(false);
    expect(story.cls.has("is-open")).toBe(false);
    expect(mark.textContent).toBe("+");
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
  it("DG19: the headline and the marker never take the accent colour (open, hovered or pressed); a press is underline and lighter text; no tap highlight", () => {
    const rules = css.split("\n").filter((l) => /^\.blyg-story[^{]*(headline|summary|more)[^{]*\{/.test(l) || /^button\.blyg-story-more[^{]*\{/.test(l));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r, r).not.toMatch(/text-accent/);
    expect(css).not.toMatch(/\.blyg-story\.is-open [^{]*\{[^}]*text-accent/);
    expect(css).toMatch(/\.blyg-story button \{ -webkit-tap-highlight-color: transparent; \}/);
    expect(css).toMatch(/\.blyg-story > button\.blyg-story-headline:active[^{]*\{ color: var\(--text-muted\); text-decoration: underline; \}/);
  });
});
