// The Daily's window: which posts count as "since you last looked". Pure. The memory is one small file in the plugin's own folder (see register.ts);
// nothing about it is written to the vault.

export const DAY_MS = 24 * 3600 * 1000;
/** The Daily never reaches further back than this, however long ago it was last opened. */
export const MAX_WINDOW_MS = 48 * 3600 * 1000;
/** Opening the Daily again within this time shows the same window instead of an empty one. */
export const REOPEN_GRACE_MS = 30 * 60 * 1000;

export interface DailyState {
  v: 1;
  /** When the Daily was last opened (and counted as read). */
  lastOpenedAt: number;
  /** Where that opening's window started. */
  windowStart: number;
}

/** What was read from the memory file; null when it is not ours or not sane. Nothing read back is trusted. */
export function parseDailyState(raw: unknown, now: number): DailyState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.lastOpenedAt !== "number" || typeof r.windowStart !== "number") return null;
  if (!Number.isFinite(r.lastOpenedAt) || !Number.isFinite(r.windowStart)) return null;
  if (r.lastOpenedAt > now + 60_000 || r.windowStart > r.lastOpenedAt) return null; // a clock that went backwards: start over
  return { v: 1, lastOpenedAt: r.lastOpenedAt, windowStart: r.windowStart };
}

/** The window for an opening at `now`, and the memory to keep afterwards. */
export function nextWindow(prev: DailyState | null, now: number): { since: number; state: DailyState } {
  const floor = now - MAX_WINDOW_MS;
  if (prev && now - prev.lastOpenedAt < REOPEN_GRACE_MS) return { since: Math.max(prev.windowStart, floor), state: prev };
  const since = Math.max(prev?.lastOpenedAt ?? 0, floor);
  return { since, state: { v: 1, lastOpenedAt: now, windowStart: since } };
}
