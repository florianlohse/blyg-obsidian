// The setting "Mark posts as read when I open them": a post that has been open for about a second counts as read, through the same read-mark path as the
// manual toggle. A tap that opens the wrong post and leaves again does not count, and neither does a post of your own, a withdrawn one, or one already read.
import { isUnread, type ReadingPost } from "../studio/reading";

/** How long a post must stay open before it counts as read. A judgment call: long enough that an accidental tap or a quick Next does not mark, short enough to be unnoticed. */
export const AUTO_READ_MS = 1000;

export interface AutoReadDeps {
  /** The setting. Asked when the timer fires too, so switching it off takes effect at once. */
  enabled(): boolean;
  /** The post the reader shows now; null in the list. */
  current(): ReadingPost | null;
  /** The newest row held for a post (a reload replaces the objects). */
  live(p: ReadingPost): ReadingPost;
  /** Mark it read (the reader's own `setRead`: shown at once, put back if the Studio refuses). */
  mark(p: ReadingPost): void;
}

const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;

export class AutoRead {
  private timer: number | undefined;
  constructor(private readonly deps: AutoReadDeps, private readonly ms: number = AUTO_READ_MS) {}

  private eligible(p: ReadingPost): boolean {
    return this.deps.enabled() && p.own !== true && !p.withdrawn && isUnread(this.deps.live(p));
  }

  /** A post was opened (from the feed, the Daily, a step, a quote): start the clock; one clock at a time. */
  arm(p: ReadingPost): void {
    this.cancel();
    if (!this.eligible(p)) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      const now = this.deps.current();
      if (now && keyOf(now) === keyOf(p) && this.eligible(now)) this.deps.mark(now);
    }, this.ms);
  }

  cancel(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
