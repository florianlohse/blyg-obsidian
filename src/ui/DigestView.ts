// The Daily: today's digest, drawn as a newspaper. Drawing only; what goes where is decided in src/digest.
// Posts are other people's words: everything is put on the page with createEl({ text }) (textContent), never as HTML, and nothing is written to the vault.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { Cluster } from "../digest/cluster";
import type { Outcome, Written } from "../digest/llm";
import { leadCount, OTHER_NAME, type Section } from "../digest/sections";
import { firstSentence } from "../digest/cluster";
import { ownWords } from "../digest/quotes";
import { buildDaily, type DailyModel } from "../digest/daily";
import type { Grouped } from "../digest/stable";
import { nothingToWriteNote } from "../digest/writeNote";
import { GROUPING_NOTE, previewOf, summarizeRest } from "../digest/layout";
import { authorOf, authorsLine, keywordsOf } from "../digest/storyMeta";
import { mastheadDate } from "../digest/window";
import { isUnread, type InboundMention, type ReadingPost } from "../studio/reading";
import type { PastEdition } from "../digest/history";
import { CAPPED_NOTE } from "../digest/history";
import { addUsage, usageLine } from "../digest/autoWrite";
import { drawPast, drawSwitcher } from "./DigestPast";
import type { ReaderFont } from "./readerFonts";

export const BLYG_DAILY_VIEW = "blyg-daily";

export interface DigestHost {
  /** The reader's saved list and when it was saved, or null when there is none (the reader has not been opened, or the list is too old). */
  loadList(): Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
  /** The current edition for these posts (src/digest/editionHost.ts): its window, and the stories and Mixed bag it has settled. Absent `id`/`grouped`: group the window afresh. */
  edition(posts: readonly ReadingPost[]): Promise<{ id?: number; since: number; until: number; grouped?: Grouped; auto?: { note?: string }; usage?: { tokens: number; cost: number | null } }>;
  /** The saved past editions, newest first (src/digest/history.ts). Absent: no history. */
  history?(): Promise<{ editions: PastEdition[]; capped: boolean }>;
  /** The reader's font setting; the digest's type follows it. */
  font(): ReaderFont;
  /** Open a post in the reader, in this leaf, like a feed card; the reader's Back returns to the digest. */
  openPost(post: ReadingPost, leaf: WorkspaceLeaf): Promise<void>;
  /** Show the reader's feed in this leaf. */
  showFeed(leaf: WorkspaceLeaf): Promise<void>;
  openWeb(url: string): void;
  /** The optional AI layer (src/digest/llm.ts); absent or `enabled()` false: the Daily is the deterministic list only. */
  ai?: {
    enabled(): boolean;
    cached(clusters: readonly Cluster[]): Promise<Array<Written | null>>;
    /** The sections kept for these stories and single posts (the Mixed bag). */
    /** True once, when the digest should write itself now (setting on, consent given, not tried for this edition); it also marks the edition as tried. */
    autoDue?(clusters: readonly Cluster[]): Promise<boolean>;
    cachedSections?(clusters: readonly Cluster[], singles: readonly ReadingPost[]): Promise<Section[] | null>;
    /** Write the digest. `resort`: sort every story and single post into sections again (otherwise only new ones are added to the existing sections). */
    write(clusters: readonly Cluster[], singles: readonly ReadingPost[], opts?: { resort?: boolean; auto?: boolean }): Promise<Outcome>;
  };
}

