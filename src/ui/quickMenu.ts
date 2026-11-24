// The quick-action menu (DG13): a long press on a post (about 450 ms, a finger that moves is a scroll) or a right click opens Obsidian's own Menu with a few actions.
// Opening a menu asks nobody for anything; each action is one explicit tap. Drawing only: the entries come from quickActions.ts.
import { Menu } from "obsidian";
import type { ReadingPost } from "../studio/reading";
import { LongPress, postEntries, storyEntries, type QuickEntry, type QuickId } from "./quickActions";

/** Show `entries` at a point; `run` is called with the id of the one tapped. */
export function showQuickMenu(entries: readonly QuickEntry[], at: { x: number; y: number }, run: (id: QuickId) => void): void {
  if (entries.length === 0) return;
  const menu = new Menu();
  for (const e of entries) {
    menu.addItem((item) => {
      item.setTitle(e.title).setIcon(e.icon).setDisabled(e.disabled === true).onClick(() => run(e.id));
      const dom = (item as unknown as { dom?: HTMLElement }).dom; // the hover text: not in the typed API, so only when the element is there
      if (e.tooltip && dom) dom.setAttribute("title", e.tooltip);
    });
  }
  menu.showAtPosition(at);
}

/**
 * Make `el` open `show(x, y)` on a long press (touch) or a context click (mouse). The release after a long press never counts as a tap: the click that follows is swallowed.
 * Movement, a second finger and a scroll of `scroller` cancel the press, so scrolling never opens a menu.
 */
export function attachQuick(el: HTMLElement, show: (x: number, y: number) => void, scroller?: HTMLElement | null): void {
  let swallowUntil = 0;
  let shownAt = 0;
  const open = (x: number, y: number): void => {
    shownAt = Date.now();
    show(x, y);
  };
  const press = new LongPress({ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) }, open);
  const at = (e: TouchEvent): { x: number; y: number } => ({ x: e.touches[0]?.clientX ?? e.changedTouches[0]?.clientX ?? 0, y: e.touches[0]?.clientY ?? e.changedTouches[0]?.clientY ?? 0 });
  el.addEventListener("touchstart", (e) => press.start(e.touches.length, at(e).x, at(e).y), { passive: true });
  el.addEventListener("touchmove", (e) => press.move(e.touches.length, at(e).x, at(e).y), { passive: true });
  el.addEventListener("touchcancel", () => press.cancel(), { passive: true });
  el.addEventListener("touchend", (e) => {
    if (press.end()) {
      swallowUntil = Date.now() + 700;
      if (e.cancelable) e.preventDefault();
    }
  });
  scroller?.addEventListener("scroll", () => press.scroll(), { passive: true });
  el.addEventListener("click", (e) => {
    if (Date.now() < swallowUntil) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (Date.now() - shownAt < 800) return; // a touch device sends this right after the long press that already opened the menu
    open(e.clientX, e.clientY);
  });
}

export interface PostActions {
  open(): void;
  /** Absent: no Reply entry. */
  reply?(): void;
  /** Absent: no mark entry. */
  mark?(read: boolean): void;
  /** False: the Studio has not fetched the post (Reply and the mark are left out or disabled). */
  fetched?(): boolean;
  /** The shelf (SH1): `state` is read when the menu opens (null: no Save entry); `toggle` saves the post or takes it off. Absent: no Save entry. */
  shelf?: { state(): { saved: boolean; full: boolean } | null; toggle(): void };
}

/** A long press or right click on a post's card or row: Open, Reply, Mark read / unread, Save for later. `post` is read when the menu opens, so the label follows the live read state. */
export function quickPost(el: HTMLElement, post: () => ReadingPost, a: PostActions, scroller?: HTMLElement | null): void {
  attachQuick(el, (x, y) => {
    const entries = postEntries(post(), { fetched: a.fetched?.() ?? true, canMark: a.mark !== undefined, canReply: a.reply !== undefined, ...((s) => (s ? { shelf: s } : {}))(a.shelf?.state() ?? null) });
    showQuickMenu(entries, { x, y }, (id) => (id === "open" ? a.open() : id === "reply" ? a.reply?.() : id === "save" || id === "unsave" ? a.shelf?.toggle() : a.mark?.(id === "read")));
  }, scroller);
}

/** A long press or right click on a story card of the digest: open its first post, mark the whole story read / unread. */
export function quickStory(el: HTMLElement, posts: readonly ReadingPost[], a: { open(): void; mark?(read: boolean): void }): void {
  attachQuick(el, (x, y) => showQuickMenu(storyEntries(posts, { canMark: a.mark !== undefined }), { x, y }, (id) => (id === "open" ? a.open() : a.mark?.(id === "read"))));
}
