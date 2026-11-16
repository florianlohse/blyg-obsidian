// S15: how far Obsidian's floating bottom bar covers the reader's pane, so the last line stays above it. Pure: the caller measures the boxes.
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * The pixels at the pane's bottom edge that the bar covers, or null when there is nothing to keep clear of: no bar, a bar that is not drawn (`display: none` gives a
 * box of size zero at the origin, as Obsidian's tablet layout does for the phone's bar), or a bar that does not meet the pane. Never more than the pane is high.
 */
export function bottomClearance(pane: Box, bar: Box | null): number | null {
  if (bar === null || bar.width <= 0 || bar.height <= 0) return null;
  if (bar.right <= pane.left || bar.left >= pane.right) return null;
  if (bar.bottom <= pane.top || bar.top >= pane.bottom) return null;
  return Math.min(Math.max(0, pane.height), Math.max(0, Math.ceil(pane.bottom - bar.top)));
}
