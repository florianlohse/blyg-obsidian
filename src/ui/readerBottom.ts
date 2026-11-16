// S15, the reader pane: how far Obsidian's floating bottom bar reaches into the pane. Pure arithmetic, so it is tested without a DOM; `ReaderView.clearBottom()` does the measuring.

/** The part of a rectangle this needs (a DOMRect has them). */
export interface EdgeRect {
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The padding the pane needs to keep its last line above the bar, or null when there is no bar to clear (the caller then drops the padding).
 * A bar that is not displayed is absent: on a tablet `.mobile-navbar` exists in the DOM but is `display: none`, its rectangle is all zeros, and
 * taken at its word it would "overlap" the whole pane. The same goes for a bar whose top is not below the pane's top: that is not a bar floating over
 * the pane's bottom, and clearing it would leave no room for the feed.
 */
export function bottomClearance(pane: EdgeRect, bar: { rect: EdgeRect; hidden: boolean }): number | null {
  if (bar.hidden || bar.rect.width <= 0 || bar.rect.height <= 0) return null;
  if (bar.rect.top <= pane.top) return null;
  return Math.ceil(Math.max(0, pane.bottom - bar.rect.top));
}
