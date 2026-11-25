// The reader's "Save for later" (SH1): the Save button of an open post, the small "saved" mark of a card, the long-press entry (quickMenu.ts) and the Saved view of the feed.
// The shelf itself (what is saved, shared with the owner's other devices and the Studio's web app) is the Studio's; this file draws it and asks app/shelfService.ts to change it.
// Quiet and small, like the rest of the reader: a bookmark glyph (outline: not saved, filled in the accent colour: saved), no box, no word. One mark for every place that shows a saved post (ui/savedMark.ts).
import type { ButtonOpts } from "./readerButton";
import type { ShelfFacade, ShelfResult } from "../app/shelfService";
import type { ReadingPost } from "../studio/reading";
import { SHELF_MAX } from "../studio/shelf";
import { drawSavedMark } from "./savedMark";

/** What the reader asks of the plugin for the shelf. `ReaderHost` extends this. Absent (or switched off): no Save button, no mark, no Saved view. */
export interface ShelfHost {
  shelf?: ShelfFacade;
}

/** What the controller needs of the reader that draws it. */
export interface ShelfScreen {
  /** A line in the reader's status row. */
  status(line: string): void;
  /** Draw again what shows this post (its card, the open post's header). */
  refresh(p: ReadingPost): void;
  /** Draw the feed's body again (a no-op while a post is open: the feed is drawn when the person goes back). */
  body(): void;
  /** The posts the feed holds. */
  posts(): ReadingPost[];
}

const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;

export class ShelfControl {
  /** The Saved view: the shelved posts in shelf order, or null while the feed shows everything. */
  view: ReadingPost[] | null = null;
  private readonly busy = new Set<string>();
  private turn = 0;

  constructor(private readonly shelf: () => ShelfFacade | undefined, private readonly screen: ShelfScreen) {}

  /** The shelf is switched on and this session has read it: the Save entries and the Saved view exist. */
  get usable(): boolean {
    return this.shelf()?.ready() === true;
  }
  get count(): number {
    return this.shelf()?.count() ?? 0;
  }
  has(p: ReadingPost): boolean {
    return this.shelf()?.has(p) === true;
  }

  /** A Feed opens (the reader started): read the shelf once, then draw the marks. A Studio without the shelf draws nothing. */
  opening(): void {
    const s = this.shelf();
    if (!s?.on()) return;
    s.reset();
    void s.opening().then(() => this.usable && this.screen.posts().forEach((p) => this.screen.refresh(p))); // only the cards (and an open post's header) are drawn again: an open post is not re-drawn under the reader
  }

  /** The post is on the shelf and this session has read the shelf: its mark is drawn. */
  marked(p: ReadingPost): boolean {
    return this.usable && this.has(p);
  }

  /** The saved mark (a small filled bookmark) at the start of a meta line of a post that is on the shelf: a card, the open post. */
  mark(parent: HTMLElement, p: ReadingPost): void {
    if (this.marked(p)) drawSavedMark(parent);
  }

  /** The bookmark button in the open post's button row: outline "Save for later", filled "Saved". */
  button(parent: HTMLElement, p: ReadingPost, make: (parent: HTMLElement, text: string, run: () => void, opts: ButtonOpts) => HTMLButtonElement): void {
    const s = this.shelf();
    if (!s || (p.subscriptionId === "" && p.own !== true) || (p.withdrawn && !this.has(p))) return;
    if (!this.usable) {
      // Room is kept for Save while the shelf is being read (so the row does not move when it arrives), and Save stays when the read had no connection: a tap tries again.
      const lost = s.lost?.() === true;
      if (lost || s.settling?.() === true) make(parent, "", () => void this.toggle(p), { disabled: !lost, cls: `blyg-reader-savebtn${lost ? "" : " is-pending"}`, title: "Save this post for later on your shelf, shared with your other devices", icon: "bookmark", label: "Save for later", pressed: false });
      return;
    }
    const saved = this.has(p);
    const working = this.busy.has(keyOf(p));
    const full = !saved && s.full();
    make(parent, "", () => void this.toggle(p), {
      disabled: working || full,
      cls: `blyg-reader-savebtn${saved ? " is-saved" : ""}${working ? " is-working" : ""}`,
      title: full ? `Your shelf is full (${SHELF_MAX} posts). Remove one from Saved first.` : saved ? "On your shelf, shared with your other devices. Tap to remove it." : "Save this post for later on your shelf, shared with your other devices",
      icon: "bookmark", // outline while not saved, filled in the accent colour once saved (the style sheet)
      label: working ? "Saving…" : saved ? "Saved" : "Save for later",
      pressed: saved,
    });
  }

  /** What a long press offers (quickMenu.ts): read when the menu opens. */
  actions(p: ReadingPost): { state(): { saved: boolean; full: boolean } | null; toggle(): void } {
    return { state: () => (this.usable ? { saved: this.has(p), full: this.shelf()?.full() === true } : null), toggle: () => void this.toggle(p) };
  }

  /** Save the post, or take it off the shelf. One write to the Studio; what went wrong is said in the status line, nothing is shown as saved that is not. */
  async toggle(p: ReadingPost): Promise<void> {
    const s = this.shelf();
    const key = keyOf(p);
    if (!s || this.busy.has(key)) return;
    this.busy.add(key);
    this.screen.refresh(p);
    // Whatever goes wrong, the button comes back (a failure, a hang, a throw): the person can tap again.
    const done = await s.toggle(p).catch((): ShelfResult => ({ ok: false, message: "Could not save, no connection. Tap Save to try again." })).finally(() => this.busy.delete(key));
    this.screen.status(done.ok ? (done.saved ? "Saved for later." : "Removed from saved.") : done.message);
    if (done.ok && !done.saved && this.view !== null) {
      this.view = this.view.filter((q) => keyOf(q) !== key);
      this.screen.body();
    }
    this.screen.refresh(p);
  }

  /** The Saved view on or off. On: the saved posts that are loaded show at once, then the Studio's shelf list (one read, no write) fills in older ones. */
  async show(on: boolean): Promise<void> {
    const s = this.shelf();
    const turn = ++this.turn;
    if (!on || !s) {
      this.view = null;
      this.screen.body();
      return;
    }
    this.view = this.screen.posts().filter((p) => s.has(p));
    this.screen.body();
    const got = await s.saved();
    if (turn !== this.turn || this.view === null) return;
    if (got === null) return this.screen.status("The saved list could not be read; these are the saved posts that are loaded.");
    const loaded = new Map(this.screen.posts().map((p) => [keyOf(p), p]));
    this.view = got.map((p) => loaded.get(keyOf(p)) ?? p);
    this.screen.body();
  }
}
