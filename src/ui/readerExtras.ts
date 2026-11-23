// Small pieces of the reader that live outside ReaderView.ts (its size is capped): the way back to the digest and
// the idle wait of the reader's first work.

/** Where Back goes after the trail of posts is used up, when the reader was opened from somewhere other than its own list (the digest). One use, then it is gone. */
export class ReturnPoint {
  private fn: (() => void) | null = null;
  set(fn: (() => void) | null): void {
    this.fn = fn;
  }
  get active(): boolean {
    return this.fn !== null;
  }
  /** Go back: true when there was somewhere to go. */
  run(): boolean {
    const fn = this.fn;
    this.fn = null;
    if (!fn) return false;
    fn();
    return true;
  }
}

/**
 * Run `fn` when the app has nothing else to do (at the latest after a few seconds): the reader's first work must not compete with Obsidian's own start.
 * Not every device has `requestIdleCallback` (Safari, so iOS, does not): there it is a plain wait.
 */
export function whenIdle(fn: () => void): void {
  const win = activeWindow as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof win.requestIdleCallback === "function") win.requestIdleCallback(fn, { timeout: 3000 });
  else win.setTimeout(fn, 1500);
}
