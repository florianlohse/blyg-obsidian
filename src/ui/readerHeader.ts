// Pieces of the reader's header that are drawn the same way every time. The feed's header has the Reading / Mentions tabs and the Feed | Digest toggle in its first row
// (the toggle is last, at the right end, in one fixed slot); "Sort & filter" has a row of its own below, so it never competes with the toggle for room.

/** The row under the tabs that holds "Sort & filter" (n: how many choices are made). `button` is the reader's own button drawing. */
export function drawFilterRow(
  header: HTMLElement,
  button: (parent: HTMLElement, text: string, run: () => void, opts: { active?: boolean; title?: string; cls?: string }) => HTMLButtonElement,
  n: number,
  open: boolean,
  toggle: () => void,
): void {
  const row = header.createDiv({ cls: "blyg-reader-bar blyg-reader-filterrow" });
  button(row, n > 0 ? `Sort & filter (${n})` : "Sort & filter", toggle, { active: open, cls: "blyg-reader-filterbtn", title: "Order, blyg, length and unread" });
}
