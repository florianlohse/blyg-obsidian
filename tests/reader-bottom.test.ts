// S15: how far Obsidian's bottom bar reaches into the reader pane (a phone has the bar, a tablet has it in the DOM but not displayed).
import { describe, expect, it } from "vitest";
import { bottomClearance, type EdgeRect } from "../src/ui/readerBottom";

const rect = (top: number, height: number, width = 300): EdgeRect => ({ top, bottom: top + height, width, height });
const pane = rect(100, 1200, 800);

describe("bottomClearance", () => {
  it("a bar floating over the bottom of the pane: the pane clears the part that overlaps, rounded up", () => {
    expect(bottomClearance(pane, { rect: rect(1240, 60), hidden: false })).toBe(60);
    expect(bottomClearance(pane, { rect: rect(1240.4, 60), hidden: false })).toBe(60);
    expect(bottomClearance(pane, { rect: rect(1200.2, 100), hidden: false })).toBe(100);
  });
  it("a bar below the pane overlaps nothing", () => {
    expect(bottomClearance(pane, { rect: rect(1300, 60), hidden: false })).toBe(0);
    expect(bottomClearance(pane, { rect: rect(1500, 60), hidden: false })).toBe(0);
  });
  it("a bar that is not displayed is absent: the tablet's display:none bar (all-zero rectangle) does not eat the pane", () => {
    expect(bottomClearance(pane, { rect: rect(0, 0, 0), hidden: false })).toBeNull();
    expect(bottomClearance(pane, { rect: rect(0, 0, 0), hidden: true })).toBeNull();
  });
  it("a bar flagged hidden is absent even when it still has a rectangle (visibility: hidden)", () => {
    expect(bottomClearance(pane, { rect: rect(1240, 60), hidden: true })).toBeNull();
  });
  it("a rectangle with no width or no height is absent", () => {
    expect(bottomClearance(pane, { rect: rect(1240, 60, 0), hidden: false })).toBeNull();
    expect(bottomClearance(pane, { rect: rect(1240, 0), hidden: false })).toBeNull();
  });
  it("a bar whose top is not below the pane's top is not a bottom bar: absent, not the whole pane", () => {
    expect(bottomClearance(pane, { rect: rect(100, 60), hidden: false })).toBeNull();
    expect(bottomClearance(pane, { rect: rect(20, 60), hidden: false })).toBeNull();
    expect(bottomClearance(pane, { rect: rect(-500, 3000), hidden: false })).toBeNull();
  });
  it("never negative", () => {
    expect(bottomClearance(rect(0, 500), { rect: rect(900, 60), hidden: false })).toBe(0);
  });
});
