// The reader's MODE, in one place: the Feed (the list of posts) or the Digest (today's edition, its stories and sections). The mode decides what the reader shows, which
// order Next / Previous walk (the feed's, or a story's), what Back returns to, and what the counter says. It is persisted (settings `readerPane.mode`) so the reader opens in
// the mode it was left in. Module state, set up by the Daily's registration only when its feature is on: with it off there is only the Feed and no switch is drawn.
import type { WorkspaceLeaf } from "obsidian";

export type ReaderMode = "feed" | "digest";
/** The two views' types (src/ui/ReaderView.ts, src/ui/DigestView.ts; tests/digest/dg8b.test.ts pins them). */
export const FEED_VIEW = "blyg-reader";
export const DIGEST_VIEW = "blyg-daily";

export interface ModeStore {
  get(): ReaderMode;
  set(mode: ReaderMode): void;
}

let store: ModeStore | null = null;
let current: ReaderMode = "feed";
let reopen: (() => Promise<void>) | null = null;

/** The Daily's registration: the stored mode, and how to open the Daily. null: the Daily is off (only the Feed exists). */
export function useReaderMode(s: ModeStore | null, openDigest: (() => Promise<void>) | null = null): void {
  store = s;
  current = s ? s.get() : "feed";
  reopen = s ? openDigest : null;
}
export const readerMode = (): ReaderMode => (store ? current : "feed");
export const digestAvailable = (): boolean => store !== null;
export function setReaderMode(mode: ReaderMode): void {
  if (!store || mode === current) return;
  current = mode;
  store.set(mode);
}
/** "Open reader" while the last mode was the Digest: open the Daily instead. True when it did. */
export async function reopenInLastMode(): Promise<boolean> {
  if (readerMode() !== "digest" || !reopen) return false;
  await reopen();
  return true;
}

/** The view type that shows the list of a mode. */
export const viewOf = (mode: ReaderMode): string => (mode === "digest" ? DIGEST_VIEW : FEED_VIEW);

/** Change the mode and show its list in this leaf. */
export function switchMode(leaf: Pick<WorkspaceLeaf, "setViewState">, mode: ReaderMode): void {
  setReaderMode(mode);
  void leaf.setViewState({ type: viewOf(mode), active: true });
}

/**
 * The small segmented control "Feed | Digest" for a header: two text tabs, the one you are in pressed. null when the Daily is off. `pick` is called for the other one.
 */
export function drawModeToggle(into: HTMLElement, shown: ReaderMode, pick: (mode: ReaderMode) => void): HTMLElement | null {
  if (!digestAvailable()) return null;
  const box = into.createDiv({ cls: "blyg-modeswitch", attr: { role: "group", "aria-label": "Feed or digest" } });
  for (const [mode, label, title] of [["feed", "Feed", "The list of posts"], ["digest", "Digest", "Today's digest: stories and sections"]] as const) {
    const on = mode === shown;
    const b = box.createEl("button", { text: label, cls: `blyg-modebtn${on ? " is-active" : ""}`, attr: { title, "aria-pressed": String(on) } });
    if (!on) b.addEventListener("click", () => pick(mode));
  }
  return box;
}
