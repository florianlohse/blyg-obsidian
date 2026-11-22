// The daily token ceiling: a running tally of tokens the digest used per local day (plugin storage) and a pure check the automatic run (a later
// package) will use. The manual run is never blocked by the ceiling; its tokens are added to the tally.
export interface TokenTally {
  /** Local day, "YYYY-MM-DD". */
  day: string;
  tokens: number;
}

/**
 * The default ceiling, in tokens per local day. Conservative: one full front page is a few requests of at most MAX_REQUEST_CHARS (about 6,000 input
 * tokens plus the prompt) and at most MAX_OUTPUT_TOKENS output each, so roughly 20,000 tokens for a full page. 60,000 lets a person run it by hand a
 * couple of times a day and leaves room for an automatic run, and even at the highest table price stays well under a dollar.
 */
export const DEFAULT_DAILY_TOKEN_CEILING = 60_000;

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
