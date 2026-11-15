// S15 chunk 2a: the font the reader uses for the CONTENT of a post (the interface keeps Obsidian's). "default" leaves each view as it is: the blyg's own
// look in a web page, Obsidian's reading font in the text view. The others are system fonts that exist on iOS, macOS, Windows and Android; no font is
// downloaded. The stacks are written out once here; `styles.css` repeats them for the text view, and a test keeps the two in step.
export type ReaderFont = "default" | "serif" | "sans" | "mono";

export const READER_FONTS: Record<Exclude<ReaderFont, "default">, string> = {
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

export const FONT_LABELS: Record<ReaderFont, string> = { default: "As the blyg or Obsidian has it", serif: "Serif", sans: "Sans-serif", mono: "Monospace" };

export const isReaderFont = (v: unknown): v is ReaderFont => v === "default" || v === "serif" || v === "sans" || v === "mono";
