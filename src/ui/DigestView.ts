// The Daily: today's digest, drawn as a newspaper. Drawing only; what goes where is decided in src/digest.
// Posts are other people's words: everything is put on the page with createEl({ text }) (textContent), never as HTML, and nothing is written to the vault.
import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { Cluster } from "../digest/cluster";
import type { Outcome, Written } from "../digest/llm";
import { leadCount, OTHER_NAME, type Section } from "../digest/sections";
import { buildDaily, type Correction, type DailyModel } from "../digest/daily";
import { NOTES_PER_DRAW } from "../digest/changeNotes";
import type { Grouped } from "../digest/stable";
import { nothingToWriteNote } from "../digest/writeNote";
import { GROUPING_NOTE, previewOf, summarizeRest } from "../digest/layout";
import { authorOf, authorsLine, keywordsOf } from "../digest/storyMeta";
import { mastheadDate } from "../digest/window";
import { byNewestPost, drawnSections, type Drawn } from "../digest/order";
import { byLine, contentLine } from "../digest/singleLine";
import { markable, realSleep, unmarkable, sharedMarks, watchMarks, type MarkQueue } from "../digest/markQueue";
import { forgetScroll, recalledScroll, rememberScroll, scrollKey, setStoryUnfolded, storyUnfolded, takeJump } from "../digest/scrollMemory";
import { drawToc, type TocEntry } from "./DigestToc";
import { addStoryMark } from "./storyOpen";
import { MIXED_BAG, TOP_STORIES, sectionLabel } from "../digest/labels";
import { quickPost, quickStory } from "./quickMenu";
import { setReaderMode } from "./readerMode";
import { drawBar } from "./DigestBar";
import { publishPlacement } from "../digest/placement";
import { isUnread, type InboundMention, type ReadingPost } from "../studio/reading";
import type { PastEdition } from "../digest/history";
import { CAPPED_NOTE } from "../digest/history";
import { addUsage, usageLine } from "../digest/autoWrite";
import { drawPast, drawSwitcher } from "./DigestPast";
import { drawEditorLine } from "./digestEditorLine";
import type { ShelfFacade } from "../app/shelfService";
import type { ReaderFont } from "./readerFonts";

export const BLYG_DAILY_VIEW = "blyg-daily";

export interface DigestHost {
  /** The reader's saved list and when it was saved, or null when there is none (the reader has not been opened, or the list is too old). */
  loadList(): Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
  /** Refresh, the feed's action (src/app/readerRefresh.ts): ask the Studio to fetch, read the list once, keep it. No AI request here (the digest's Refresh may write texts afterwards, see `ai.autoOn`). Absent: Refresh reads the saved list again. */
  refresh?(o: { held: { posts: ReadingPost[]; mentions: InboundMention[] } | null; alive: () => boolean; status: (text: string) => void }): Promise<{ ok: true; list: { posts: ReadingPost[]; mentions: InboundMention[] }; note?: string } | { ok: false; message: string; cancelled?: true }>;
  /** The current edition for these posts (src/digest/editionHost.ts): its window, and the stories and Mixed bag it has settled. Absent `id`/`grouped`: group the window afresh. */
  edition(posts: readonly ReadingPost[]): Promise<{ id?: number; since: number; until: number; grouped?: Grouped; auto?: { note?: string }; usage?: { tokens: number; cost: number | null }; editor?: string }>;
  /** The saved past editions, newest first (src/digest/history.ts). Absent: no history. */
  history?(): Promise<{ editions: PastEdition[]; capped: boolean }>;
  /** The reader's font setting; the digest's type follows it. */
  font(): ReaderFont;
  /** Open a post in the reader, in this leaf, like a feed card; the reader's Back returns to the digest. `order`: every post of the page, top to bottom (what Next and Previous walk). */
  openPost(post: ReadingPost, leaf: WorkspaceLeaf, order?: readonly ReadingPost[]): Promise<void>;
  /** Show the reader's feed in this leaf. */
  showFeed(leaf: WorkspaceLeaf): Promise<void>;
  openWeb(url: string): void;
  /** The change note of a revised post (src/digest/changeNotes.ts: read lazily, once per item and version); "" when there is none. Absent: no lookup. */
  changeNote?(post: ReadingPost): Promise<string>;
  /** Mark one post read in the Studio by the reader's own path (permission `reading:state`). Absent: the digest has no "Mark read" buttons. */
  markRead?(post: ReadingPost): Promise<{ ok: boolean; message?: string }>;
  /** Reply to a post by the reader's own path (a new reply thread). Absent: the quick menu has no Reply. */
  replyTo?(post: ReadingPost): Promise<void>;
  /** The shelf (SH1): the quick menu's "Save for later" / "Remove from saved". Absent: no such entry. */
  shelf?: ShelfFacade;
  /** Mark one post unread again by the reader's own path (same permission). Absent: the read symbol only marks. */
  markUnread?(post: ReadingPost): Promise<{ ok: boolean; message?: string }>;
  /** The muted lines under the masthead (who made the edition, synced from n devices, waiting for sync); also reads the synced files again. */
  syncLines?(editionId: number | null): Promise<string[]>;
  /** Called when a file of another device changed what the Daily would show; returns the unsubscribe. */
  watchSync?(fn: () => void): () => void;
  /** The optional AI layer (src/digest/llm.ts); absent or `enabled()` false: the Daily is the deterministic list only. */
  ai?: {
    enabled(): boolean;
    cached(clusters: readonly Cluster[]): Promise<Array<Written | null>>;
    /** The sections kept for these stories and single posts (the Mixed bag). */
    /** True once, when the digest should write itself now (setting on, consent given, not tried for this edition); it also marks the edition as tried. */
    autoDue?(clusters: readonly Cluster[]): Promise<boolean>;
    /** True when Refresh may write the missing texts by itself: the AI layer on, "Write the digest automatically" on, and consent recorded for the provider's host. Absent: false (Refresh never sends). */
    autoOn?(): Promise<boolean>;
    /** The tokens all devices used today (the synced usage); null: not readable. Shown in the footer next to this edition's usage. */
    sharedToday?(): Promise<number | null>;
    cachedSections?(clusters: readonly Cluster[], singles: readonly ReadingPost[]): Promise<Section[] | null>;
    /** Write the digest. `resort`: sort every story and single post into sections again (otherwise only new ones are added to the existing sections). */
    write(clusters: readonly Cluster[], singles: readonly ReadingPost[], opts?: { resort?: boolean; auto?: boolean }): Promise<Outcome>;
  };
}

