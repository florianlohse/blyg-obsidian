// S15 chunk 2a: the reader's font for a post's content: the stacks, the web page document, the stylesheet, the setting.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/settings/migrate";
import { defaultSettings } from "../src/settings/schema";
import { FONT_LABELS, isReaderFont, READER_FONTS } from "../src/ui/readerFonts";
import { trimmedDocument } from "../src/ui/trimmedPage";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/studio/pages/${name}-0.51.0.html`, import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("the font stacks", () => {
  it("styles.css has exactly the stack of each font for the text view (the two places are kept in step by this test)", () => {
    for (const [font, stack] of Object.entries(READER_FONTS)) expect(styles, font).toContain(`.blyg-reader.is-font-${font} .blyg-reader-body { font-family: ${stack}; }`);
  });
  it("every font has a label, and only the four are accepted", () => {
    for (const f of ["default", "serif", "sans", "mono"]) {
      expect(isReaderFont(f)).toBe(true);
      expect(FONT_LABELS[f as keyof typeof FONT_LABELS]).toBeTruthy();
    }
    for (const bad of ["Serif", "comic", "", null, undefined, 1, {}]) expect(isReaderFont(bad)).toBe(false);
  });
});

describe("the web page view is never changed by a setting", () => {
  const doc = trimmedDocument({ pageHtml: fixture("fragment"), pageUrl: "http://localhost:8788/f/abc/", css: ["body{color:red}"] }) ?? "";
  it("the document carries the blyg's own CSS and our layout lines only: no font, no colour of ours", () => {
    expect(doc).toContain("body{color:red}");
    expect(doc).not.toContain("font-family");
    expect(doc).not.toContain("!important");
  });
});

describe("the font setting", () => {
  it("starts as the default, and anything unknown reads as the default", () => {
    expect(defaultSettings().readerPane.font).toBe("default");
    expect(migrateSettings({ readerPane: { font: "serif" } }).settings.readerPane.font).toBe("serif");
    for (const bad of ["Serif", "comic", 3, null, undefined, {}]) expect(migrateSettings({ readerPane: { font: bad } }).settings.readerPane.font).toBe("default");
  });
});
