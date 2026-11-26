// V1-C.3: the panel's list of a note's paragraphs that were published as items. Drawing only (src/app/blockPanel.ts decides what to say); text only, never HTML.
import type { BlockRow, BlockState } from "../app/blockPanel";

const LABEL: Record<BlockState, string> = {
  "in-sync": "In sync",
  changed: "Changed since published",
  gone: "Gone from this note",
  withdrawn: "Withdrawn",
  missing: "Not in the Studio",
  unknown: "Not checked",
  checking: "Checking…",
};

const DETAIL: Partial<Record<BlockState, string>> = {
  changed: "The paragraph here differs from what is live. Nothing goes live until you confirm.",
  gone: "The item stays published.",
  missing: "The Studio has no item with this id.",
  unknown: "The Studio could not be asked, or the paragraph cannot be sent as it is.",
};

export function drawBlockRows(parent: HTMLElement, blocks: { rows: BlockRow[]; more: number }, publish: (row: BlockRow) => void): void {
  const changed = blocks.rows.filter((r) => r.state === "changed").length;
  const box = parent.createDiv({ cls: "blyg-pane-section blyg-blocks" });
  box.createDiv({ cls: "blyg-blocks-title", text: `Paragraphs from this note · ${blocks.rows.length + blocks.more}${changed > 0 ? ` (${changed} changed)` : ""}` });
  for (const row of blocks.rows) {
    const el = box.createDiv({ cls: `blyg-block blyg-block-${row.state}` });
    const head = el.createDiv({ cls: "blyg-block-head" });
    head.createSpan({ cls: "blyg-block-state", text: LABEL[row.state] });
    head.createSpan({ cls: "blyg-block-id", text: `^${row.blockId}${row.version !== null ? ` · version ${row.version}` : ""}` });
    if (row.excerpt) el.createDiv({ cls: "blyg-block-excerpt", text: row.excerpt });
    const detail = DETAIL[row.state];
    if (detail) el.createDiv({ cls: "blyg-pane-note", text: detail });
    if (row.state === "changed") {
      const b = el.createEl("button", { cls: "blyg-block-update", text: "Update item…" });
      b.addEventListener("click", () => publish(row));
    }
  }
  if (blocks.more > 0) box.createDiv({ cls: "blyg-pane-note", text: `${blocks.more} more are not listed.` });
}
