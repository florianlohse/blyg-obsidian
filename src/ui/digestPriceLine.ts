// The top line of the Daily (mockup 4C): a small-caps muted line above the first story, "$0.04 · Editor: The Setter". Only the money, in US dollars with two decimals (no tokens, no
// cents wording), and "Editor: <name>" only when a named editor wrote the edition (nothing for neutral). The amount is the edition's real token usage across devices (DG17) priced with
// the plugin's own table (digest/prices.ts, through the cost each write recorded); an unknown model has no price, so no amount. Nothing written by the AI: no line at all. Text only.
import { editorById } from "../digest/editors";

/** "$0.04": dollars with two decimals, or null when there is no price (an unknown model) or nothing was spent. */
export function priceAmount(cost: number | null | undefined): string | null {
  return typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? `$${cost.toFixed(2)}` : null;
}

/** The line, or null. `cost`: the edition's cost in dollars (absent for a past edition, whose record keeps none); `editorId`: the editor that wrote it. */
export function priceLineText(cost: number | null | undefined, editorId: string | undefined): string | null {
  const editor = editorById(editorId);
  const parts = [priceAmount(cost), editor ? `Editor: ${editor.name}` : null].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function drawPriceLine(root: HTMLElement, text: string | null): HTMLElement | null {
  return text === null ? null : root.createDiv({ cls: "blyg-daily-priceline", text });
}
