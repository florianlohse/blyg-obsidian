// HK3 Marginalia: drawing for the marker's popover and the panel's "Reception" list. Read-only; every word of a stranger goes in as text (createEl/textContent), never as HTML.
import { leadOf, placementNote, type ReceptionRow } from "../marginalia/reception";
import { relativeTime } from "./readerFeed";

export interface ReceptionActions {
  /** Open the post that quotes, in the reader; its web page only when the reader cannot show it. */
  openPost(row: ReceptionRow): void;
}

/** One row as lines: "Teo quoted this", when, where it sits, the words, and the way to the post. */
export function drawReceptionRow(parent: HTMLElement, row: ReceptionRow, actions: ReceptionActions, now: number, where?: string): HTMLElement {
  const el = parent.createDiv({ cls: "blyg-reception-row" });
  const head = el.createDiv({ cls: "blyg-reception-head" });
  head.createSpan({ cls: "blyg-reception-lead", text: leadOf(row.mention) });
  const when = relativeTime(row.mention.firstSeen || null, now);
  if (when !== "") head.createSpan({ cls: "blyg-reception-when", text: when });
  const note = placementNote(row.placement) ?? where ?? null;
  if (note) el.createDiv({ cls: "blyg-reception-note", text: note });
  if (row.excerpt) el.createDiv({ cls: "blyg-reception-excerpt", text: row.excerpt });
  if (row.mention.sourcePage) {
    const open = el.createEl("button", { cls: "blyg-reception-open", text: "Open in reader" });
    open.addEventListener("click", () => actions.openPost(row));
  }
  return el;
}

let open: { el: HTMLElement; off: () => void } | null = null;

export function closePopover(): void {
  if (!open) return;
  open.off();
  open.el.remove();
  open = null;
}

/** A small card beside the marker: who quoted this paragraph. A tap elsewhere or Escape closes it. */
export function showPopover(anchor: HTMLElement, rows: ReceptionRow[], actions: ReceptionActions, now: number): void {
  closePopover();
  const el = activeDocument.body.createDiv({ cls: "blyg-reception-popover", attr: { role: "dialog", "aria-label": "Who quoted this" } });
  for (const r of rows) drawReceptionRow(el, r, actions, now);
  const box = anchor.getBoundingClientRect();
  // On a phone it takes the screen's width (8 px each side) and sits under the mark; on a wide screen it sits beside the mark.
  const narrow = window.innerWidth <= 480;
  el.setCssProps({ top: `${Math.round(box.bottom + 6)}px`, left: narrow ? "8px" : `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - 300)))}px` });
  if (narrow) el.addClass("is-wide");
  const away = (e: Event): void => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) closePopover();
  };
  const key = (e: KeyboardEvent): void => {
    if (e.key === "Escape") closePopover();
  };
  activeDocument.addEventListener("pointerdown", away, true);
  activeDocument.addEventListener("keydown", key, true);
  open = { el, off: () => { activeDocument.removeEventListener("pointerdown", away, true); activeDocument.removeEventListener("keydown", key, true); } };
}
