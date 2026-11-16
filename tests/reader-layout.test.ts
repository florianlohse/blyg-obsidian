// S15: the reader's bottom clearance. The tablet layout once gave the pane a padding as high as the pane itself (a hidden bar measured as a box of size zero at the origin).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bottomClearance, type Box } from "../src/ui/readerLayout";

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height });
const pane = box(0, 151, 820, 1331); // the iPad pane that was measured: 151 to 1482

describe("bottomClearance", () => {
  it("is nothing when there is no bar", () => {
    expect(bottomClearance(pane, null)).toBeNull();
  });
  it("is nothing for a bar that is not drawn (display none: a box of size zero at the origin)", () => {
    expect(bottomClearance(pane, box(0, 0, 0, 0))).toBeNull();
    expect(bottomClearance(pane, box(0, 0, 820, 0))).toBeNull();
    expect(bottomClearance(pane, box(0, 0, 0, 60))).toBeNull();
  });
  it("is the part of the pane the floating bar covers, rounded up (the phone)", () => {
    const phonePane = box(0, 100, 393, 752);
    expect(bottomClearance(phonePane, box(10, 780.2, 373, 56))).toBe(72);
    expect(bottomClearance(phonePane, box(10, 852 - 56, 373, 56))).toBe(56);
  });
  it("is nothing for a bar below the pane, above it, or beside it", () => {
    expect(bottomClearance(pane, box(0, 1482, 820, 60))).toBeNull();
    expect(bottomClearance(pane, box(0, 0, 820, 100))).toBeNull();
    expect(bottomClearance(box(300, 0, 400, 800), box(0, 740, 280, 60))).toBeNull();
    expect(bottomClearance(box(0, 0, 400, 800), box(420, 740, 280, 60))).toBeNull();
  });
  it("never exceeds the height of the pane", () => {
    expect(bottomClearance(box(0, 700, 393, 100), box(0, 0, 393, 900))).toBe(100);
  });
});

describe("the stylesheet", () => {
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  it("falls back to the phone's bar height only on a phone, never on a tablet (which has no bar)", () => {
    expect(styles).toContain(".is-phone .view-content.blyg-reader { padding-bottom: var(--blyg-bottom-clear, calc(var(--mobile-navbar-height, 0px) + env(safe-area-inset-bottom, 0px))); }");
    expect(styles).not.toContain(".is-mobile .view-content.blyg-reader");
  });
});
