// V1-C: the part of the publish window that lists the new items a thread makes (one confirmation for all of them). Plain text only, never HTML.
import type { TangleRow } from "../publish/types";

export const tangleTitle = (n: number): string => `Publish ${n} new item${n === 1 ? "" : "s"}, then the thread?`;
export const tangleButton = (n: number): string => `Publish ${n} item${n === 1 ? "" : "s"} and the thread`;

export function renderTangle(parent: HTMLElement, tangle: { rows: TangleRow[]; max: number }): void {
  const n = tangle.rows.length;
  parent.createDiv({
    cls: "blyg-warning",
    text: `This thread uses ${n} passage${n === 1 ? "" : "s"} that ${n === 1 ? "is" : "are"} not published yet. Each goes live first as its own item with its own address, then the thread. A published address stays for good: you can change or withdraw an item later, but not delete it.`,
  });
  parent.createDiv({ cls: "blyg-diff-heading", text: `New items (${n} of at most ${tangle.max})` });
  const list = parent.createEl("ol", { cls: "blyg-quotes blyg-tangle-list" });
  for (const row of tangle.rows) {
    list.createEl("li", {
      text:
        row.kind === "block"
          ? `paragraph ^${row.block?.id ?? ""} of ${row.block?.host ?? "a note"}, line ${row.line} — “${row.words}”`
          : row.kind === "span"
            ? `passage, line ${row.line} — “${row.words}”`
            : `idea, line ${row.line} — an empty thread titled “${row.words}”`,
    });
  }
  list.createEl("li", { cls: "blyg-tangle-last", text: "then this thread, published last" });
}
