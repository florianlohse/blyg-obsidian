// The read marks of an unfolded story of the Daily (mockup 3B): the story's own read look, and "Mark story read" as the LAST item of its list, a quiet right-aligned italic muted text button
// (not a line of its own under a folded story). Marks go through the same queue as every other mark (digest/markQueue.ts); a story's read state follows its posts. Text only.
import { markable, unmarkable, type MarkQueue } from "../digest/markQueue";
import { isUnread, type ReadingPost } from "../studio/reading";
import type { ShelfFacade } from "../app/shelfService";
import { drawSavedMark, SAVED_MARK_CLASS } from "./savedMark";

/** A story whose posts are all read has its own read look (the Daily's muted type), kept in step with the marks: `painters` are called whenever a mark changes. */
export function storyReadLook(card: HTMLElement, posts: readonly ReadingPost[], painters: Array<() => void>): void {
  const paint = (): void => card.toggleClass("blyg-is-read", posts.every((q) => !isUnread(q)));
  paint();
  painters.push(paint);
}

/** "Mark story read" ("Mark story unread" once every post that can be marked is read) at the end of `list`. Nothing when the host cannot mark, or there is nothing to mark either way. */
export function drawStoryMark(list: HTMLElement, posts: readonly ReadingPost[], queue: MarkQueue | null, canUnmark: boolean, painters: Array<() => void>): void {
  if (!queue) return;
  const row = list.createDiv({ cls: "blyg-storymark-row" });
  const paint = (): void => {
    row.empty();
    if (row.isConnected === false) return; // the list was folded and drawn again: this row is gone
    const unread = markable(posts);
    const back = canUnmark ? unmarkable(posts) : [];
    if (unread.length === 0 && back.length === 0) return;
    const read = unread.length === 0;
    const btn = row.createEl("button", { cls: `blyg-storymark${read ? " is-read" : ""}`, text: read ? "Mark story unread" : "Mark story read", attr: { "aria-pressed": String(read), title: read ? "Read: mark this story unread again" : "Mark every post of this story read" } });
    btn.addEventListener("click", (e) => {
      e?.stopPropagation?.();
      void (read ? queue.enqueueUnread(posts) : queue.enqueue(posts));
    });
  };
  paint();
  painters.push(paint);
}

const SAVED_SELECTOR = `.${SAVED_MARK_CLASS}`;

/** The saved mark at the start of `target` (the line that names the author of a post row) while the shelf holds the post: drawn now and again whenever `painters` are called (after the shelf is read, after a save). */
export function keepSavedMark(target: HTMLElement, p: ReadingPost, shelf: ShelfFacade | undefined, painters: Array<() => void>): void {
  if (!shelf) return;
  const paint = (): void => {
    target.querySelector(SAVED_SELECTOR)?.remove();
    if (shelf.on() && shelf.ready() && shelf.has(p)) drawSavedMark(target);
  };
  paint();
  painters.push(paint);
}
