// The trail as plain text for "Show what the digest sent". Pure (no Obsidian import) so a test can read it.
import type { LlmStore } from "./llm";
import { formatCost } from "./prices";

const stamp = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** The trail as plain text for "Show what the digest sent": time, model, host, sizes, tokens, rough cost, post ids and, for the last few runs, the request text as sent (never the key). */
export function trailText(store: LlmStore): string {
  if (store.trail.length === 0) return "The digest has not sent anything yet.";
  const head = store.consent ? [`Agreed to send posts to ${store.consent.host} on ${stamp(store.consent.at)}.`] : [];
  const runs = store.trail.map((t) => {
    const what = t.status === "sent" ? "sent" : t.status === "cancelled" ? "cancelled (nothing sent)" : "failed";
    const tokens = t.tokens === undefined ? "" : `, about ${t.tokens} tokens, ${t.cost === null || t.cost === undefined ? "cost unknown" : `roughly ${formatCost(t.cost)}`}`;
    const reqs = t.requests && t.requests > 1 ? `, ${t.requests} requests` : "";
    return [`${stamp(t.at)} · ${what} · ${t.model}${t.host ? ` · ${t.host}` : ""}`, `${t.clusters} groups, ${t.postIds.length} posts, ${t.chars} characters${reqs}${tokens}`, t.note ?? "", t.postIds.length ? `post ids: ${t.postIds.join(", ")}` : "", ...(t.bodies ?? []).map((b, i) => `request ${i + 1} as sent:\n${b}`)].filter(Boolean).join("\n");
  });
  return [...head, ...runs].join("\n\n");
}
