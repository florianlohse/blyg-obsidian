// The automatic write: when may the digest write itself, and the footer line. Pure. The rules (Florian's decision, DG4b): once per edition, only with the
// setting on, the AI layer on and consent recorded for the provider's host; the daily token ceiling is enforced here (a manual run never is).
import type { EditionRec } from "./edition";
import type { LlmStore, Estimate } from "./llm";
import { normaliseEndpoint } from "./llm";
import { usedToday, wouldExceedCeiling } from "./budget";

export interface AutoSettings {
  useAi: boolean;
  autoWrite: boolean;
  endpoint: string;
  dailyTokenCeiling: number;
}

/** Is an automatic write due now? True only if nothing speaks against it. Nothing is sent and nothing asked here. */
export function autoDue(s: AutoSettings, rec: EditionRec | null, store: LlmStore, storyCount: number): boolean {
  if (!s.useAi || !s.autoWrite || !rec || rec.auto || storyCount === 0) return false;
  const host = normaliseEndpoint(s.endpoint)?.host;
  if (!host || store.consent?.host !== host) return false; // no consent: never automatic, and never asked for automatically
  if (rec.sections || rec.stories.some((x) => x.textKey)) return false; // already written (by hand): later updates stay manual
  return true;
}

/** The refusal for an automatic run of about `estimate.tokens`, or null. The ceiling counts the day's tally. */
export function ceilingRefusal(s: Pick<AutoSettings, "dailyTokenCeiling">, store: LlmStore, now: number, e: Pick<Estimate, "tokens">): string | null {
  return wouldExceedCeiling(store.tally, now, e.tokens, s.dailyTokenCeiling)
    ? `Not written automatically: it would pass the daily token ceiling (${usedToday(store.tally, now)} used today). “Write the digest” still works.`
    : null;
}

/**
 * The refusal for an automatic run when the ceiling counts every device (the synced usage of the day). `used` null: the shared usage could not be read, and with a ceiling
 * set the run is refused (fail closed). A ceiling of 0 or less means none: nothing to read, nothing refused.
 */
export function sharedCeilingRefusal(s: Pick<AutoSettings, "dailyTokenCeiling">, used: { total: number } | null, e: Pick<Estimate, "tokens">): string | null {
  if (!(s.dailyTokenCeiling > 0)) return null;
  if (used === null) return "Not written automatically: the token use of your devices today could not be read from the synced files. “Write the digest” still works.";
  return used.total + Math.max(0, e.tokens) > s.dailyTokenCeiling ? `Not written automatically: it would pass the daily token ceiling (${used.total} used today on all devices). “Write the digest” still works.` : null;
}

export function addUsage(prev: { tokens: number; cost: number | null } | undefined, tokens: number, cost: number | null): { tokens: number; cost: number | null } {
  const t = Math.max(0, Math.round(tokens));
  return prev ? { tokens: prev.tokens + t, cost: prev.cost === null || cost === null ? null : prev.cost + cost } : { tokens: t, cost };
}
