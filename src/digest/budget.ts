// The daily token ceiling: a running tally of tokens the digest used per local day (plugin storage) and a pure check the automatic run (a later
// package) will use. The manual run is never blocked by the ceiling; its tokens are added to the tally.
export interface TokenTally {
  /** Local day, "YYYY-MM-DD". */
  day: string;
  tokens: number;
}

/**
 * The default ceiling, in tokens per local day. High on purpose (Florian, 2026-11-23: a digest costs a fraction of a cent, so quality comes before tokens):
 * one full run is a few story requests of at most MAX_REQUEST_CHARS (about 25,000 input tokens each) plus the sections requests, so at most a few hundred
 * thousand tokens; 2,000,000 allows many runs a day and still stays at a few dollars a day at the highest table price. The person can lower it, or set 0 for none.
 */
export const DEFAULT_DAILY_TOKEN_CEILING = 2_000_000;
/** The default before 23 November 2026; a saved setting that still holds exactly this is moved to the new default (settings/migrate.ts). */
export const OLD_DAILY_TOKEN_CEILING = 60_000;

export const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function parseTally(raw: unknown): TokenTally | null {
  const r = raw as { day?: unknown; tokens?: unknown } | null;
  return r && typeof r.day === "string" && typeof r.tokens === "number" && Number.isFinite(r.tokens) && r.tokens >= 0 ? { day: r.day, tokens: Math.round(r.tokens) } : null;
}

/** Tokens already used on the local day of `now` (a tally from another day counts as zero). */
export function usedToday(tally: TokenTally | null, now: number): number {
  return tally && tally.day === localDay(now) ? tally.tokens : 0;
}

/** Add `tokens` to the tally for the day of `now`; a new day starts again from zero. */
export function addTokens(tally: TokenTally | null, now: number, tokens: number): TokenTally {
  return { day: localDay(now), tokens: usedToday(tally, now) + Math.max(0, Math.round(tokens)) };
}

/** Would a run of about `estimate` tokens take the day past `ceiling`? A ceiling of 0 or less means none is set (nothing exceeds it). */
export function wouldExceedCeiling(tally: TokenTally | null, now: number, estimate: number, ceiling: number): boolean {
  if (!(ceiling > 0)) return false;
  return usedToday(tally, now) + Math.max(0, estimate) > ceiling;
}
