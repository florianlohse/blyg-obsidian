// The Daily: a view of what the reader's saved list holds for the window since you last looked. Drawing only; what goes where is decided in src/digest.
// Posts are other people's words: everything is put on the page with createEl({ text }) (textContent), never as HTML, and nothing is written to the vault.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { Cluster } from "../digest/cluster";
import type { Outcome, Written } from "../digest/llm";
import { buildDaily, type DailyModel } from "../digest/daily";
import type { InboundMention, ReadingPost } from "../studio/reading";

export const BLYG_DAILY_VIEW = "blyg-daily";

export interface DigestHost {
  /** The reader's saved list and when it was saved, or null when there is none (the reader has not been opened, or the list is too old). */
  loadList(): Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
  /** The window for an opening now. `commit` remembers this opening; it is called only after a list was shown. */
  window(): Promise<{ since: number; until: number; commit: () => Promise<void> }>;
  /** Open a post in the reader. */
  openPost(post: ReadingPost): Promise<void>;
  openWeb(url: string): void;
  /** The optional AI layer (src/digest/llm.ts); absent or `enabled()` false: the Daily is the deterministic list only. */
  ai?: { enabled(): boolean; cached(clusters: readonly Cluster[]): Promise<Array<Written | null>>; write(clusters: readonly Cluster[]): Promise<Outcome> };
}

