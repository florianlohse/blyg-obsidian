// The Daily's sticky bar: the title and the dateline, the Feed | Digest toggle and ONE menu icon in a compact row that stays on top while the page scrolls
// (position: sticky in the view's scrolling content). The other controls (Refresh, Write, Re-sort, edition switcher) are in a panel the menu icon unfolds; folded by default.
// Text and icons only (createEl({ text }), setIcon), never HTML.
import { setIcon } from "obsidian";
import { drawModeToggle, type ReaderMode } from "./readerMode";

export interface DigestBar {
  /** The unfolded panel: the controls go in here. */
  panel: HTMLElement;
}

/** Whether the panel is open is kept by the caller (`state`), so a redraw keeps it. */
export function drawBar(root: HTMLElement, o: { date: string; kicker: string; state: { open: boolean }; toggle: (m: ReaderMode) => void }): DigestBar {
  const bar = root.createDiv({ cls: "blyg-daily-masthead blyg-daily-bar" });
  const row = bar.createDiv({ cls: "blyg-daily-barrow" });
  const title = row.createDiv({ cls: "blyg-daily-bartitle" });
  title.createEl("h1", { text: o.date, cls: "blyg-daily-date" });
  title.createDiv({ text: o.kicker, cls: "blyg-daily-kicker" });
  const menu = row.createEl("button", { cls: "blyg-daily-menu clickable-icon", attr: { "aria-label": "Digest menu", title: "Digest menu" } });
  setIcon(menu, "menu");
  drawModeToggle(row.createDiv({ cls: "blyg-modeslot" }), "digest", o.toggle);
  const panel = bar.createDiv({ cls: "blyg-daily-panel" });
  const paint = (): void => {
    panel.toggleClass("is-open", o.state.open);
    menu.setAttr("aria-expanded", String(o.state.open));
  };
  paint();
  menu.addEventListener("click", () => {
    o.state.open = !o.state.open;
    paint();
  });
  return { panel };
}
