// The "saved" mark, one drawing for every place that shows a post is on the shelf: a small filled bookmark in the accent colour, put BEFORE a meta line's text (a feed card, a post row of
// the digest, the open post). One helper so the three places cannot drift apart. A glyph, never a word; the label is for screen readers and a long press / hover.
import { setIcon } from "obsidian";

export const SAVED_MARK_CLASS = "blyg-savedmark";

/** Put the mark at the start of `line` (the default) or at its end, and return it. Drawn as an icon of Obsidian's own set, so it follows the theme and needs no emoji. */
export function drawSavedMark(line: HTMLElement, where: "start" | "end" = "start"): HTMLElement {
  const mark = createSpan({ cls: SAVED_MARK_CLASS, attr: { role: "img", "aria-label": "Saved", title: "On your shelf: saved for later" } });
  setIcon(mark, "bookmark");
  if (where === "start") line.prepend(mark);
  else line.append(mark);
  return mark;
}
