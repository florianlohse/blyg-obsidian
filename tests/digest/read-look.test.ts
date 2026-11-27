// HX2: a read story or post is clearly read in the Daily: dimmed text that still passes WCAG AA, plus a filled check disc.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("styles.css", "utf8");
type Rgb = [number, number, number];
const lin = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: Rgb): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: Rgb, b: Rgb): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const mix = (f: Rgb, g: Rgb, pct: number): Rgb => [f[0] * pct + g[0] * (1 - pct), f[1] * pct + g[1] * (1 - pct), f[2] * pct + g[2] * (1 - pct)];

describe("HX2: the read look of the Daily", () => {
  const pct = Number(/--blyg-read-text: color-mix\(in srgb, var\(--text-normal\) (\d+)%, var\(--background-primary\)\)/.exec(css)?.[1]) / 100;
  it("dims read text, and the dimmed text stays above WCAG AA (4.5:1) in Obsidian's light and dark themes", () => {
    expect(pct).toBeGreaterThan(0.5);
    for (const [fg, bg] of [[[0x22, 0x22, 0x22], [255, 255, 255]], [[0xda, 0xda, 0xda], [0x1e, 0x1e, 0x1e]]] as Array<[Rgb, Rgb]>) {
      expect(ratio(mix(fg, bg, pct), bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(mix(fg, bg, pct), bg)).toBeLessThan(ratio(fg, bg) - 3); // clearly below the unread text
    }
  });
  it("puts a filled check disc before a read story's headline and a read lone post's line, and fills the mark of a read post row", () => {
    expect(css).toMatch(/\.blyg-story\.blyg-is-read > button\.blyg-story-headline::before, \.blyg-story-mixed\.blyg-is-read button\.blyg-story-line::before \{[^}]*border-radius: 50%[^}]*background: var\(--interactive-accent\)/);
    expect(css).toMatch(/button\.blyg-mark\.is-read svg \{ fill: var\(--interactive-accent\)/);
    expect(css).toMatch(/\.blyg-story\.blyg-is-read > button\.blyg-story-headline[^{]*\{ color: var\(--blyg-read-text\)/);
  });
});
