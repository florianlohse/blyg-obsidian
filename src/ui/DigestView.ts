// The Daily: today's digest, drawn as a newspaper. Drawing only; what goes where is decided in src/digest.
// Posts are other people's words: everything is put on the page with createEl({ text }) (textContent), never as HTML, and nothing is written to the vault.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { Cluster } from "../digest/cluster";
import type { Outcome, Written } from "../digest/llm";
import { leadCount, type Section } from "../digest/sections";
import { firstSentence } from "../digest/cluster";
import { ownWords } from "../digest/quotes";
import { buildDaily, type DailyModel } from "../digest/daily";
import { GROUPING_NOTE, previewOf, summarizeRest } from "../digest/layout";
import { authorOf, authorsLine, keywordsOf } from "../digest/storyMeta";
import { mastheadDate } from "../digest/window";
import type { InboundMention, ReadingPost } from "../studio/reading";
import type { ReaderFont } from "./readerFonts";

export const BLYG_DAILY_VIEW = "blyg-daily";

export interface DigestHost {
  /** The reader's saved list and when it was saved, or null when there is none (the reader has not been opened, or the list is too old). */
  loadList(): Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
  /** Today: local midnight to now. */
  window(): Promise<{ since: number; until: number }>;
  /** The reader's font setting; the digest's type follows it. */
  font(): ReaderFont;
  /** Open a post in the reader, in this leaf, like a feed card; the reader's Back returns to the digest. */
  openPost(post: ReadingPost, leaf: WorkspaceLeaf): Promise<void>;
  /** Show the reader's feed in this leaf. */
  showFeed(leaf: WorkspaceLeaf): Promise<void>;
  openWeb(url: string): void;
  /** The optional AI layer (src/digest/llm.ts); absent or `enabled()` false: the Daily is the deterministic list only. */
  ai?: { enabled(): boolean; cached(clusters: readonly Cluster[]): Promise<Array<Written | null>>; cachedSections?(clusters: readonly Cluster[]): Promise<Section[] | null>; write(clusters: readonly Cluster[]): Promise<Outcome> };
}

