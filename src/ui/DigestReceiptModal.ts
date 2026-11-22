// The receipt: shown every time before the Daily sends anything to an AI provider. It says what goes where and lets the person read the exact bytes.
// Nothing is sent unless Send is tapped; closing the window any other way is Cancel. Plain text only.
import { Modal, Setting, type App } from "obsidian";
import type { LlmStore, Receipt } from "../digest/llm";

export class DigestReceiptModal extends Modal {
  private answered = false;
  constructor(app: App, private readonly receipt: Receipt, private readonly answer: (send: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, receipt: r } = this;
    this.setTitle("Send these posts to an AI model?");
    contentEl.createDiv({ text: `To ${r.host}, model ${r.model}. Nothing is sent until you tap Send.` });
    contentEl.createDiv({ text: `${r.clusters.length} ${r.clusters.length === 1 ? "group" : "groups"}, ${r.posts} ${r.posts === 1 ? "post" : "posts"}, ${r.chars} characters (about ${r.tokensEstimate} tokens, a rough guess).` });
    const list = contentEl.createEl("ul");
    for (const c of r.clusters) list.createEl("li", { text: `${c.headline} — ${c.posts} ${c.posts === 1 ? "post" : "posts"}, ${c.chars} characters` });
    contentEl.createDiv({ text: `Headers: ${r.headerNames.join(", ")}.` });
    const box = contentEl.createEl("details");
    box.createEl("summary", { text: "Show the exact text that will be sent" });
    const area = box.createEl("textarea", { cls: "blyg-textmodal-area" });
    area.value = r.exact;
    area.readOnly = true;
    area.rows = 12;
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Send").setCta().onClick(() => this.finish(true)))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)));
  }

  private finish(send: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.answer(send);
    this.close();
  }

  override onClose(): void {
    this.finish(false);
    this.contentEl.empty();
  }
}

const stamp = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** The trail as plain text for "Show what the digest sent": time, model, host, sizes and post ids (no text, no key). */
export function trailText(store: LlmStore): string {
  if (store.trail.length === 0) return "The digest has not sent anything yet.";
  return store.trail
    .map((t) => {
      const what = t.status === "sent" ? "sent" : t.status === "cancelled" ? "cancelled (nothing sent)" : "failed";
      return [`${stamp(t.at)} · ${what} · ${t.model}${t.host ? ` · ${t.host}` : ""}`, `${t.clusters} groups, ${t.postIds.length} posts, ${t.chars} characters`, t.note ?? "", t.postIds.length ? `post ids: ${t.postIds.join(", ")}` : ""].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
