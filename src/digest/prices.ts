// Rough price per million tokens for the models the digest names in its settings. A ROUGH guide for the one-line estimate, never a bill.
// Source: the claude-api skill's "Current Models" table (Anthropic first-party API rates), cached by that skill on 2026-11-03, read on 2026-11-22.
// Haiku 5.5's price holds for prompts up to 100K tokens; a digest request is far smaller. Update the table and PRICES_AS_OF together; an id that is
// not in the table shows tokens only ("cost unknown"). Never fill this table from memory.
export const PRICES_AS_OF = "2026-11-03";

export interface ModelPrice {
  /** US dollars per million input tokens. */
  input: number;
  /** US dollars per million output tokens. */
  output: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-2": { input: 8, output: 40 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** Dollars for the given token counts, or null when the model has no entry in the table. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model.trim()];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** "$0.0123" style text for a rough cost: never "$0.00" for a non-zero amount. */
export function formatCost(dollars: number): string {
  if (dollars <= 0) return "$0";
  if (dollars < 0.0001) return "<$0.0001";
  return `$${dollars < 0.01 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
}