const stamp = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const timeOnly = (t: number): string => new Date(t).toLocaleTimeString(undefined, { timeStyle: "short" });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class BlygDailyView extends ItemView {
  private written: Array<Written | null> = [];
  private sections: Section[] | null = null;
  private note = "";
  private busy = false;
  constructor(leaf: WorkspaceLeaf, private readonly host: DigestHost) {
    super(leaf);
  }
  override getViewType(): string {
    return BLYG_DAILY_VIEW;
  }
  override getDisplayText(): string {
    return "Blyg Digest";
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
    try {
      const [list, win] = await Promise.all([this.host.loadList(), this.host.window()]);
      if (list) {
        model = buildDaily(list.posts, list.mentions, win.since, win.until);
      }
    } catch {
      model = null;
    }
    this.note = "";
    this.written = model && this.host.ai?.enabled() ? await this.host.ai.cached(model.front).catch(() => []) : [];
    this.sections = model && this.written.length > 0 && this.host.ai?.enabled() ? await (this.host.ai.cachedSections?.(model.front) ?? Promise.resolve(null)).catch(() => null) : null;
    this.render(model);
  }

  private render(model: DailyModel | null): void {
    const root = this.contentEl;
    root.empty();
    for (const f of ["default", "serif", "sans", "mono"] as const) root.toggleClass(`is-font-${f}`, f === this.host.font());
    const mast = root.createDiv({ cls: "blyg-daily-masthead" });
    mast.createEl("h1", { text: mastheadDate(model?.since ?? Date.now()), cls: "blyg-daily-date" });
    mast.createDiv({ text: "Your digest", cls: "blyg-daily-kicker" });
    const head = root.createDiv({ cls: "blyg-daily-head" });
    const feed = head.createEl("button", { text: "Feed", cls: "blyg-daily-btn", attr: { title: "Back to the reader's feed" } });
    feed.addEventListener("click", () => void this.host.showFeed(this.leaf));
    head.createEl("button", { text: "Refresh", cls: "blyg-daily-btn" }).addEventListener("click", () => void this.refresh());
    const ai = this.host.ai;
    if (model && ai?.enabled() && model.front.length > 0) {
      const btn = head.createEl("button", { cls: "blyg-daily-btn blyg-story-write" });
      this.paintWrite(btn);
      btn.addEventListener("click", () => {
        if (this.busy) return;
        this.busy = true;
        this.paintWrite(btn); // in place: the page does not redraw, so nothing jumps
        void ai
          .write(model.front)
          .then((o) => {
            this.written = o.written;
            this.sections = o.sections ?? null;
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

  /** The Write button: "Write the digest", or, while a run is going, disabled with a spinner. Same width either way. */
  private paintWrite(btn: HTMLElement): void {
    btn.empty();
    if (this.busy) {
      btn.createSpan({ cls: "blyg-story-spinner" });
      btn.createSpan({ text: "Writing the digest…" });
      btn.setAttr("disabled", "true");
      btn.setAttr("aria-busy", "true");
    } else {
      btn.createSpan({ text: "Write the digest" });
      btn.removeAttribute("disabled");
      btn.removeAttribute("aria-busy");
    }
  }

  private draw(root: HTMLElement, m: DailyModel): void {
    root.createDiv({ cls: "blyg-daily-meta", text: `${plural(m.postCount, "post", "posts")} today, as of ${timeOnly(m.until)}` });
    if (m.postCount === 0 && m.letters.length === 0 && m.corrections.length === 0 && m.retractions.length === 0) {
      root.createDiv({ cls: "blyg-daily-empty", text: "Nothing new today yet." });
      return;
    }
    const sections = this.usableSections(m);
    if (sections) return this.drawSectioned(root, m, sections);
    if (m.front.length > 0 || m.mixed.length > 0) {
      const s = this.section(root, "Front page");
      if (m.front.length === 0) s.createDiv({ cls: "blyg-daily-empty", text: "No stories with several posts yet." });
      m.front.forEach((c, i) => this.drawCluster(s, c, this.written[i] ?? null));
      const made = this.written.filter((w): w is Written => w !== null);
      if (made.length > 0) s.createDiv({ cls: "blyg-daily-meta blyg-story-credit", text: `Written by ${made[0]?.model ?? ""} from ${plural(made.reduce((k, w) => k + w.posts, 0), "post", "posts")}` });
      this.drawRest(s, m);
    }
    this.drawLetters(root, m);
    this.drawMixed(root, m);
  }

  /** Letters and changes (corrections, retractions), as on the plain page. */
  private drawLetters(root: HTMLElement, m: DailyModel): void {
    if (m.letters.length > 0) {
      const s = this.section(root, "Letters");
      for (const l of m.letters) {
        const row = s.createDiv({ cls: "blyg-daily-row" });
        const open = row.createEl("button", { cls: "blyg-daily-link", text: `${l.who} ${l.words} your item${l.headline ? `: ${l.headline}` : ""}` });
        open.addEventListener("click", () => {
          if (l.post) void this.host.openPost(l.post, this.leaf);
          else if (l.mention.sourcePage) this.host.openWeb(l.mention.sourcePage);
        });
        row.createDiv({ cls: "blyg-daily-meta", text: stamp(l.when) });
      }
    }
    this.drawChanges(root, m);
  }

  private drawChanges(root: HTMLElement, m: DailyModel): void {
    if (m.corrections.length > 0) {
      const s = this.section(root, "Corrections");
      for (const c of m.corrections) {
        const row = s.createDiv({ cls: "blyg-daily-row" });
        row.createEl("button", { cls: "blyg-daily-link", text: c.headline }).addEventListener("click", () => void this.host.openPost(c.post, this.leaf));
        row.createDiv({ cls: "blyg-daily-meta", text: `${c.post.authorName ?? c.post.subscriptionTitle} · ${c.note}` });
      }
    }
    if (m.retractions.length > 0) {
      const s = this.section(root, "Retractions");
      for (const r of m.retractions) {
        const row = s.createDiv({ cls: "blyg-daily-row" });
        row.createEl("button", { cls: "blyg-daily-link", text: r.headline }).addEventListener("click", () => void this.host.openPost(r.post, this.leaf));
        row.createDiv({ cls: "blyg-daily-meta", text: `${r.post.authorName ?? r.post.subscriptionTitle} · withdrawn` });
      }
    }
  }

  private drawMixed(root: HTMLElement, m: DailyModel): void {
    if (m.mixed.length > 0) {
      const s = this.section(root, "Mixed bag");
      for (const p of m.mixed) {
        const row = s.createDiv({ cls: "blyg-daily-row blyg-story-mixed" });
        row.createEl("button", { cls: "blyg-daily-link blyg-story-who", text: authorOf(p) }).addEventListener("click", () => void this.host.openPost(p, this.leaf));
        const first = firstSentence(ownWords(p));
        if (first) row.createDiv({ cls: "blyg-story-first", text: first });
      }
    }
  }

  /** The sections to draw: only when they match the stories on the page (a stale or odd arrangement is ignored and the plain front page is drawn). */
  private usableSections(m: DailyModel): Section[] | null {
    const sec = this.sections;
    if (!sec || sec.length === 0) return null;
    const all = sec.flatMap((x) => x.ids);
    const fits = all.length === m.front.length && new Set(all).size === all.length && all.every((i) => i >= 0 && i < m.front.length) && this.written.filter(Boolean).length === m.front.length;
    return fits ? sec : null;
  }

  /** With sections: a short lead block (the biggest stories), the sections with their other stories, the Mixed bag, then Letters and changes. */
  private drawSectioned(root: HTMLElement, m: DailyModel, sections: Section[]): void {
    const lead = leadCount(m.front.length);
    const front = this.section(root, "Front page");
    front.addClass("blyg-sections-lead");
    for (let i = 0; i < lead; i++) {
      const c = m.front[i];
      if (c) this.drawCluster(front, c, this.written[i] ?? null);
    }
    for (const sec of sections) {
      const ids = sec.ids.filter((i) => i >= lead);
      if (ids.length === 0) continue;
      const box = this.section(root, sec.name);
      box.addClass("blyg-sections-section");
      for (const i of ids) {
        const c = m.front[i];
        if (c) this.drawCluster(box, c, this.written[i] ?? null);
      }
    }
    const made = this.written.filter((w): w is Written => w !== null);
    const tail = root.createDiv({ cls: "blyg-daily-section" });
    if (made.length > 0) tail.createDiv({ cls: "blyg-daily-meta blyg-story-credit", text: `Written by ${made[0]?.model ?? ""} from ${plural(made.reduce((k, w) => k + w.posts, 0), "post", "posts")}.` });
    this.drawRest(tail, m);
    this.drawMixed(root, m);
    this.drawLetters(root, m);
  }

  /** What is not on the front page, told as it is, with one collapsed list; then the grouping rules in plain words. */
  private drawRest(into: HTMLElement, m: DailyModel): void {
    const rest = summarizeRest(m.rest);
    if (rest.line) {
      const box = into.createDiv({ cls: "blyg-daily-rest" });
      box.createDiv({ cls: "blyg-daily-meta", text: rest.line });
      const open = box.createEl("button", { cls: "blyg-daily-btn", text: `Other posts (${rest.posts.length})` });
      const list = box.createDiv({ cls: "blyg-daily-others" });
      let shown = false;
      open.addEventListener("click", () => {
        shown = !shown;
        list.empty();
        open.setAttr("aria-expanded", String(shown));
        if (!shown) return;
        for (const p of rest.posts) {
          const row = list.createDiv({ cls: "blyg-daily-row blyg-daily-member" });
          row.createEl("button", { cls: "blyg-daily-link blyg-daily-who", text: p.authorName ?? p.subscriptionTitle }).addEventListener("click", () => void this.host.openPost(p, this.leaf));
          const preview = previewOf(p);
          if (preview) row.createDiv({ cls: "blyg-daily-preview", text: preview });
        }
      });
    }
    const how = into.createEl("details", { cls: "blyg-daily-how" });
    how.createEl("summary", { text: "How this is grouped" });
    for (const line of GROUPING_NOTE) how.createEl("p", { text: line, cls: "blyg-daily-meta" });
  }

  private section(root: HTMLElement, title: string): HTMLElement {
    const s = root.createDiv({ cls: "blyg-daily-section" });
    s.createEl("h3", { text: title });
    return s;
  }

  private drawCluster(into: HTMLElement, c: Cluster, ai: Written | null): void {
    const card = into.createDiv({ cls: "blyg-daily-cluster blyg-story" });
    const blygs = new Set(c.posts.map((p) => p.subscriptionTitle || p.origin || "")).size;
    const title = card.createEl("button", { cls: `blyg-daily-link blyg-daily-headline blyg-story-headline blyg-story-font-${this.host.font()}`, text: ai ? ai.headline : c.headline });
    // Generated text: put on the page as text only (never HTML). The "Written by" label is once, under the front page.
    if (ai?.summary) card.createDiv({ cls: "blyg-story-summary", text: ai.summary });
    const names = c.posts.map(authorOf);
    card.createDiv({
      cls: "blyg-daily-meta",
      text: [`${plural(c.posts.length, "post", "posts")} in ${plural(blygs, "blyg", "blygs")}`, authorsLine(c.posts), ai ? "" : keywordsOf(c.terms, names).join(" · ")].filter(Boolean).join(" · "),
    });
    const list = card.createDiv({ cls: "blyg-daily-members" });
    const toggle = (open: boolean): void => {
      list.empty();
      if (!open) return;
      for (const p of c.posts) {
        const row = list.createDiv({ cls: "blyg-daily-row blyg-daily-member" });
        row.createEl("button", { cls: "blyg-daily-link blyg-daily-who", text: `${p.authorName ?? p.subscriptionTitle}${p.isReply ? " (reply)" : ""}` }).addEventListener("click", () => void this.host.openPost(p, this.leaf));
        const preview = previewOf(p);
        if (preview) row.createDiv({ cls: "blyg-daily-preview", text: preview });
      }
    };
    let open = false;
    title.addEventListener("click", () => toggle((open = !open)));
  }
}
