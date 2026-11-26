// The small action bar of the reader ("Send passage to note"): it appears at the foot of the pane while text of the open post is selected, and offers
// "Send to note". Drawn at the bottom, in the thumb zone, so it never sits under iOS's selection handles or its edit menu. It is not part of the post's own
// header, so the reading position does not move when it appears. Text is set with textContent only.
import type { ReadingPost } from "../studio/reading";
import { PM } from "../app/passageMessages";

/** How long a selection that has just gone is still sent: tapping a button can clear the selection before the tap arrives. */
export const HELD_MS = 1500;

export interface DockPort {
  /** The open post, or null. */
  post(): ReadingPost | null;
  /** Why this post cannot be quoted (a sentence), or null when it can. */
  blocked(post: ReadingPost): string | null;
  /** Send the passage: the dock has already cleared the selection. */
  send(post: ReadingPost, selection: string): void;
  /** A selection was seen: kept by the caller for the command. */
  seen(post: ReadingPost, selection: string): void;
}

/** What is selected inside the open post's own text (not in the header or the replies); "" when nothing. */
export function selectionInPostBody(root: HTMLElement): string {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
  const surface = root.querySelector(".blyg-reader-surface .blyg-reader-body");
  if (!surface || !surface.contains(sel.getRangeAt(0).commonAncestorContainer)) return "";
  return sel.toString();
}

export class PassageDock {
  private el: HTMLElement | null = null;
  private held = "";
  private heldAt = 0;
  private timer = 0;

  constructor(private readonly root: HTMLElement, private readonly port: DockPort) {}

  /** Call on every `selectionchange` of the reader's document. */
  update(): void {
    const post = this.port.post();
    const text = post ? selectionInPostBody(this.root) : "";
    window.clearTimeout(this.timer);
    if (post && text.trim() !== "") {
      this.held = text;
      this.heldAt = Date.now();
      this.port.seen(post, text);
      this.show(post, text);
      return;
    }
    this.timer = window.setTimeout(() => this.hide(), HELD_MS);
  }

  /** The passage to send: the live selection, else the one that went a moment ago. */
  private passage(): string {
    const now = selectionInPostBody(this.root);
    if (now.trim() !== "") return now;
    return Date.now() - this.heldAt < HELD_MS + 500 ? this.held : "";
  }

  private show(post: ReadingPost, text: string): void {
    if (!this.el || !this.el.isConnected) {
      const el = this.root.createDiv({ cls: "blyg-passage-dock", attr: { role: "toolbar", "aria-label": "Selected passage" } });
      el.createDiv({ cls: "blyg-passage-dock-note" });
      const row = el.createDiv({ cls: "blyg-passage-dock-row" });
      const send = row.createEl("button", { cls: "blyg-passage-dock-send mod-cta", text: PM.dockSend });
      const close = row.createEl("button", { cls: "blyg-passage-dock-close", text: "✕", attr: { "aria-label": "Hide" } });
      // Keep the selection when a button is pressed (iOS clears it on a tap elsewhere otherwise); `passage()` covers the cases where it goes anyway.
      for (const b of [send, close]) b.addEventListener("pointerdown", (e) => e.preventDefault());
      send.addEventListener("click", () => {
        const p = this.port.post();
        const passage = this.passage();
        if (!p || passage.trim() === "" || this.port.blocked(p) !== null) return;
        clearSelection(this.root);
        this.hide();
        this.port.send(p, passage);
      });
      close.addEventListener("click", () => {
        clearSelection(this.root);
        this.hide();
      });
      this.el = el;
    }
    const why = this.port.blocked(post);
    const note = this.el.querySelector(".blyg-passage-dock-note");
    note?.setText(why ?? PM.dockCount(text.trim().length));
    this.el.toggleClass("is-blocked", why !== null);
    const send = this.el.querySelector<HTMLButtonElement>(".blyg-passage-dock-send");
    if (send) send.disabled = why !== null;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}

function clearSelection(root: HTMLElement): void {
  root.ownerDocument.getSelection()?.removeAllRanges();
}
