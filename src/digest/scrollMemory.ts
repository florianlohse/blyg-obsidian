// Where the digest was scrolled to, kept per edition, so Back from a post returns to the same place. The digest view is made again each time it is shown
// (a leaf changes its view), so the position lives here, in module memory, not in the view. Never stored on disk (a position means nothing next session).
const MAX = 20;
const kept = new Map<string, number>();

/** The key of an edition's page: its id, or "now" for a page with no edition. */
export const scrollKey = (edition: number | null | undefined): string => (edition === null || edition === undefined ? "now" : String(edition));

export function rememberScroll(key: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return;
  kept.delete(key);
  kept.set(key, Math.round(top));
  while (kept.size > MAX) kept.delete(kept.keys().next().value as string);
}
export const recalledScroll = (key: string): number | null => kept.get(key) ?? null;
export const forgetScroll = (key: string): void => void kept.delete(key);
/** For tests. */
export const clearScrolls = (): void => {
  kept.clear();
  unfolded.clear();
};

/** Which stories are unfolded on an edition's page, so Back from a post finds them as they were (module memory like the scroll position; never stored on disk). */
const unfolded = new Map<string, Set<string>>();
export const storyUnfolded = (key: string, story: string): boolean => unfolded.get(key)?.has(story) === true;
export function setStoryUnfolded(key: string, story: string, open: boolean): void {
  const set = unfolded.get(key) ?? new Set<string>();
  if (open) set.add(story);
  else set.delete(story);
  unfolded.delete(key);
  unfolded.set(key, set);
  while (unfolded.size > MAX) unfolded.delete(unfolded.keys().next().value as string);
}

/** A one-time request to open an edition scrolled to a section (the reader's "In the digest" chip): set by the opener, taken by the digest view when it draws. */
let jump: { edition: number; section: string } | null = null;
export const requestJump = (edition: number, section: string): void => void (jump = { edition, section });
export function takeJump(): { edition: number; section: string } | null {
  const j = jump;
  jump = null;
  return j;
}