const stamp = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const timeOnly = (t: number): string => new Date(t).toLocaleTimeString(undefined, { timeStyle: "short" });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class BlygDailyView extends ItemView {
  private written: Array<Written | null> = [];
  private sections: Section[] | null = null;
  private note = "";
  private busy = false;
  private usage: { tokens: number; cost: number | null } | undefined;
  private past: PastEdition[] = [];
  private pastCapped = false;
  private viewing: number | null = null;
  private byId = new Map<string, ReadingPost>();
  private writeBtn: HTMLElement | null = null;
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
    let autoNote = "";
    try {
      const list = await this.host.loadList();
      if (list) {
        this.byId = new Map(list.posts.map((p) => [p.remoteId, p]));
        const win = await this.host.edition(list.posts);
        model = buildDaily(list.posts, list.mentions, win.since, win.until, win.grouped, win.id);
        this.usage = win.usage;
        autoNote = win.auto?.note ?? "";
      }
    } catch {
      model = null;
    }
    const h = await (this.host.history?.() ?? Promise.resolve(null)).catch(() => null);
    this.past = h?.editions ?? [];
    this.pastCapped = h?.capped === true;
    this.note = autoNote;
    this.written = model && this.host.ai?.enabled() ? await this.host.ai.cached(model.front).catch(() => []) : [];
    this.sections = model && this.written.length > 0 && this.host.ai?.enabled() ? await (this.host.ai.cachedSections?.(model.front, model.mixed) ?? Promise.resolve(null)).catch(() => null) : null;
    this.render(model);
    // The automatic write: the plain digest is on the page already; the text replaces it when it is ready.
    const ai = this.host.ai;
    if (model && ai?.enabled() && !this.busy && this.viewing === null && (await (ai.autoDue?.(model.front) ?? Promise.resolve(false)).catch(() => false))) this.run(model, false, true);
  }

  /** "Write the digest" (or the automatic write): in the background; the page redraws when the answer is in. */
  private run(model: DailyModel, resort: boolean, auto = false): void {
    const ai = this.host.ai;
    if (!ai || this.busy) return;
    this.busy = true;
    this.note = "";
    const before = this.written;
    if (this.writeBtn) this.paintWrite(this.writeBtn); // in place: the page does not redraw, so nothing jumps
    void ai
      .write(model.front, model.mixed, { resort, ...(auto ? { auto: true } : {}) })
      .then((o) => {
        this.written = o.written;
        this.sections = o.sections ?? null;
        if (o.status === "ok" && o.tokens) this.usage = addUsage(this.usage, o.tokens, o.cost ?? null);
        this.note = o.note ?? nothingToWriteNote(o, before, model.front.length, model.mixed.length);
        if (o.status === "failed") this.note = auto ? `The automatic write did not work: ${o.note ?? "no reason given"}` : `${o.note ?? "The digest could not be written."} Showing the list made on your device.`;
      })
      .catch(() => (this.note = "The digest could not be written. Showing the list made on your device."))
      .finally(() => {
        this.busy = false;
        this.render(model);
      });
  }

  private render(model: DailyModel | null): void {
    const root = this.contentEl;
    root.empty();
    for (const f of ["default", "serif", "sans", "mono"] as const) root.toggleClass(`is-font-${f}`, f === this.host.font());
    const mast = root.createDiv({ cls: "blyg-daily-masthead" });
    mast.createEl("h1", { text: mastheadDate(this.viewing ?? model?.edition ?? model?.since ?? Date.now()), cls: "blyg-daily-date" });
    mast.createDiv({ text: "Your digest", cls: "blyg-daily-kicker" });
    const today = model?.edition ?? null;
    const pastRec = this.viewing !== null ? this.past.find((e) => e.id === this.viewing) : undefined;
    const ids = [...(today !== null ? [today] : []), ...this.past.map((e) => e.id).filter((id) => id !== today)];
    if (ids.length > 1 || pastRec) drawSwitcher(mast, ids, pastRec ? pastRec.id : (today ?? ids[0] ?? 0), (id) => {
      this.viewing = id === today ? null : id;
      this.render(model);
    });
    if (pastRec) {
      const head = root.createDiv({ cls: "blyg-daily-head" });
      head.createEl("button", { text: "Feed", cls: "blyg-daily-btn", attr: { title: "Back to the reader's feed" } }).addEventListener("click", () => void this.host.showFeed(this.leaf));
      if (this.pastCapped) root.createDiv({ cls: "blyg-daily-meta", text: CAPPED_NOTE });
      drawPast(root, pastRec, this.byId, (p) => void this.host.openPost(p, this.leaf));
      return;
    }
    const head = root.createDiv({ cls: "blyg-daily-head" });
    const feed = head.createEl("button", { text: "Feed", cls: "blyg-daily-btn", attr: { title: "Back to the reader's feed" } });
    feed.addEventListener("click", () => void this.host.showFeed(this.leaf));
    head.createEl("button", { text: "Refresh", cls: "blyg-daily-btn" }).addEventListener("click", () => void this.refresh());
    const ai = this.host.ai;
    if (model && ai?.enabled()) {
      const btn = head.createEl("button", { cls: "blyg-daily-btn blyg-story-write" });
      this.writeBtn = btn;
      this.paintWrite(btn);
      btn.addEventListener("click", () => this.run(model, false));
      if (this.sections) {
        const resort = head.createEl("button", { text: "Re-sort sections", cls: "blyg-daily-btn", attr: { title: "Sort every story and post into sections again, not only the new ones" } });
        resort.addEventListener("click", () => this.run(model, true));
      }
    }
    if (this.note) root.createDiv({ cls: "blyg-daily-meta", text: this.note });
    if (!model) {
      root.createDiv({ cls: "blyg-daily-empty", text: "There is no saved list to read yet. Open the reader and let it load, then come back." });
      return;
    }
    this.draw(root, model);
  }

  /** The Write button: "Write the digest", or, while a run is going, disabled with a spinner. Same width either way. */
  /** The estimate after a write: " · about N tokens, under 1 cent". */
  private footer(): string {
    return this.usage ? ` · ${usageLine(this.usage)}` : "";
  }

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
    root.createDiv({ cls: "blyg-daily-meta", text: `${plural(m.postCount, "post", "posts")} in this edition, as of ${timeOnly(m.until)}` });
    if (m.postCount === 0 && m.letters.length === 0 && m.corrections.length === 0 && m.retractions.length === 0) {
      root.createDiv({ cls: "blyg-daily-empty", text: "Nothing new in this edition yet." });
      return;
    }
    const sections = this.usableSections(m);
    if (sections) return this.drawSectioned(root, m, sections);
    if (m.front.length > 0 || m.mixed.length > 0) {
      const s = this.section(root, "Front page");
      if (m.front.length === 0) s.createDiv({ cls: "blyg-daily-empty", text: "No stories with several posts yet." });
      m.front.forEach((c, i) => this.drawCluster(s, c, this.written[i] ?? null));
      const made = this.written.filter((w): w is Written => w !== null);
      if (made.length > 0) s.createDiv({ cls: "blyg-daily-meta blyg-story-credit", text: `Written by ${made[0]?.model ?? ""} from ${plural(made.reduce((k, w) => k + w.posts, 0), "post", "posts")}${this.footer()}` });
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

  /** A single post as a compact row: author, then its first sentence. Opens in the reader; Back returns here. */
  private drawSingle(into: HTMLElement, p: ReadingPost): void {
    const row = into.createDiv({ cls: `blyg-daily-row blyg-story-mixed${isUnread(p) ? "" : " blyg-is-read"}` });
    row.createEl("button", { cls: "blyg-daily-link blyg-story-who", text: authorOf(p) }).addEventListener("click", () => void this.host.openPost(p, this.leaf));
    const first = firstSentence(ownWords(p));
    if (first) row.createDiv({ cls: "blyg-story-first", text: first });
  }

  /** The Mixed bag: the single posts no section holds (all of them on the plain page). */
  private drawMixed(root: HTMLElement, m: DailyModel, placed: ReadonlySet<string> = new Set()): void {
    const posts = m.mixed.filter((p) => !placed.has(p.remoteId));
    if (posts.length > 0) {
      const s = this.section(root, "Mixed bag");
      for (const p of posts) this.drawSingle(s, p);
    }
  }

  /** The sections to draw, cleaned against what is on the page: a number out of range, a post that is not in the Mixed bag, or one that is in two sections is dropped; a story no section holds goes to Other. null: the plain front page. */
  private usableSections(m: DailyModel): Section[] | null {
    const sec = this.sections;
    if (!sec || sec.length === 0 || !this.written.some(Boolean)) return null;
    const seen = new Set<number>();
    const seenPosts = new Set<string>();
    const single = new Set(m.mixed.map((p) => p.remoteId));
    const out: Section[] = sec.map((x) => ({
      name: x.name,
      ids: x.ids.filter((i) => Number.isInteger(i) && i >= 0 && i < m.front.length && !seen.has(i) && !!seen.add(i)),
      posts: (x.posts ?? []).filter((id) => single.has(id) && !seenPosts.has(id) && !!seenPosts.add(id)),
    }));
    const lost = m.front.map((_, i) => i).filter((i) => !seen.has(i));
    if (lost.length > 0) {
      const other = out.find((x) => x.name === OTHER_NAME);
      if (other) other.ids.push(...lost);
      else out.push({ name: OTHER_NAME, ids: lost, posts: [] });
    }
    return out.filter((x) => x.ids.length + (x.posts?.length ?? 0) > 0);
  }

  /** With sections: a short lead block (the biggest stories), then each section with its stories first and its single posts after, the Mixed bag (only the posts no section holds), then Letters and changes. */
  private drawSectioned(root: HTMLElement, m: DailyModel, sections: Section[]): void {
    const lead = leadCount(m.front.length);
    const front = this.section(root, "Front page");
    front.addClass("blyg-sections-lead");
    for (let i = 0; i < lead; i++) {
      const c = m.front[i];
      if (c) this.drawCluster(front, c, this.written[i] ?? null);
    }
    const byId = new Map(m.mixed.map((p) => [p.remoteId, p]));
    const placed = new Set<string>();
    for (const sec of sections) {
      const ids = sec.ids.filter((i) => i >= lead);
      const singles = (sec.posts ?? []).flatMap((id) => byId.get(id) ?? []);
      if (ids.length + singles.length === 0) continue;
      const box = this.section(root, sec.name);
      box.addClass("blyg-sections-section");
      for (const i of ids) {
        const c = m.front[i];
        if (c) this.drawCluster(box, c, this.written[i] ?? null);
      }
      for (const p of singles) {
        this.drawSingle(box, p);
        placed.add(p.remoteId);
      }
    }
    const made = this.written.filter((w): w is Written => w !== null);
    const tail = root.createDiv({ cls: "blyg-daily-section" });
    if (made.length > 0) tail.createDiv({ cls: "blyg-daily-meta blyg-story-credit", text: `Written by ${made[0]?.model ?? ""} from ${plural(made.reduce((k, w) => k + w.posts, 0), "post", "posts")}${this.footer()}.` });
    this.drawRest(tail, m);
    this.drawMixed(root, m, placed);
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
    const card = into.createDiv({ cls: `blyg-daily-cluster blyg-story${c.posts.every((p) => !isUnread(p)) ? " blyg-is-read" : ""}` });
    const blygs = new Set(c.posts.map((p) => p.subscriptionTitle || p.origin || "")).size;
    const title = card.createEl("button", { cls: `blyg-daily-link blyg-daily-headline blyg-story-headline blyg-story-font-${this.host.font()}`, text: ai ? ai.headline : c.headline });
    // Generated text: put on the page as text only (never HTML). The "Written by" label is once, under the front page.
    if (ai?.summary) card.createDiv({ cls: "blyg-story-summary", text: ai.summary });
    const names = c.posts.map(authorOf);
    const meta = card.createDiv({
      cls: "blyg-daily-meta",
      text: [`${plural(c.posts.length, "post", "posts")} in ${plural(blygs, "blyg", "blygs")}`, authorsLine(c.posts), ai ? "" : keywordsOf(c.terms, names).join(" · ")].filter(Boolean).join(" · "),
    });
    const fresh = new Set(ai?.fresh ?? []);
    if (fresh.size > 0) meta.createSpan({ cls: "blyg-story-updated", text: ` +${plural(fresh.size, "new post", "new posts")}` });
    const list = card.createDiv({ cls: "blyg-daily-members" });
    const toggle = (open: boolean): void => {
      list.empty();
      if (!open) return;
      for (const p of c.posts) {
        const row = list.createDiv({ cls: `blyg-daily-row blyg-daily-member${fresh.has(p.remoteId) ? " blyg-is-new" : ""}${isUnread(p) ? "" : " blyg-is-read"}` });
        row.createEl("button", { cls: "blyg-daily-link blyg-daily-who", text: `${p.authorName ?? p.subscriptionTitle}${p.isReply ? " (reply)" : ""}` }).addEventListener("click", () => void this.host.openPost(p, this.leaf));
        const preview = previewOf(p);
        if (preview) row.createDiv({ cls: "blyg-daily-preview", text: preview });
      }
    };
    let open = false;
    title.addEventListener("click", () => toggle((open = !open)));
  }
}
