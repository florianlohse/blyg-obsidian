// The Daily's sticky bar: the title and the dateline, the Feed | Digest toggle and ONE menu icon in a compact row that stays on top while the page scrolls
// (position: sticky in the view's scrolling content). The date is a button with a small ▾ when there are older editions: a tap opens a list of them under the date.
// Text and icons only (createEl({ text }), setIcon), never HTML.
import { setIcon } from "obsidian";
import { drawModeToggle, type ReaderMode } from "./readerMode";
import { drawEditions, type EditionEntry } from "./DigestPast";

export interface DigestBar {
  /** The unfolded panel: the controls go in here. */
  panel: HTMLElement;
}

/** `state` is kept by the caller, so a redraw keeps the menu and the list of editions as they were. `editions`: absent, the date is plain text. */
export function drawBar(root: HTMLElement, o: { date: string; kicker: string; state: { open: boolean; editionsOpen?: boolean }; toggle: (m: ReaderMode) => void; editions?: { entries: EditionEntry[]; pick: (id: number) => void }; refresh?: { hint: string; click: () => void; made: (btn: HTMLElement) => void } }): DigestBar {
  const bar = root.createDiv({ cls: "blyg-daily-masthead blyg-daily-bar" });
  const row = bar.createDiv({ cls: "blyg-daily-barrow" });
  const title = row.createDiv({ cls: "blyg-daily-bartitle" });
  const h1 = title.createEl("h1", { cls: "blyg-daily-date", ...(o.editions ? {} : { text: o.date }) });
  const dateBtn = o.editions ? h1.createEl("button", { cls: "blyg-daily-datebtn", attr: { "aria-haspopup": "true", "aria-expanded": "false", "aria-label": `${o.date}, older editions` } }) : null;
  if (dateBtn) {
    dateBtn.createSpan({ text: o.date });
    dateBtn.createSpan({ cls: "blyg-daily-datemark", text: "▾", attr: { "aria-hidden": "true" } });
  }
  title.createDiv({ text: o.kicker, cls: "blyg-daily-kicker" });
  const menu = row.createEl("button", { cls: "blyg-daily-menu clickable-icon", attr: { "aria-label": "Digest menu", title: "Digest menu" } });
  setIcon(menu, "menu");
  if (o.refresh) {
    // Refresh is the same action as the feed's: an icon in the bar, always in reach (the menu keeps its explained entry too).
    const r = row.createEl("button", { cls: "blyg-daily-refresh clickable-icon", attr: { "aria-label": "Refresh", title: o.refresh.hint } });
    setIcon(r, "refresh-cw");
    r.addEventListener("click", o.refresh.click);
    o.refresh.made(r);
  }
  drawModeToggle(row.createDiv({ cls: "blyg-modeslot" }), "digest", o.toggle);
  if (dateBtn && o.editions) drawEditionsList(bar, dateBtn, o.state, o.editions);
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

/** The list of editions under the date: opens on a tap of the date, closes on a pick, Escape or a tap outside; the date button gets the focus back. */
function drawEditionsList(bar: HTMLElement, dateBtn: HTMLElement, state: { editionsOpen?: boolean }, e: { entries: EditionEntry[]; pick: (id: number) => void }): void {
  const list = bar.createDiv({ cls: "blyg-daily-editions", attr: { role: "group", "aria-label": "Editions" } });
  const rows = drawEditions(list, e.entries, (id) => {
    state.editionsOpen = false;
    e.pick(id);
  });
  const doc = (bar as { ownerDocument?: Document }).ownerDocument;
  const outside = (ev: Event): void => {
    if (!bar.isConnected) return void doc?.removeEventListener("pointerdown", outside, true);
    if (!bar.contains(ev.target as Node)) set(false, false);
  };
  const set = (open: boolean, focus: boolean): void => {
    state.editionsOpen = open;
    list.toggleClass("is-open", open);
    dateBtn.setAttr("aria-expanded", String(open));
    if (open) doc?.addEventListener("pointerdown", outside, true);
    else doc?.removeEventListener("pointerdown", outside, true);
    if (open && focus) rows[Math.max(0, e.entries.findIndex((x) => x.current))]?.focus?.();
    if (!open && focus) dateBtn.focus?.();
  };
  set(state.editionsOpen === true, false);
  dateBtn.addEventListener("click", () => set(!(state.editionsOpen === true), true));
  bar.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && state.editionsOpen === true) {
      ev.stopPropagation();
      set(false, true);
    }
  });
}
