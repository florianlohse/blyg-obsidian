// The feed header's menu (mockup 5B): a hamburger button at the right end of the header's FIRST row, after the Feed | Digest toggle (the same edge as the Daily's), and the panel it
// unfolds under the status row with Sort & filter, Sources and a Settings shortcut as Menu 1 rows (ui/menuRow.ts). The toggle and Refresh stay in the header. Drawing only; what each
// row does is handed in. Whether the panel is open is kept by the view (`state`), so a redraw of the header keeps it.
import { setIcon } from "obsidian";
import { drawMenuRow } from "./menuRow";

export interface FeedMenu {
  state: { open: boolean };
  /** Draw the header again (the panel is folded or unfolded). */
  repaint: () => void;
  /** "Sort & filter": null when there is nothing to sort or filter yet (the row is not drawn). */
  sort: { value: string; run: () => void } | null;
  sources: () => void;
  /** Absent: no Settings row. */
  settings?: () => void;
}

/** What the Sort & filter row says at its right: how many choices are made, or the order. */
export const sortValue = (choices: number, order: string): string => (choices > 0 ? `${choices} choice${choices === 1 ? "" : "s"}` : order);

/** The hamburger, in `row` (call it last, after the toggle). */
export function drawMenuButton(row: HTMLElement, m: FeedMenu): HTMLElement {
  const b = row.createEl("button", { cls: "blyg-reader-menubtn clickable-icon", attr: { "aria-label": "Menu", title: "Menu: sort and filter, sources, settings", "aria-expanded": String(m.state.open) } });
  setIcon(b, "menu");
  b.addEventListener("click", () => {
    m.state.open = !m.state.open;
    m.repaint();
  });
  return b;
}

/** The unfolded panel, at the end of `header`; nothing while folded. Choosing a row folds the panel again. */
export function drawMenuPanel(header: HTMLElement, m: FeedMenu): void {
  if (!m.state.open) return;
  const panel = header.createDiv({ cls: "blyg-reader-menu blyg-menu", attr: { role: "menu" } });
  const pick = (run: () => void) => (): void => {
    m.state.open = false;
    run();
    m.repaint();
  };
  if (m.sort) drawMenuRow(panel, { label: "Sort & filter", value: m.sort.value, opens: true, cls: "blyg-reader-filterbtn", title: "Order, blyg, length and unread", run: pick(m.sort.run) });
  drawMenuRow(panel, { label: "Sources", opens: true, cls: "blyg-reader-sources", title: "The blygs your Studio follows: follow one, rename it, or stop", run: pick(m.sources) });
  if (m.settings) drawMenuRow(panel, { label: "Settings", opens: true, cls: "blyg-reader-settings", title: "Open this plugin's settings", run: pick(m.settings) });
}
