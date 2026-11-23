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
  it("Sort & filter has its own row, after the tabs row, and the toggle is drawn before it", () => {
    const src = readFileSync("src/ui/ReaderView.ts", "utf8");
    expect(src.indexOf("drawModeToggle(row")).toBeLessThan(src.indexOf("drawFilterRow(h"));
    expect(readFileSync("src/ui/readerHeader.ts", "utf8")).toMatch(/Sort & filter/);
  });
  it("the step counter gives way (an ellipsis on the title), Reply and the steps do not move", () => {
    expect(rule(".blyg-reader-stepcount .blyg-reader-steptitle")).toMatch(/min-width: 0/);
    expect(rule(".blyg-reader-stepcount .blyg-reader-steptitle")).toMatch(/text-overflow: ellipsis/);
    expect(rule(".blyg-reader-stepcount .blyg-reader-steptitle")).toMatch(/max-width: 7em/);
    expect(css).toMatch(/\.blyg-reader-bar-thumb > \.blyg-reader-stepcount \{[^}]*flex: 0 1 auto; min-width: 0/);
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
