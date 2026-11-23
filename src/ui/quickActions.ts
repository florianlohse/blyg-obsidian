// The quick-action menu's logic without any drawing (DG13): the long-press detector (injected clock) and which entries a menu holds for each context.
// Pure: nothing here imports Obsidian, asks the Studio or writes anything. The menu itself is drawn in quickMenu.ts; every entry is one explicit tap.
import { isUnread, type ReadingPost } from "../studio/reading";
import { markable, unmarkable } from "../digest/markQueue";
import { isUnfollowedPost, unfollowedReplyTitle } from "./readerFollow";

/** How long a finger must stay down, and how far it may drift (in pixels) before the press is a scroll, not a press. */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 10;

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

/** One finger held still for LONG_PRESS_MS fires once; movement, a second finger, a scroll or letting go earlier cancels it. `end()` says whether the press fired, so the click that follows can be swallowed. */
export class LongPress {
  private handle: number | null = null;
  private fired = false;
  private x = 0;
  private y = 0;
  constructor(private readonly timers: Timers, private readonly onPress: (x: number, y: number) => void, private readonly ms = LONG_PRESS_MS, private readonly slop = LONG_PRESS_SLOP) {}

  start(touches: number, x: number, y: number): void {
    this.cancel();
    this.fired = false;
    if (touches !== 1) return;
    this.x = x;
    this.y = y;
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.fired = true;
      this.onPress(this.x, this.y);
    }, this.ms);
  }
  move(touches: number, x: number, y: number): void {
    if (this.handle === null) return;
    if (touches !== 1 || Math.hypot(x - this.x, y - this.y) > this.slop) this.cancel();
  }
  /** The container scrolled: never a press. */
  scroll(): void {
    this.cancel();
  }
  cancel(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }
  /** The finger lifted. True when the press had fired: the caller must not let the release open the post. */
  end(): boolean {
    this.cancel();
    const was = this.fired;
    this.fired = false;
    return was;
  }
}

export type QuickId = "open" | "reply" | "read" | "unread";
export interface QuickEntry {
  id: QuickId;
  title: string;
  /** An Obsidian icon name. */
  icon: string;
  disabled?: boolean;
  /** The hover text (the same words as the open post's button). */
  tooltip?: string;
}

export interface PostOpts {
  /** The Studio has fetched this post (false: it cannot be replied to or marked read yet). Default true. */
  fetched?: boolean;
  /** This surface can mark (the host has the write path). Default true. */
  canMark?: boolean;
  /** This surface can reply. Default true. */
  canReply?: boolean;
}

/** The menu of one post (a feed card, a post row of the digest). Reply follows the open post's own Reply button: disabled for a withdrawn or own post, plain (no quote) for a blyg you do not follow. */
export function postEntries(p: ReadingPost, o: PostOpts = {}): QuickEntry[] {
  const fetched = o.fetched !== false;
  const out: QuickEntry[] = [{ id: "open", title: "Open", icon: "book-open" }];
  const held = p.subscriptionId !== "" && fetched;
  if (o.canReply !== false) {
    const tooltip = p.own === true ? "Your own post: write the follow-up in your vault" : isUnfollowedPost(p) ? unfollowedReplyTitle : held ? "Reply in Obsidian: a new thread that answers this post" : fetched ? "Subscribe to this blyg in your Studio to reply to its posts from here." : "Your Studio has not fetched this post yet.";
    out.push({ id: "reply", title: "Reply", icon: "reply", tooltip, ...(p.withdrawn || !(held || isUnfollowedPost(p)) ? { disabled: true } : {}) });
  }
  if (o.canMark !== false && p.subscriptionId !== "" && !p.withdrawn && p.own !== true && fetched) {
    out.push(isUnread(p) ? { id: "read", title: "Mark read", icon: "circle-check" } : { id: "unread", title: "Mark unread", icon: "circle" });
  }
  return out;
}

/** The menu of a story card: open its first post, mark the whole story read (or, when every post is read, unread again). */
export function storyEntries(posts: readonly ReadingPost[], o: { canMark?: boolean } = {}): QuickEntry[] {
  const out: QuickEntry[] = posts.length > 0 ? [{ id: "open", title: "Open first post", icon: "book-open" }] : [];
  if (o.canMark !== false) {
    if (markable(posts).length > 0) out.push({ id: "read", title: "Mark story read", icon: "circle-check" });
    else if (unmarkable(posts).length > 0) out.push({ id: "unread", title: "Mark story unread", icon: "circle" });
  }
  return out;
}
