// HK3 Marginalia: the "Reception" section at the end of a note, drawn the same way in the editor (a block widget) and, later, in Reading view. Read-only; every word of a
// stranger goes in as text (createDiv / textContent), never as HTML. A Studio that failed says so: it is never drawn as an empty list.
import { groupReception } from "../marginalia/groups";
import type { ReceptionPanel } from "../marginalia/wire";
import { drawReceptionRow } from "./receptionView";

/** What the section says about itself: a stable text for the widget to compare and for tests to read. */
export function receptionTitle(rec: ReceptionPanel): string {
  return rec.status === "ready" && rec.rows.length > 0 ? `Reception (${rec.rows.length}${rec.incomplete ? "+" : ""})` : "Reception";
}

/** A signature of what the section shows, so a redraw is only made when it changed. */
export function receptionSignature(rec: ReceptionPanel): string {
  return `${rec.status}|${rec.incomplete}|${rec.rows.map((r) => `${r.mention.id}:${r.placement.kind}:${r.placement.kind === "paragraph" ? r.placement.index : ""}:${r.excerpt?.length ?? 0}`).join(",")}`;
}

export function drawReceptionSection(parent: HTMLElement, rec: ReceptionPanel, now: number): HTMLElement {
  const box = parent.createDiv({ cls: "blyg-reception-section", attr: { role: "region", "aria-label": "Reception" } });
  box.createDiv({ cls: "blyg-reception-title", text: receptionTitle(rec) });
  if (rec.status === "loading") box.createDiv({ cls: "blyg-reception-note", text: "Looking up who quoted this…" });
  else if (rec.status === "failed") box.createDiv({ cls: "blyg-pane-warn", text: "The Studio could not be asked, so nothing is known about who quoted this. It tries again in a minute." });
  else if (rec.rows.length === 0) box.createDiv({ cls: "blyg-reception-note", text: rec.incomplete ? "Nothing found in the part of the list that was read." : "Nobody has quoted or answered this yet." });
  else {
    for (const g of groupReception(rec.rows)) {
      box.createDiv({ cls: "blyg-reception-group", text: g.title });
      for (const row of g.rows) drawReceptionRow(box, row, rec.actions, now, g.id === "paragraph" && row.placement.kind === "paragraph" ? `paragraph ${row.placement.index + 1}` : undefined);
    }
    if (rec.incomplete) box.createDiv({ cls: "blyg-reception-note", text: "The list was cut off: there may be more." });
  }
  return box;
}
