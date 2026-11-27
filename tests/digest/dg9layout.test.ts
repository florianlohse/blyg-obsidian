// DG9 layout parity: CSS pins (the real measurement is in the real-Obsidian scenario `daily`), and the header pieces.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("styles.css", "utf8");
const rule = (sel: string): string => {
  const i = css.indexOf(`${sel} {`);
  expect(i, sel).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf("}", i));
};

describe("DG9: one slot for the toggle, one header for the open post", () => {
  it("the toggle sits at the right end of its row whatever else is drawn", () => {
    expect(rule(".blyg-modeslot")).toMatch(/margin-left: auto/);
    expect(rule(".blyg-modeslot")).toMatch(/flex: none/);
    expect(rule(".blyg-daily-head > .blyg-modeslot")).toMatch(/order: 99/);
    expect(readFileSync("src/ui/readerMode.ts", "utf8")).toMatch(/blyg-modeswitch blyg-modeslot/);
  });
  it("the first row ends the same way in the feed and the Daily: menu, Refresh, then the toggle (HX1); the menu holds Sort & filter, Sources and Settings", () => {
    const src = readFileSync("src/ui/ReaderView.ts", "utf8");
    const feed = src.slice(src.indexOf("private drawFeedHeader"));
    expect(feed.indexOf("drawMenuButton(row")).toBeLessThan(feed.indexOf('cls: "blyg-reader-refresh"'));
    expect(feed.indexOf('cls: "blyg-reader-refresh"')).toBeLessThan(feed.indexOf("drawModeToggle(row"));
    expect(feed.indexOf("drawModeToggle(row")).toBeLessThan(feed.indexOf("drawMenuPanel(h"));
    expect(feed.indexOf('cls: "blyg-reader-refresh"')).toBeLessThan(feed.indexOf('cls: "blyg-reader-statusrow"'));
    const bar = readFileSync("src/ui/DigestBar.ts", "utf8");
    expect(bar.indexOf("blyg-daily-menu")).toBeLessThan(bar.indexOf("blyg-daily-refresh"));
    expect(bar.indexOf("blyg-daily-refresh")).toBeLessThan(bar.indexOf("drawModeToggle("));
    expect(css).toMatch(/\.blyg-reader-header button\.blyg-reader-menubtn \{[^}]*width: 44px/);
    expect(css).toMatch(/\.blyg-daily-barrow \{ --blyg-ctl-h: 44px/);
    const menu = readFileSync("src/ui/readerMenu.ts", "utf8");
    for (const label of ["Sort & filter", "Sources", "Settings"]) expect(menu).toContain(`label: "${label}"`);
  });
  it("the step counter gives way (an ellipsis on the list's name, never on the numbers), Reply and the steps do not move", () => {
    expect(rule(".blyg-reader-stepcount .blyg-reader-steptitle")).toMatch(/min-width: 0/);
    expect(rule(".blyg-reader-stepcount .blyg-reader-steptitle")).toMatch(/text-overflow: ellipsis/);
    expect(rule(".blyg-reader-bar-main > .blyg-reader-stepcount .blyg-reader-stepnum")).toMatch(/flex: none/);
    expect(rule(".blyg-reader-bar-main > .blyg-reader-stepcount")).toMatch(/flex: 1 1 0; min-width: 0/);
    expect(rule(".blyg-reader-bar-thumb .blyg-reader-replybtn ~ .blyg-reader-spacer")).toMatch(/flex: 0 0/);
    expect(rule(".blyg-reader-bar-thumb .blyg-reader-check, .blyg-reader-bar-thumb .blyg-reader-replybtn, .blyg-reader-bar-thumb .blyg-reader-steps")).toMatch(/flex: none/);
  });
  it("nothing in the reader scrolls sideways, and quotes do not widen the column", () => {
    expect(css).toMatch(/\.view-content\.blyg-reader \{[^}]*overflow-x: hidden/);
    expect(css).toMatch(/\.blyg-reader-scroll \{[^}]*overflow-x: hidden/);
    expect(css).toMatch(/\.blyg-reader-column \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.blyg-reader-surface \.blyg-reader-body blockquote, [^{]*\{[^}]*max-width: 100%/);
  });
});