const stamp = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class BlygDailyView extends ItemView {
  private written: Array<Written | null> = [];
  private note = "";
  private busy = false;
  constructor(leaf: WorkspaceLeaf, private readonly host: DigestHost) {
    super(leaf);
  }
  override getViewType(): string {
    return BLYG_DAILY_VIEW;
  }
  override getDisplayText(): string {
    return "Blyg Daily";
  }
  override getIcon(): string {
    return "newspaper";
  }
  override async onOpen(): Promise<void> {
    this.contentEl.addClass("blyg-daily");
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.createDiv({ cls: "blyg-daily-status", text: "Reading your list…" });
    let model: DailyModel | null = null;
    let commit: (() => Promise<void>) | null = null;
    try {
      const [list, win] = await Promise.all([this.host.loadList(), this.host.window()]);
      if (list) {
        model = buildDaily(list.posts, list.mentions, win.since, win.until);
        commit = win.commit;
      }
    } catch {
      model = null;
    }
    this.note = "";
    this.written = model && this.host.ai?.enabled() ? await this.host.ai.cached(model.front).catch(() => []) : [];
    this.render(model);
    if (commit) await commit().catch(() => undefined);
  }

  private render(model: DailyModel | null): void {
    const root = this.contentEl;
    root.empty();
    const head = root.createDiv({ cls: "blyg-daily-head" });
    head.createEl("h2", { text: "Daily" });
    head.createEl("button", { text: "Refresh", cls: "blyg-daily-btn" }).addEventListener("click", () => void this.refresh());
    const ai = this.host.ai;
    if (model && ai?.enabled() && model.front.length > 0) {
      const btn = head.createEl("button", { text: this.busy ? "Writing…" : "Write the digest", cls: "blyg-daily-btn" });
      btn.addEventListener("click", () => {
        if (this.busy) return;
        this.busy = true;
        this.render(model);
        void ai
          .write(model.front)
          .then((o) => {
            this.written = o.written;
            this.note = o.status === "ok" && !o.note ? "" : (o.note ?? "");
            if (o.status === "failed") this.note = `${o.note ?? "The digest could not be written."} Showing the list made on your device.`;
          })
          .catch(() => (this.note = "The digest could not be written. Showing the list made on your device."))
          .finally(() => {
            this.busy = false;
            this.render(model);
          });
      });
    }
    if (this.note) root.createDiv({ cls: "blyg-daily-meta", text: this.note });
    if (!model) {
      root.createDiv({ cls: "blyg-daily-empty", text: "There is no saved list to read yet. Open the reader and let it load, then come back." });
      return;
    }
    this.draw(root, model);
  }

  private draw(root: HTMLElement, m: DailyModel): void {
    root.createDiv({ cls: "blyg-daily-meta", text: `${plural(m.postCount, "post", "posts")} since ${stamp(m.since)}` });
    if (m.postCount === 0 && m.letters.length === 0 && m.corrections.length === 0 && m.retractions.length === 0) {
      root.createDiv({ cls: "blyg-daily-empty", text: "Nothing new in this window." });
      return;
    }
    if (m.front.length > 0) {
      const s = this.section(root, "Front page");
      m.front.forEach((c, i) => this.drawCluster(s, c, this.written[i] ?? null));
      if (m.moreClusters > 0) s.createDiv({ cls: "blyg-daily-meta", text: `and ${plural(m.moreClusters, "more group", "more groups")}` });
    }
    if (m.letters.length > 0) {
      const s = this.section(root, "Letters");
      for (const l of m.letters) {
        const row = s.createDiv({ cls: "blyg-daily-row" });
        const open = row.createEl("button", { cls: "blyg-daily-link", text: `${l.who} ${l.words} your item${l.headline ? `: ${l.headline}` : ""}` });
        open.addEventListener("click", () => {
          if (l.post) void this.host.openPost(l.post);
          else if (l.mention.sourcePage) this.host.openWeb(l.mention.sourcePage);
        });
        row.createDiv({ cls: "blyg-daily-meta", text: stamp(l.when) });
      }
    }
    if (m.corrections.length > 0) {
      const s = this.section(root, "Corrections");
      for (const c of m.corrections) {
        const row = s.createDiv({ cls: "blyg-daily-row" });
        row.createEl("button", { cls: "blyg-daily-link", text: c.headline }).addEventListener("click", () => void this.host.openPost(c.post));
        row.createDiv({ cls: "blyg-daily-meta", text: `${c.post.authorName ?? c.post.subscriptionTitle} · ${c.note}` });
      }
    }
    if (m.retractions.length > 0) {
      const s = this.section(root, "Retractions");
      for (const r of m.retractions) {
        const row = s.createDiv({ cls: "blyg-daily-row" });
        row.createEl("button", { cls: "blyg-daily-link", text: r.headline }).addEventListener("click", () => void this.host.openPost(r.post));
        row.createDiv({ cls: "blyg-daily-meta", text: `${r.post.authorName ?? r.post.subscriptionTitle} · withdrawn` });
      }
    }
  }

  private section(root: HTMLElement, title: string): HTMLElement {
    const s = root.createDiv({ cls: "blyg-daily-section" });
    s.createEl("h3", { text: title });
    return s;
  }

  private drawCluster(into: HTMLElement, c: Cluster, ai: Written | null): void {
    const card = into.createDiv({ cls: "blyg-daily-cluster" });
    const blygs = new Set(c.posts.map((p) => p.subscriptionTitle || p.origin || "")).size;
    const title = card.createEl("button", { cls: "blyg-daily-link blyg-daily-headline", text: ai ? ai.headline : c.headline });
    if (ai) {
      // Generated text: put on the page as text only (never HTML), and labelled.
      if (ai.summary) card.createDiv({ cls: "blyg-daily-summary", text: ai.summary });
      card.createDiv({ cls: "blyg-daily-meta", text: `Written by ${ai.model} from ${plural(ai.posts, "post", "posts")}` });
    }
    card.createDiv({
      cls: "blyg-daily-meta",
      text: [c.posts.length > 1 ? `${plural(c.posts.length, "post", "posts")} in ${plural(blygs, "blyg", "blygs")}` : (c.posts[0]?.authorName ?? c.posts[0]?.subscriptionTitle ?? ""), c.terms.join(" · ")].filter(Boolean).join(" · "),
    });
    const list = card.createDiv({ cls: "blyg-daily-members" });
    const toggle = (open: boolean): void => {
      list.empty();
      if (!open) return;
      for (const p of c.posts) {
        const row = list.createDiv({ cls: "blyg-daily-row" });
        row.createEl("button", { cls: "blyg-daily-link", text: `${p.authorName ?? p.subscriptionTitle}${p.isReply ? " (reply)" : ""}` }).addEventListener("click", () => void this.host.openPost(p));
        if (p.sourceUrl) row.createEl("button", { cls: "blyg-daily-btn", text: "Web" }).addEventListener("click", () => this.host.openWeb(p.sourceUrl ?? ""));
      }
    };
    if (c.posts.length === 1) title.addEventListener("click", () => void this.host.openPost(c.posts[0] as ReadingPost));
    else {
      let open = false;
      title.addEventListener("click", () => toggle((open = !open)));
    }
  }
}