/** What each button of the menu does and costs (shown under it). */
const REFRESH_HINT = "Fetches new posts from your blygs, no AI, no cost";
const REFRESH_AI_HINT = "Fetches new posts from your blygs and groups them. Writes the missing texts only if “Write the digest automatically” is on (uses tokens).";
const NOT_WRITTEN = "grouped, texts not written (automatic writing is off)"; // one short line: the status must not wrap and push the page down
const WRITE_HINT = "Writes headlines and summaries with your AI model, uses tokens";
const RESORT_HINT = "Sorts every story and post into sections again, uses tokens";
const stamp = (t: number): string => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const timeOnly = (t: number): string => new Date(t).toLocaleTimeString(undefined, { timeStyle: "short" });
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** The posts in these stories (what a heading's counter says: posts, not stories). */
const postsIn = (stories: readonly Cluster[]): number => stories.reduce((k, c) => k + c.posts.length, 0);

export class BlygDailyView extends ItemView {
  private written: Array<Written | null> = [];
  private sections: Section[] | null = null;
  private note = "";
  private busy = false;
  private usage: { tokens: number; cost: number | null } | undefined;
  /** Tokens all devices used today, from the synced files (the daily ceiling counts this); null: not known. */
  private sharedToday: number | null = null;
  private past: PastEdition[] = [];
  private pastCapped = false;
  /** The editor that wrote today's edition (absent: neutral). */
  private editorId: string | undefined;
  private viewing: number | null = null;
  private byId = new Map<string, ReadingPost>();
  private writeBtn: HTMLElement | null = null;
  /** The section boxes drawn now, by name (the table of contents and the reader's chip scroll to them), and the section a chip asked for. */
  private sectionEls = new Map<string, HTMLElement>();
  private wantSection: string | null = null;
  /** The edition the page shows now (today's), for the unfold memory. */
  private edition: number | null = null;
  /** The page whose scroll position is kept (an edition's id, see digest/scrollMemory.ts); null until something is drawn. */
  private drawnKey: string | null = null;
  /** The posts of the page as drawn, top to bottom: every story's posts, the singles, the rest and the changes, each once. Opening a post hands it to the reader as the list Next and Previous walk. */
  private order: ReadingPost[] = [];
  /** Repainters of the "read" look of what is drawn (a card dims, a button goes) when a mark changes; filled while drawing. */
  private readPainters: Array<() => void> = [];
  private markStatus: HTMLElement | null = null;
  /** The menu's "Advanced" part (the manual writes): folded until opened, kept over redraws. */
  private advancedOpen = false;
  /** The sticky bar's menu: folded until the person opens it (kept over redraws). */
  private bar = { open: false };
  /** The contents of the page being drawn: one entry per heading, pushed by section() as the heading is drawn, so the contents can never differ from the page. */
  private toc: TocEntry[] = [];
  /** The list the page was made from (kept so Refresh merges into it), and the posts drawn last: what a refresh adds is marked "new". */
  private list: { posts: ReadingPost[]; mentions: InboundMention[] } | null = null;
  private shown: Set<string> | null = null;
  private added = new Set<string>();
  /** Reading the list or a Refresh is going: the Refresh buttons show it and ignore a second tap. `runs` replaces a Refresh that a newer open has overtaken. */
  private working = false;
  private runs = 0;
  private refreshBtns: HTMLElement[] = [];
  /** The lines under the masthead about the synced files, and the unsubscribe of the watch on them. */
  private syncText: string[] = [];
  private unwatchSync: (() => void) | null = null;
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
    setReaderMode("digest"); // this leaf shows the digest now: the reader's mode is the Digest until the person switches back
    watchMarks({ change: () => this.readPainters.forEach((f) => f()), reverted: (m) => this.say(m) });
    this.unwatchSync = this.host.watchSync?.(() => void this.redrawSynced()) ?? null;
    if (this.host.shelf?.on()) {
      this.host.shelf.reset(); // a Daily opening reads the shelf once (SH1)
      void this.host.shelf.opening();
    }
    await this.refresh();
  }
  override async onClose(): Promise<void> {
    this.runs++;
    this.unwatchSync?.();
    this.unwatchSync = null;
    watchMarks(null);
    return Promise.resolve();
  }

  /** The queue that marks posts read (one for the plugin session), or null when the host cannot mark. */
  private queue(): MarkQueue | null {
    const host = this.host;
    return host.markRead ? sharedMarks((p) => host.markRead?.(p) ?? Promise.resolve({ ok: false }), realSleep, Date.now, host.markUnread ? (p) => host.markUnread?.(p) ?? Promise.resolve({ ok: false }) : undefined) : null;
  }
  private say(text: string): void {
    this.note = text;
    if (this.markStatus) this.markStatus.textContent = text;
  }

  /** Keep where the page is scrolled to, under its edition (it is made again when the person comes Back from a post). */
  private saveScroll(): void {
    if (this.drawnKey !== null) rememberScroll(this.drawnKey, this.contentEl.scrollTop ?? 0);
  }

  /** Open a post in the reader: the position is kept first, so Back returns to the same place. Next and Previous there walk the whole page's order, whichever post this is. */
  private openEntry(p: ReadingPost): void {
    this.saveScroll();
    void this.host.openPost(p, this.leaf, this.order);
  }
  /** `p` is on the page now: it joins the order Next and Previous walk (once, at its first place). */
  private seen(p: ReadingPost | null | undefined): void {
    if (p) this.order.push(p);
  }

  /** Opening the page (and the fallback Refresh): read the saved list and draw it; the automatic write follows when it is due. */
  private async refresh(): Promise<void> {
    const root = this.contentEl;
    const run = ++this.runs;
    this.saveScroll();
    root.empty();
    root.createDiv({ cls: "blyg-daily-status", text: "Reading your list…" });
    this.setWorking(true);
    let model: DailyModel | null = null;
    let autoNote = "";
    try {
      const list = await this.host.loadList();
      if (run !== this.runs) return;
      if (list) ({ model, autoNote } = await this.makeModel(list, list.savedAt));
    } catch {
      model = null;
    } finally {
      if (run === this.runs) this.setWorking(false);
    }
    if (run !== this.runs) return;
    await this.finishOpen(model, autoNote);
  }

  /** The Refresh button, the same action as the feed's: the Studio is asked to fetch, the list is read once, and the new posts join the edition on the page without any AI request. Drawn once, in place. */
  private async refreshNow(): Promise<void> {
    if (this.working) return;
    const run = ++this.runs;
    this.setWorking(true);
    this.say("Checking your blygs…");
    try {
      if (!this.host.refresh) return void (await this.refreshSaved(run));
      const got = await this.host.refresh({ held: this.list, alive: () => run === this.runs && this.contentEl.isConnected, status: (t) => this.say(t) });
      if (run !== this.runs || (!got.ok && got.cancelled)) return;
      if (!got.ok) return this.say(got.message || "Could not check your blygs.");
      const { model } = await this.makeModel(got.list, Date.now(), true);
      if (run !== this.runs) return;
      const n = this.added.size;
      this.note = [got.note ?? "", n > 0 ? `${plural(n, "new post", "new posts")}` : "Nothing new"].filter(Boolean).join(" · ");
      this.written = model && this.host.ai?.enabled() ? await this.host.ai.cached(model.front).catch(() => []) : [];
      this.sections = model && this.written.length > 0 && this.host.ai?.enabled() ? await (this.host.ai.cachedSections?.(model.front, model.mixed) ?? Promise.resolve(null)).catch(() => null) : null;
      if (run === this.runs) this.render(model);
      if (run === this.runs && model) await this.writeMissing(model, this.note, run);
    } catch {
      if (run === this.runs) this.say("Could not check your blygs.");
    } finally {
      if (run === this.runs) this.setWorking(false);
    }
  }

  /**
   * After a Refresh: the texts missing for new or changed stories are written, but only by the rules of the automatic write (setting on, consent recorded, the daily ceiling; nothing is
   * asked). With automatic writing off nothing is sent and one plain line says so; "Write the digest" (under Advanced) stays the way to write them.
   */
  private async writeMissing(model: DailyModel, lead: string, run: number): Promise<void> {
    const ai = this.host.ai;
    if (!ai?.enabled() || this.busy || (this.written.every((w) => w !== null) && this.added.size === 0)) return;
    if (!(await (ai.autoOn?.() ?? Promise.resolve(false)).catch(() => false))) {
      if (this.added.size > 0 && run === this.runs) this.say((this.note = [lead, NOT_WRITTEN].filter(Boolean).join(" · ")));
      return;
    }
    if (run === this.runs) await this.run(model, false, true, lead);
  }

  /** A file of another device changed (DG16): read the edition, the history and the texts again and draw them in place. Nothing is asked of the Studio or the AI. */
  private async redrawSynced(): Promise<void> {
    if (this.working || this.busy || !this.list || !this.contentEl.isConnected) return;
    const run = ++this.runs;
    try {
      const { model } = await this.makeModel(this.list, Date.now());
      const h = await (this.host.history?.() ?? Promise.resolve(null)).catch(() => null);
      if (run !== this.runs) return;
      this.past = h?.editions ?? this.past;
      this.written = model && this.host.ai?.enabled() ? await this.host.ai.cached(model.front).catch(() => []) : [];
      this.sections = model && this.written.length > 0 && this.host.ai?.enabled() ? await (this.host.ai.cachedSections?.(model.front, model.mixed) ?? Promise.resolve(null)).catch(() => null) : null;
      if (run === this.runs) this.render(model);
    } catch {
      /* the page stays as it was */
    }
  }

  /** Without a Studio conversation (a host that cannot ask): read the saved list again, in place. */
  private async refreshSaved(run: number): Promise<void> {
    const list = await this.host.loadList();
    if (run !== this.runs || !list) return this.say("There is no saved list to read yet.");
    const { model } = await this.makeModel(list, list.savedAt, true);
    this.note = this.added.size > 0 ? plural(this.added.size, "new post", "new posts") : "Nothing new";
    if (run === this.runs) this.render(model);
  }

  /** The edition's model for this list. `mark`: what the page did not show before is marked new. */
  private async makeModel(list: { posts: ReadingPost[]; mentions: InboundMention[] }, savedAt: number, mark = false): Promise<{ model: DailyModel; autoNote: string }> {
    this.queue()?.apply(list.posts, savedAt);
    this.list = { posts: list.posts, mentions: list.mentions };
    this.byId = new Map(list.posts.map((p) => [p.remoteId, p]));
    const win = await this.host.edition(list.posts);
    const model = buildDaily(list.posts, list.mentions, win.since, win.until, win.grouped, win.id);
    this.usage = win.usage;
    this.sharedToday = (await this.host.ai?.sharedToday?.().catch(() => null)) ?? null;
    this.syncText = (await this.host.syncLines?.(win.id ?? null).catch(() => [])) ?? [];
    this.editorId = win.editor;
    const ids = new Set([...model.front.flatMap((c) => c.posts.map((p) => p.remoteId)), ...model.mixed.map((p) => p.remoteId)]);
    this.added = mark && this.shown ? new Set([...ids].filter((id) => !this.shown?.has(id))) : new Set();
    this.shown = ids;
    return { model, autoNote: win.auto?.note ?? "" };
  }

  private async finishOpen(model: DailyModel | null, autoNote: string): Promise<void> {
    const h = await (this.host.history?.() ?? Promise.resolve(null)).catch(() => null);
    this.past = h?.editions ?? [];
    this.pastCapped = h?.capped === true;
    this.note = autoNote;
    const jump = takeJump(); // the reader's "In the digest" chip: this edition, at that section
    if (jump) {
      this.viewing = jump.edition === model?.edition ? null : jump.edition;
      this.wantSection = jump.section;
      forgetScroll(scrollKey(jump.edition));
    }
    this.written = model && this.host.ai?.enabled() ? await this.host.ai.cached(model.front).catch(() => []) : [];
    this.sections = model && this.written.length > 0 && this.host.ai?.enabled() ? await (this.host.ai.cachedSections?.(model.front, model.mixed) ?? Promise.resolve(null)).catch(() => null) : null;
    this.render(model);
    // The automatic write: the plain digest is on the page already; the text replaces it when it is ready.
    const ai = this.host.ai;
    if (model && ai?.enabled() && !this.busy && this.viewing === null && (await (ai.autoDue?.(model.front) ?? Promise.resolve(false)).catch(() => false))) void this.run(model, false, true);
  }

  /** The Refresh buttons (the bar's icon and the menu's entry): busy while a read or a Refresh runs; in place, so the page does not redraw. */
  private setWorking(on: boolean): void {
    this.working = on;
    this.refreshBtns = this.refreshBtns.filter((b) => b.isConnected !== false);
    this.refreshBtns.forEach((b) => this.paintRefresh(b));
  }
  private paintRefresh(btn: HTMLElement): void {
    btn.toggleClass("is-busy", this.working);
    if (this.working) {
      btn.setAttr("disabled", "true");
      btn.setAttr("aria-busy", "true");
    } else {
      btn.removeAttribute("disabled");
      btn.removeAttribute("aria-busy");
    }
  }

  /** "Write the digest" (or the automatic write, or the write after a Refresh): in the background; the page redraws when the answer is in. `lead`: what the status says first. */
  private run(model: DailyModel, resort: boolean, auto = false, lead = ""): Promise<void> {
    const ai = this.host.ai;
    if (!ai || this.busy) return Promise.resolve();
    this.busy = true;
    this.note = lead;
    const before = this.written;
    if (this.writeBtn) this.paintWrite(this.writeBtn); // in place: the page does not redraw, so nothing jumps
    return ai
      .write(model.front, model.mixed, { resort, ...(auto ? { auto: true } : {}) })
      .then((o) => {
        this.written = o.written;
        this.sections = o.sections ?? null;
        if (o.status === "ok" && o.tokens) this.usage = addUsage(this.usage, o.tokens, o.cost ?? null);
        if (o.status === "ok" && o.tokens && this.sharedToday !== null) this.sharedToday += o.tokens; // this write is now part of today's total
        this.note = o.note ?? nothingToWriteNote(o, before, model.front.length, model.mixed.length);
        if (o.status === "failed") this.note = auto ? `The automatic write did not work: ${o.note ?? "no reason given"}` : `${o.note ?? "The digest could not be written."} Showing the list made on your device.`;
        if (lead && this.note !== lead) this.note = [lead, this.note].filter(Boolean).join(" · ");
      })
      .catch(() => void (this.note = "The digest could not be written. Showing the list made on your device."))
      .finally(() => {
        this.busy = false;
        this.render(model);
      });
  }

  private render(model: DailyModel | null): void {
    this.edition = model?.edition ?? null;
    this.paint(model);
    this.drawnKey = scrollKey(this.viewing ?? model?.edition);
    const root = this.contentEl;
    const want = this.wantSection !== null ? this.sectionEls.get(sectionLabel(this.wantSection)) : undefined;
    this.wantSection = null;
    const put = (): void => (want ? want.scrollIntoView?.({ block: "start" }) : void (root.scrollTop = recalledScroll(this.drawnKey ?? "") ?? 0));
    put();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(put); // once more after layout
  }

  private paint(model: DailyModel | null): void {
    const root = this.contentEl;
    this.saveScroll();
    this.sectionEls = new Map();
    this.toc = [];
    this.readPainters = [];
    this.order = [];
    this.refreshBtns = [];
    publishPlacement(undefined, null); // set again by a page with sections
    root.empty();
    for (const f of ["default", "serif", "sans", "mono"] as const) root.toggleClass(`is-font-${f}`, f === this.host.font());
    const bar = drawBar(root, { date: mastheadDate(this.viewing ?? model?.edition ?? model?.since ?? Date.now()), kicker: "Your digest", state: this.bar, toggle: () => void this.host.showFeed(this.leaf), refresh: { hint: REFRESH_HINT, click: () => void this.refreshNow(), made: (b) => (this.refreshBtns.push(b), this.paintRefresh(b)) } });
    if (this.syncText.length > 0) for (const t of this.syncText) root.createDiv({ cls: "blyg-daily-meta blyg-daily-sync", text: t });
    drawEditorLine(root, this.viewing !== null ? this.past.find((e) => e.id === this.viewing)?.editor : this.host.ai?.enabled() && this.written.some(Boolean) ? this.editorId : undefined, this.viewing !== null);
    const today = model?.edition ?? null;
    const pastRec = this.viewing !== null ? this.past.find((e) => e.id === this.viewing) : undefined;
    const ids = [...(today !== null ? [today] : []), ...this.past.map((e) => e.id).filter((id) => id !== today)];
    if (ids.length > 1 || pastRec) drawSwitcher(bar.panel, ids, pastRec ? pastRec.id : (today ?? ids[0] ?? 0), (id) => {
      this.viewing = id === today ? null : id;
      this.render(model);
    });
    if (pastRec) {
      if (this.pastCapped) root.createDiv({ cls: "blyg-daily-meta", text: CAPPED_NOTE });
      drawPast(root, pastRec, this.byId, { open: (p) => this.openEntry(p), seen: (p) => this.seen(p), section: (name, el) => this.sectionEls.set(name, el), go: (name) => this.goTo(name) });
      return;
    }
    // One update action in the menu, with what it does and what it costs in plain words; the manual writes are under "Advanced".
    const entry = (hint: string, make: (box: HTMLElement) => HTMLElement, into: HTMLElement = bar.panel): HTMLElement => {
      const box = into.createDiv({ cls: "blyg-daily-entry" });
      const btn = make(box);
      box.createDiv({ cls: "blyg-daily-hint", text: hint });
      return btn;
    };
    const hint = this.host.ai?.enabled() ? REFRESH_AI_HINT : REFRESH_HINT;
    const rbtn = entry(hint, (box) => {
      const b = box.createEl("button", { cls: "blyg-daily-btn blyg-daily-refreshbtn", attr: { title: hint } });
      setIcon(b.createSpan({ cls: "blyg-daily-refreshicon" }), "refresh-cw");
      b.createSpan({ text: "Refresh" });
      b.addEventListener("click", () => void this.refreshNow());
      return b;
    });
    this.refreshBtns.push(rbtn);
    this.paintRefresh(rbtn);
    const ai = this.host.ai;
    if (model && ai?.enabled()) {
      const adv = bar.panel.createEl("details", { cls: "blyg-daily-advanced" });
      adv.createEl("summary", { text: "Advanced" });
      if (this.advancedOpen) adv.setAttr("open", "true");
      adv.addEventListener("toggle", () => (this.advancedOpen = adv.hasAttribute("open")));
      const btn = entry(WRITE_HINT, (box) => box.createEl("button", { cls: "blyg-daily-btn blyg-story-write", attr: { title: WRITE_HINT } }), adv);
      this.writeBtn = btn;
      this.paintWrite(btn);
      btn.addEventListener("click", () => void this.run(model, false));
      if (this.sections) {
        const resort = entry(RESORT_HINT, (box) => box.createEl("button", { text: "Re-sort sections", cls: "blyg-daily-btn", attr: { title: RESORT_HINT } }), adv);
        resort.addEventListener("click", () => void this.run(model, true));
      }
    }
    this.markStatus = root.createDiv({ cls: "blyg-daily-meta blyg-daily-markstatus", text: this.note });
    if (!model) {
      root.createDiv({ cls: "blyg-daily-empty", text: "There is no saved list to read yet. Open the reader and let it load, then come back." });
      return;
    }
    this.draw(root, model);
  }

  /** The Write button: "Write the digest", or, while a run is going, disabled with a spinner. Same width either way. */
  /** The estimate after a write: " · about N tokens, under 1 cent". */
  private footer(): string {
    const today = this.sharedToday !== null && this.sharedToday > 0 ? ` · ${this.sharedToday} tokens today on all your devices` : "";
    return this.usage ? ` · ${usageLine(this.usage)}${today}` : "";
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
    const tocSlot = root.createDiv(); // the contents go here once the page below is drawn (a line per heading drawn, in the order drawn)
    if (sections) this.drawSectioned(root, m, sections);
    else this.drawPlain(root, m);
    if (sections || this.toc.length > 1) drawToc(tocSlot, this.toc, (name) => this.goTo(name)); // the plain page with one heading needs no contents
  }

  private drawPlain(root: HTMLElement, m: DailyModel): void {
    if (m.front.length > 0 || m.mixed.length > 0) {
      const s = this.section(root, TOP_STORIES, postsIn(m.front));
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
      const s = this.section(root, "Letters", m.letters.length);
      for (const l of m.letters) {
        this.seen(l.post);
        const row = s.createDiv({ cls: "blyg-daily-row" });
        const open = row.createEl("button", { cls: "blyg-daily-link", text: `${l.who} ${l.words} your item${l.headline ? `: ${l.headline}` : ""}` });
        open.addEventListener("click", () => {
          if (l.post) this.openEntry(l.post);
          else if (l.mention.sourcePage) this.host.openWeb(l.mention.sourcePage);
        });
        row.createDiv({ cls: "blyg-daily-meta", text: stamp(l.when) });
      }
    }
    this.drawChanges(root, m);
  }

  private drawChanges(root: HTMLElement, m: DailyModel): void {
    if (m.corrections.length > 0) {
      const s = this.section(root, "Corrections", m.corrections.length);
      const lazy: Array<{ c: Correction; row: HTMLElement; head: HTMLElement }> = [];
      for (const c of m.corrections) {
        this.seen(c.post);
        const row = s.createDiv({ cls: "blyg-daily-row" });
        // The author's change note leads (bold) when the data holds one; the headline is secondary. No note: the line is as before.
        if (c.note) row.createEl("button", { cls: "blyg-daily-link blyg-correction-note", text: c.note }).addEventListener("click", () => this.openEntry(c.post));
        const head = row.createEl("button", { cls: c.note ? "blyg-daily-link blyg-correction-headline" : "blyg-daily-link", text: c.headline });
        head.addEventListener("click", () => this.openEntry(c.post));
        row.createDiv({ cls: "blyg-daily-meta", text: `${c.post.authorName ?? c.post.subscriptionTitle} · ${c.revised}` });
        if (!c.note) lazy.push({ c, row, head });
      }
      if (this.host.changeNote && lazy.length > 0) void this.fillChangeNotes(lazy.slice(0, NOTES_PER_DRAW));
    }
    if (m.retractions.length > 0) {
      const s = this.section(root, "Retractions", m.retractions.length);
      for (const r of m.retractions) {
        this.seen(r.post);
        const row = s.createDiv({ cls: "blyg-daily-row" });
        row.createEl("button", { cls: "blyg-daily-link", text: r.headline }).addEventListener("click", () => this.openEntry(r.post));
        row.createDiv({ cls: "blyg-daily-meta", text: `${r.post.authorName ?? r.post.subscriptionTitle} · withdrawn` });
      }
    }
  }

  /** Fill in the change notes of revised posts, one after the other (the Studio is metered); a row that has none, or whose page was drawn again, stays as it was. The text goes in as text only. */
  private async fillChangeNotes(rows: ReadonlyArray<{ c: Correction; row: HTMLElement; head: HTMLElement }>): Promise<void> {
    for (const { c, row, head } of rows) {
      const note = await (this.host.changeNote?.(c.post) ?? Promise.resolve("")).catch(() => "");
      if (!note || row.isConnected === false) continue;
      const lead = row.createEl("button", { cls: "blyg-daily-link blyg-correction-note", text: note });
      lead.addEventListener("click", () => this.openEntry(c.post));
      row.prepend(lead); // the note leads; the headline already in the row becomes the secondary line
      head.addClass("blyg-correction-headline");
    }
  }

  /** A single post: its content line in bold (the AI line's topic, else its first sentence), "by <Author>" in italics under it, and a small "Mark read". A tap on the row opens it in the reader; Back returns here. */
  private drawSingle(into: HTMLElement, p: ReadingPost, line?: string): void {
    this.seen(p);
    const row = into.createDiv({ cls: `blyg-daily-row blyg-story-mixed${this.added.has(p.remoteId) ? " blyg-is-new" : ""}` });
    const main = row.createDiv({ cls: "blyg-story-main" });
    if (this.added.has(p.remoteId)) main.createSpan({ cls: "blyg-story-updated blyg-story-newtag", text: "new" });
    const text = contentLine(p, line);
    main.createEl("button", { cls: "blyg-daily-link blyg-story-who blyg-story-line", text: text || byLine(p) }).addEventListener("click", (e) => {
      e?.stopPropagation?.();
      this.openEntry(p);
    });
    if (text) main.createDiv({ cls: "blyg-story-by", text: byLine(p) });
    row.addEventListener("click", () => this.openEntry(p));
    this.quick(row, p);
    const slot = row.createDiv({ cls: "blyg-story-markslot" });
    this.paintRead(row, slot, [p]);
  }

  /** The quick menu (long press or right click) of a post's row; marks go through the same queue as the read symbol. */
  private quick(el: HTMLElement, p: ReadingPost): void {
    const q = this.queue();
    const host = this.host;
    const shelf = host.shelf;
    // The shelf is read once per opening of the Daily (the first menu that needs it); Save and Remove are one write each, said in the line under the masthead.
    const shelfMenu = shelf?.on() ? { shelf: { state: () => (shelf.ready() ? { saved: shelf.has(p), full: shelf.full() } : null), toggle: () => void shelf.toggle(p).then((r) => this.say(r.ok ? (r.saved ? "Saved for later." : "Removed from saved.") : r.message)) } } : {};
    quickPost(el, () => p, { open: () => this.openEntry(p), ...(host.replyTo ? { reply: () => void host.replyTo?.(p) } : {}), ...(q ? { mark: (read: boolean) => void (read ? q.enqueue([p]) : q.enqueueUnread([p])) } : {}), ...shelfMenu }, this.contentEl);
  }

  /** The "read" look of a card or row and its read symbol (a circle to mark read, a check to mark unread again), now and after every change of a mark. `slot` holds the symbol (one for all `posts`). */
  private paintRead(card: HTMLElement, slot: HTMLElement, posts: readonly ReadingPost[], story = false): void {
    const paint = (): void => {
      const unread = markable(posts);
      card.toggleClass("blyg-is-read", posts.every((q) => !isUnread(q)));
      slot.empty();
      const q = this.queue();
      const back = q && this.host.markUnread ? unmarkable(posts) : [];
      if (!q || (unread.length === 0 && back.length === 0)) return;
      const read = unread.length === 0; // every post that can be marked is read: the symbol shows it, a tap puts it back
      const what = story ? "story" : "post";
      const label = read ? (story ? "Mark story unread" : "Mark unread") : story ? "Mark story read" : "Mark read";
      const btn = slot.createEl("button", { cls: `blyg-mark clickable-icon${read ? " is-read" : ""}`, attr: { "aria-label": label, title: read ? `Read: mark this ${what} unread again` : `Mark this ${what} read`, "aria-pressed": String(read) } });
      setIcon(btn, read ? "check-circle-2" : "circle");
      btn.addEventListener("click", (e) => {
        e?.stopPropagation?.();
        void (read ? q.enqueueUnread(posts) : q.enqueue(posts));
      });
    };
    paint();
    this.readPainters.push(paint);
  }

  /** The Mixed bag: the single posts no section holds (all of them on the plain page). */
  private drawMixed(root: HTMLElement, m: DailyModel, placed: ReadonlySet<string> = new Set()): void {
    const posts = m.mixed.filter((p) => !placed.has(p.remoteId)).sort(byNewestPost);
    if (posts.length > 0) {
      const s = this.section(root, MIXED_BAG, posts.length);
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
      ...(x.about ? { about: x.about } : {}),
      ...(x.lines ? { lines: x.lines } : {}),
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
    const byId = new Map(m.mixed.map((p) => [p.remoteId, p]));
    const placed = new Set<string>();
    const drawn: Drawn[] = drawnSections(sections, m.front, byId, (i) => i < lead);
    // Where each post is drawn, for the reader's "In the digest" chip: the lead block is "Top stories" (its stories are not drawn again in their sections).
    const where = new Map<string, string>();
    for (let i = 0; i < lead; i++) for (const q of m.front[i]?.posts ?? []) where.set(q.remoteId, TOP_STORIES);
    for (const d of drawn) {
      for (const i of d.stories) for (const q of m.front[i]?.posts ?? []) where.set(q.remoteId, sectionLabel(d.name));
      for (const q of d.singles) where.set(q.remoteId, sectionLabel(d.name));
    }
    for (const q of m.mixed) if (!where.has(q.remoteId)) where.set(q.remoteId, MIXED_BAG);
    publishPlacement(m.edition, where);
    // The lead block, then the sections; the page order is the rule in digest/order.ts. The contents (draw()) are made from the headings as they are drawn.
    const front = this.section(root, TOP_STORIES, postsIn(m.front.slice(0, lead)));
    front.addClass("blyg-sections-lead");
    for (let i = 0; i < lead; i++) {
      const c = m.front[i];
      if (c) this.drawCluster(front, c, this.written[i] ?? null);
    }
    for (const sec of drawn) {
      const box = this.section(root, sectionLabel(sec.name), sec.stories.reduce((k, i) => k + (m.front[i]?.posts.length ?? 0), 0) + sec.singles.length, sec.about);
      box.addClass("blyg-sections-section");
      for (const i of sec.stories) {
        const c = m.front[i];
        if (c) this.drawCluster(box, c, this.written[i] ?? null);
      }
      const lines = sections.find((x) => x.name === sec.name)?.lines ?? {};
      for (const p of sec.singles) {
        this.drawSingle(box, p, lines[p.remoteId]);
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
      rest.posts.forEach((p) => this.seen(p));
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
          row.createEl("button", { cls: "blyg-daily-link blyg-daily-who", text: p.authorName ?? p.subscriptionTitle }).addEventListener("click", () => this.openEntry(p));
          const preview = previewOf(p);
          if (preview) row.createDiv({ cls: "blyg-daily-preview", text: preview });
        }
      });
    }
    const how = into.createEl("details", { cls: "blyg-daily-how" });
    how.createEl("summary", { text: "How this is grouped" });
    for (const line of GROUPING_NOTE) how.createEl("p", { text: line, cls: "blyg-daily-meta" });
  }

  /** A heading box. `count`: the items drawn under it; every heading drawn is a line of the contents, in the order it is drawn (see tocSlot). */
  private section(root: HTMLElement, title: string, count: number, about?: string): HTMLElement {
    const s = root.createDiv({ cls: "blyg-daily-section" });
    s.createEl("h3", { text: title });
    if (about) s.createDiv({ cls: "blyg-section-about", text: about }); // the AI's one-line byline, muted; none when it gave none
    this.sectionEls.set(title, s);
    this.toc.push({ name: title, count });
    return s;
  }

  /** Scroll to a section's box (the table of contents, the reader's chip). */
  private goTo(name: string): void {
    this.sectionEls.get(sectionLabel(name))?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }

  private drawCluster(into: HTMLElement, c: Cluster, ai: Written | null): void {
    const card = into.createDiv({ cls: "blyg-daily-cluster blyg-story" });
    const blygs = new Set(c.posts.map((p) => p.subscriptionTitle || p.origin || "")).size;
    const title = card.createEl("button", { cls: `blyg-daily-link blyg-daily-headline blyg-story-headline blyg-story-font-${this.host.font()}`, text: ai ? ai.headline : c.headline });
    // Generated text: put on the page as text only (never HTML). The "Written by" label is once, under the front page.
    const summary = ai?.summary ? card.createEl("button", { cls: "blyg-daily-link blyg-story-summary", text: ai.summary }) : null;
    const names = c.posts.map(authorOf);
    const meta = card.createDiv({
      cls: "blyg-daily-meta",
      text: [`${plural(c.posts.length, "post", "posts")} in ${plural(blygs, "blyg", "blygs")}`, authorsLine(c.posts), ai ? "" : keywordsOf(c.terms, names).join(" · ")].filter(Boolean).join(" · "),
    });
    const fresh = new Set([...(ai?.fresh ?? []), ...c.posts.map((p) => p.remoteId).filter((id) => this.added.has(id))]);
    if (fresh.size > 0) meta.createSpan({ cls: "blyg-story-updated", text: ` +${plural(fresh.size, "new post", "new posts")}` });
    // One button marks the whole story (its unread posts) read.
    this.paintRead(card, card.createDiv({ cls: "blyg-story-markrow" }), c.posts, true);
    const list = card.createDiv({ cls: "blyg-daily-members" });
    const story = c.id ?? c.headline;
    for (const p of c.posts) this.seen(p); // folded or not, a story's posts are on the page in this order
    const sq = this.queue();
    quickStory(card, c.posts, { open: () => c.posts[0] && this.openEntry(c.posts[0]), ...(sq ? { mark: (read: boolean) => void (read ? sq.enqueue(c.posts) : sq.enqueueUnread(c.posts)) } : {}) });
    const key = scrollKey(this.viewing ?? this.edition);
    const paintOpen = addStoryMark(card, meta, [title, ...(summary ? [summary] : [])]);
    const toggle = (open: boolean): void => {
      list.empty();
      paintOpen(open);
      setStoryUnfolded(key, story, open);
      if (!open) return;
      for (const p of c.posts) {
        const row = list.createDiv({ cls: `blyg-daily-row blyg-daily-member${fresh.has(p.remoteId) ? " blyg-is-new" : ""}` });
        const who = row.createEl("button", { cls: "blyg-daily-link blyg-daily-who", text: `${p.authorName ?? p.subscriptionTitle}${p.isReply ? " (reply)" : ""}` });
        who.addEventListener("click", (e) => {
          e?.stopPropagation?.();
          this.openEntry(p);
        });
        const preview = previewOf(p);
        if (preview) row.createDiv({ cls: "blyg-daily-preview", text: preview });
        row.addEventListener("click", () => this.openEntry(p)); // a tap anywhere on the post's area opens it
        this.quick(row, p);
        const dim = (): void => row.toggleClass("blyg-is-read", !isUnread(p));
        dim();
        this.readPainters.push(dim);
      }
    };
    let open = storyUnfolded(key, story);
    toggle(open);
    // The summary does what the headline does.
    title.addEventListener("click", () => toggle((open = !open)));
    summary?.addEventListener("click", () => toggle((open = !open)));
  }
}
