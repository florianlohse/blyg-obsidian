// "Menu 1": the rows of the reader's and the digest's menus. Label at the left, a muted value right-aligned, and a › at the end of a row that opens something. Every row has the
// same fixed slot for the ›, so the values of all rows end on one right edge whether or not a row has the arrow; a long value is cut with an ellipsis, the label never.
// Text only (createEl({ text })).

export interface MenuRowOptions {
  label: string;
  /** Muted, right-aligned, cut with an ellipsis when it is long. */
  value?: string;
  /** The row opens something (a list, a window, another view): draws the ›. */
  opens?: boolean;
  title?: string;
  cls?: string;
  /** Absent: a row that only tells (no button). */
  run?: () => void;
}

/** The three parts of a row: label, value, and the slot of the ›. Also how a row is drawn again in place (the Write row says "Writing the digest…" while it runs). */
export function fillMenuRow(row: HTMLElement, o: Pick<MenuRowOptions, "label" | "value" | "opens">): { value: HTMLElement } {
  row.empty();
  row.createSpan({ cls: "blyg-menurow-label", text: o.label });
  const value = row.createSpan({ cls: "blyg-menurow-value", text: o.value ?? "" });
  row.createSpan({ cls: "blyg-menurow-go", text: o.opens ? "›" : "", attr: { "aria-hidden": "true" } });
  return { value };
}

export function drawMenuRow(parent: HTMLElement, o: MenuRowOptions): HTMLElement {
  const cls = `blyg-menurow${o.cls ? ` ${o.cls}` : ""}`;
  const attr = o.title ? { title: o.title } : undefined;
  const row = o.run ? parent.createEl("button", { cls, ...(attr ? { attr } : {}) }) : parent.createDiv({ cls, ...(attr ? { attr } : {}) });
  fillMenuRow(row, o);
  if (o.run) {
    const run = o.run;
    row.addEventListener("click", () => run());
  }
  return row;
}
