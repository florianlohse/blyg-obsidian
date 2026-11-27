// The top line of the Daily: a small-caps muted line above the first story, "Editor: <name>", only when a named editor wrote the edition (nothing for neutral). No money here: the
// month's cost is the menu's "Digest billing this month" row (ui/digestMenu.ts). Text only.
import { editorById } from "../digest/editors";

/** The line, or null. `editorId`: the editor that wrote the edition. */
export function priceLineText(editorId: string | undefined): string | null {
  const editor = editorById(editorId);
  return editor ? `Editor: ${editor.name}` : null;
}

export function drawPriceLine(root: HTMLElement, text: string | null): HTMLElement | null {
  return text === null ? null : root.createDiv({ cls: "blyg-daily-priceline", text });
}
