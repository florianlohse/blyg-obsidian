// Small pieces of the reader that live outside ReaderView.ts (its size is capped): the Feed / Digest switch in Sort & filter, the way back to the digest, and
// the idle wait of the reader's first work.
import type { WorkspaceLeaf } from "obsidian";
import { BLYG_DAILY_VIEW } from "./DigestView";

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

let digestOn = false;
/** The Daily registers itself only when its feature is on (features/registry.ts); the reader's Digest switch exists only then. (Module state: a reload of the plugin starts it off again.) */
export function setDigestSwitch(on: boolean): void {
  digestOn = on;
}

/** The "Feed | Digest" switch at the top of Sort & filter. Feed is where you are; Digest shows the same leaf as today's digest. */
export function drawViewSwitch(into: HTMLElement, leaf: Pick<WorkspaceLeaf, "setViewState">): HTMLElement | null {
  if (!digestOn) return null;
  const row = into.createDiv({ cls: "blyg-reader-viewswitch" });
  const feed = row.createEl("button", { text: "Feed", cls: "blyg-reader-viewbtn is-active" });
  feed.setAttr("aria-pressed", "true");
  const digest = row.createEl("button", { text: "Digest", cls: "blyg-reader-viewbtn", attr: { title: "Today's digest of what you read" } });
  digest.setAttr("aria-pressed", "false");
  digest.addEventListener("click", () => void leaf.setViewState({ type: BLYG_DAILY_VIEW, active: true }));
  return row;
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
