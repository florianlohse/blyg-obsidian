// The two small questions the digest asks before it sends anything to an AI provider, and the trail text for "Show what the digest sent".
// 1. Consent (once per provider host): one plain sentence, Agree / Cancel.
// 2. The one-line confirm of a manual run: groups, posts, requests, tokens, a rough cost, Send / Cancel.
// Closing a window any other way is Cancel. Plain text only (everything is put on the page as text).
import { Modal, Setting, type App } from "obsidian";
import { estimateLine, type Estimate, type LlmStore } from "../digest/llm";
import { formatCost } from "../digest/prices";

abstract class AskModal extends Modal {
  private answered = false;
  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: readonly string[],
    private readonly yes: string,
    private readonly no: string,
    private readonly answer: (yes: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    for (const line of this.lines) this.contentEl.createDiv({ text: line });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.yes).setCta().onClick(() => this.finish(true)))
      .addButton((b) => b.setButtonText(this.no).onClick(() => this.finish(false)));
  }

  private finish(yes: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(yes);
    this.close();
  }

  override onClose(): void {
    this.finish(false);
    this.contentEl.empty();
  }
}

/** The consent sentence. `host` is the provider's host name (never a key, never a post). */
export const consentSentence = (host: string): string =>
  `The text of posts from blygs you follow is sent to ${host} to write the digest. You can see what was sent afterwards under Show what the digest sent.`;

export class DigestConsentModal extends AskModal {
  constructor(app: App, host: string, answer: (agree: boolean) => void) {
    super(app, "Use an AI model for the digest?", [consentSentence(host)], "Agree", "Cancel", answer);
  }
}

export class DigestConfirmModal extends AskModal {
  constructor(app: App, estimate: Estimate, answer: (send: boolean) => void) {
    super(app, "Write the digest?", [estimateLine(estimate), "The cost is a rough guess; the provider counts its own tokens."], "Send", "Cancel", answer);
  }
}

const stamp = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** The trail as plain text for "Show what the digest sent": time, model, host, sizes, tokens, rough cost and post ids (no text, no key). */
export function trailText(store: LlmStore): string {
  if (store.trail.length === 0) return "The digest has not sent anything yet.";
  const head = store.consent ? [`Agreed to send posts to ${store.consent.host} on ${stamp(store.consent.at)}.`] : [];
  const runs = store.trail.map((t) => {
    const what = t.status === "sent" ? "sent" : t.status === "cancelled" ? "cancelled (nothing sent)" : "failed";
    const tokens = t.tokens === undefined ? "" : `, about ${t.tokens} tokens, ${t.cost === null || t.cost === undefined ? "cost unknown" : `roughly ${formatCost(t.cost)}`}`;
    const reqs = t.requests && t.requests > 1 ? `, ${t.requests} requests` : "";
    return [`${stamp(t.at)} · ${what} · ${t.model}${t.host ? ` · ${t.host}` : ""}`, `${t.clusters} groups, ${t.postIds.length} posts, ${t.chars} characters${reqs}${tokens}`, t.note ?? "", t.postIds.length ? `post ids: ${t.postIds.join(", ")}` : ""].filter(Boolean).join("\n");
  });
  return [...head, ...runs].join("\n\n");
}
