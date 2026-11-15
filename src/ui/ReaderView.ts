// S15, the reader pane: a feed of the posts of the blygs the owner reads, a mentions list, one post at a time, and the hand-offs a reader needs (reply in
// Obsidian, open in the browser, mark read). Drawing only; what it asks of the plugin is `ReaderHost`. Foreign markup goes through defang.ts and
// `sanitizeHTMLToDom` only; a post's web page is shown by trimmedPage.ts in a frame without scripts and without an origin.
//
// Layout: a header that never scrolls away (tabs and controls, or the post's buttons and its blyg, author and read state, then one status line) above a
// body that scrolls by itself. Read state changes at once, in place, and is put back if the Studio refuses.
import { ItemView, sanitizeHTMLToDom, type WorkspaceLeaf } from "obsidian";
import { isUnread, relationWords, type InboundMention, type ReadingPost } from "../studio/reading";
import { plainText, renderForeign, type ImageMode } from "./defang";
import { activeFilters, arrange, cardOf, DEFAULT_FILTER, frameable, LENGTH_LABELS, readingTimeLabel, relativeTime, SORT_LABELS, sourcesOf, type FeedFilter, type FeedLength, type FeedSort } from "./readerFeed";
import { FONT_LABELS, isReaderFont, type ReaderFont } from "./readerFonts";
import { frameUrlFor, READER_FRAME_SANDBOX } from "./trimmedPage";

export const BLYG_READER_VIEW = "blyg-reader";

export interface ReaderData {
  posts: ReadingPost[];
  mentions: InboundMention[];
  /** One line when something was cut short or could not be read. */
  note: string;
  /** The owner's Studio origin: the only place an image may be loaded from while reading as text without a tap. */
  studioOrigin: string | null;
}

export type ReadResult = { ok: true } | { ok: false; message: string };

/** The Studio's change counters that matter to the reader (see `GET /changes`). */
export interface ChangeMarks {
  epoch: string;
  reading: number;
  subscriptions: number;
}

export type PreparedPage = { kind: "trimmed"; doc: string } | { kind: "full" } | { kind: "forbidden" } | { kind: "unreachable" };

export interface ReaderHost {
  /** The plugin's own version, shown at the foot of the feed so you can tell which build a device runs. */
  version: string;
  /** Load the stream and the mentions, or say in words why not. */
  load(): Promise<{ ok: true; data: ReaderData } | { ok: false; message: string }>;
  openWeb(url: string): void;
  /** Start a reply thread to this post (the same path as "Reply to an item"). */
  replyTo(post: ReadingPost): Promise<void>;
  /** Mark this version read, or unread again. Needs the token permission `reading:state`; the message says so when it is missing. */
  markRead(post: ReadingPost): Promise<ReadResult>;
  markUnread(post: ReadingPost): Promise<ReadResult>;
  /** The owner's choices (settings): how a post opens, and what happens to images in the text view. */
  imageMode(): ImageMode;
  viewMode(): "web" | "text";
  setViewMode(mode: "web" | "text"): Promise<void>;
  /** The font of a post's content (the setting "Font for posts"); a web page picks it up the next time it is opened. */
  font(): ReaderFont;
  setFont(font: ReaderFont): Promise<void>;
  /**
   * Ask the Studio to fetch the blygs it reads now. `force`: the person tapped Refresh (a shorter pause applies than when the reader merely opens).
   * `asked: false` when it was asked too recently, or could not be asked (`reason` says why, in words).
   */
  checkForNew(force: boolean): Promise<{ asked: true; polling: number } | { asked: false; reason?: string }>;
  /** The Studio's change counters, or null when they cannot be read. The reading counter moves when the list does; the subscriptions counter when a blyg has been fetched. */
  changeMarks(): Promise<ChangeMarks | null>;
  /**
   * Prepare a post's page for the frame: `trimmed` (the post alone, with the blyg's stylesheets, see trimmedPage.ts), `full` (the page has no article the
   * reader recognises, and allows framing: the whole page is shown), `forbidden` (no article, and its headers refuse framing), `unreachable`.
   * Desktop Obsidian removes `X-Frame-Options` and CSP `frame-ancestors` from every response (its own session hook), so there `forbidden` is never seen.
   */
  preparePage(url: string): Promise<PreparedPage>;
}

/** The first words of a post, as plain text. Read from the string, never from an element: a list of posts must not request a single image. */
export function excerptOf(html: string, max = 140): string {
  const text = plainText(html);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type PageState = { s: "unknown" } | { s: "asking" } | { s: "trimmed"; url: string } | { s: "full" } | { s: "forbidden" } | { s: "unreachable" };

const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;
const OPENING = "Opening the page…";

export class BlygReaderView extends ItemView {
  private data: ReaderData | null = null;
  private tab: "stream" | "mentions" = "stream";
  private shown: ReadingPost | null = null;
  /** How the open post is shown (the start value is the setting; "As text" / "As web page" switch it for this post only). */
  private shownAs: "web" | "text" = "web";
  /** The open post's page, once prepared. `trimmed` holds an object URL that must be revoked when the post closes. */
  private page: PageState = { s: "unknown" };
  /** Read through a call, so a check after an assignment in the same function is not narrowed away by the type checker. */
  private pageState(): PageState {
    return this.page;
  }
  private filter: FeedFilter = { ...DEFAULT_FILTER };
  /** Whether the sort and filter choices are open (they start closed, so the header stays slim). */
  private filtersOpen = false;
  private status = "";
  /** How many things are loading right now: the refresh button and the status line show a spinner while it is above zero. */
  private busyCount = 0;
  /** Bumped by every check for new posts, so an older check stops when a newer one starts. */
  private checking = 0;
  private headerEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private refreshEl: HTMLButtonElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private feedScroll = 0;
  private readonly cardEls = new Map<string, HTMLElement>();
  /**
   * Read changes made here that a reload must not undo: a list fetched just before a mark reached the Studio is stale by the time it arrives. Held
   * while the change is on its way and for ten seconds after it was accepted; dropped at once if the Studio refuses it.
   */
  private readonly readOverride = new Map<string, { value: number | null; until: number }>();
  /** The last message a refused read mark put in the status line, so a later success can take it away again. */
  private readFailure = "";
  /** Read-state changes of one post go to the Studio one after the other, in the order they were made. */
  private readonly readChain = new Map<string, Promise<void>>();

  constructor(leaf: WorkspaceLeaf, private readonly host: ReaderHost) {
    super(leaf);
  }

  override getViewType(): string {
    return BLYG_READER_VIEW;
  }
  override getDisplayText(): string {
    return "Blyg reader";
  }
  override getIcon(): string {
    return "book-open";
  }

  override async onOpen(): Promise<void> {
    this.draw();
    await this.reload();
    void this.checkForNew(false);
  }

  override async onClose(): Promise<void> {
    this.checking++;
    this.releasePage();
    await Promise.resolve();
  }

  // ---- state -------------------------------------------------------------------------------------------------------------------------------

  /** Forget the open post's page (and free its object URL). */
  private releasePage(): void {
    if (this.page.s === "trimmed") URL.revokeObjectURL(this.page.url);
    this.page = { s: "unknown" };
  }

  /** The font of the post's content, as a class on the pane (the text view's CSS reads it; a web page gets it in its own document). */
  private applyFont(): void {
    const font = this.host.font();
    for (const f of ["default", "serif", "sans", "mono"] as const) this.contentEl.toggleClass(`is-font-${f}`, f === font);
  }

  private busy(delta: number): void {
    this.busyCount = Math.max(0, this.busyCount + delta);
    this.headerEl?.toggleClass("is-busy", this.busyCount > 0);
    this.statusEl?.toggleClass("is-busy", this.busyCount > 0);
    if (this.refreshEl?.isConnected) this.refreshEl.disabled = this.busyCount > 0;
  }

  private setStatus(text: string): void {
    this.status = text;
    this.statusEl?.setText(text);
  }

  /** Read the list from the Studio. `quiet`: keep the status line and leave an open post alone (its page would reload). */
  private async reload(quiet = false): Promise<void> {
    if (!quiet) {
      this.setStatus("Loading…");
      this.busy(+1);
    }
    try {
      const got = await this.host.load();
      if (got.ok) {
        this.keepLocalReadState(got.data.posts);
        this.data = got.data;
        if (!quiet) this.setStatus(got.data.note);
      } else if (!quiet) {
        this.data = null;
        this.setStatus(got.message);
      }
    } finally {
      if (!quiet) this.busy(-1);
    }
    this.drawHeader();
    if (!quiet || !this.shown) this.drawBody();
  }

  /**
   * Ask the Studio to fetch the blygs it reads, then watch its change counters and reload the list whenever the reading counter moves. It stops as soon as
   * every blyg has reported (the subscriptions counter rises once per blyg fetched), after six quiet seconds once one has, or after half a minute.
   */
  private async checkForNew(force: boolean): Promise<void> {
    const run = ++this.checking;
    this.busy(+1);
    try {
      const before = await this.host.changeMarks();
      const asked = await this.host.checkForNew(force);
      if (run !== this.checking) return;
      if (!asked.asked) {
        if (asked.reason) this.setStatus(asked.reason);
        return;
      }
      const known = new Set((this.data?.posts ?? []).map((p) => `${keyOf(p)}/${p.version}`));
      this.setStatus(`Checking ${asked.polling} blyg${asked.polling === 1 ? "" : "s"} for new posts…`);
      let mark = before;
      const startedAt = Date.now();
      let lastMove = startedAt;
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 1500));
        if (run !== this.checking || !this.contentEl.isConnected) return;
        const now = await this.host.changeMarks();
        if (now !== null) {
          const reset = mark !== null && now.epoch !== mark.epoch;
          const moved = mark === null || reset || now.reading !== mark.reading || now.subscriptions !== mark.subscriptions;
          if (reset || mark === null || now.reading !== mark.reading) await this.reload(true);
          if (moved) lastMove = Date.now();
          mark = now;
          if (reset) break;
        }
        const reported = mark !== null && before !== null ? mark.subscriptions - before.subscriptions : 0;
        if (reported >= asked.polling) break;
        if (reported > 0 && Date.now() - lastMove >= 6000) break;
        if (Date.now() - startedAt >= 30_000) break;
      }
      if (run !== this.checking) return;
      await this.reload(true);
      const fresh = (this.data?.posts ?? []).filter((p) => !known.has(`${keyOf(p)}/${p.version}`)).length;
      const at = new Date().toTimeString().slice(0, 5);
      this.setStatus(fresh > 0 ? `${fresh} new or changed post${fresh === 1 ? "" : "s"} · checked ${at}` : `Up to date · checked ${at}`);
    } finally {
      this.busy(-1);
    }
  }

  /** Mark read or unread: shown at once, in place; put back with the Studio's reason if it refuses. */
  private async setRead(p: ReadingPost, read: boolean): Promise<void> {
    const key = keyOf(p);
    const before = this.live(p).readVersion;
    this.showRead(key, p, read ? p.version : null, Infinity);
    const sent = (this.readChain.get(key) ?? Promise.resolve()).then(async () => {
      // Anything that goes wrong counts as a refusal: the mark is put back, and the queue for this post keeps working.
      const failed = (): ReadResult => ({ ok: false, message: "The read mark could not be changed." });
      const done = await (read ? this.host.markRead(p) : this.host.markUnread(p)).catch(failed);
      if (!done.ok) {
        this.readOverride.delete(key);
        this.showRead(key, p, before, 0);
        this.readFailure = done.message;
        this.setStatus(done.message);
      } else {
        this.readOverride.set(key, { value: read ? p.version : null, until: Date.now() + 10_000 });
        if (this.readFailure !== "" && this.status === this.readFailure) {
          this.readFailure = "";
          this.setStatus("");
        }
      }
    });
    this.readChain.set(key, sent);
    await sent;
  }

  /** The object the feed holds for this post now (a reload replaces them all). */
  private live(p: ReadingPost): ReadingPost {
    const key = keyOf(p);
    return this.data?.posts.find((q) => keyOf(q) === key) ?? p;
  }

  /** Show a read state at once, on the post and on what the feed holds, and remember it against a stale reload (`until`: how long). */
  private showRead(key: string, p: ReadingPost, value: number | null, until: number): void {
    if (until > 0) this.readOverride.set(key, { value, until });
    p.readVersion = value;
    const cur = this.live(p);
    cur.readVersion = value;
    this.refreshPost(cur);
  }

  /** A freshly loaded list is put right where this device changed a read mark a moment ago; and the open post is the new object for it. */
  private keepLocalReadState(posts: ReadingPost[]): void {
    const now = Date.now();
    for (const q of posts) {
      const key = keyOf(q);
      const o = this.readOverride.get(key);
      if (!o) continue;
      if (o.until > now) q.readVersion = o.value;
      else this.readOverride.delete(key);
    }
    const open = this.shown;
    if (open) this.shown = posts.find((q) => keyOf(q) === keyOf(open)) ?? open;
  }

  /** Redraw what shows this post, and only that: its card in the feed, or the header of the open post. */
  private refreshPost(p: ReadingPost): void {
    const card = this.cardEls.get(keyOf(p));
    if (card?.isConnected) this.fillCard(card, p);
    if (this.shown && keyOf(this.shown) === keyOf(p)) this.drawHeader();
  }

  // ---- drawing -----------------------------------------------------------------------------------------------------------------------------

  private draw(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("blyg-reader");
    this.applyFont();
    this.headerEl = root.createDiv({ cls: "blyg-reader-header" });
    this.bodyEl = root.createDiv({ cls: "blyg-reader-bodywrap" });
    this.drawHeader();
    this.drawBody();
  }

  private button(parent: HTMLElement, text: string, run: () => void | Promise<void>, opts: { active?: boolean; disabled?: boolean; title?: string; cls?: string } = {}): HTMLButtonElement {
    const b = parent.createEl("button", { text, cls: `blyg-reader-btn${opts.cls ? ` ${opts.cls}` : ""}`, ...(opts.title ? { attr: { title: opts.title, "aria-label": opts.title } } : {}) });
    if (opts.active) b.addClass("is-active");
    b.disabled = opts.disabled === true;
    b.addEventListener("click", () => void run());
    return b;
  }

  private link(parent: HTMLElement, text: string, url: string | null): void {
    if (!frameable(url)) {
      parent.createSpan({ text });
      return;
    }
    const a = parent.createEl("a", { text, cls: "blyg-reader-link", attr: { href: url } });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      this.host.openWeb(url);
    });
  }

  private drawHeader(): void {
    const h = this.headerEl;
    if (!h) return;
    h.empty();
    h.toggleClass("is-busy", this.busyCount > 0);
    if (this.shown) this.drawPostHeader(h, this.shown);
    else this.drawFeedHeader(h);
    this.statusEl = h.createDiv({ cls: "blyg-reader-status", text: this.status });
    this.statusEl.toggleClass("is-busy", this.busyCount > 0);
  }

  private drawFeedHeader(h: HTMLElement): void {
    const row = h.createDiv({ cls: "blyg-reader-bar" });
    for (const [id, label] of [["stream", "Reading"], ["mentions", `Mentions${this.data ? ` (${this.data.mentions.length})` : ""}`]] as const) {
      this.button(row, label, () => {
        this.tab = id;
        this.drawHeader();
        this.drawBody();
      }, { active: this.tab === id });
    }
    row.createDiv({ cls: "blyg-reader-spacer" });
    const canFilter = this.tab === "stream" && this.data !== null && this.data.posts.length > 0;
    if (canFilter) {
      const n = activeFilters(this.filter);
      this.button(row, n > 0 ? `Sort & filter (${n})` : "Sort & filter", () => {
        this.filtersOpen = !this.filtersOpen;
        this.drawHeader();
      }, { active: this.filtersOpen, cls: "blyg-reader-filterbtn", title: "Order, blyg, length, unread, and how posts open" });
    }
    const refresh = this.button(row, "Refresh", () => {
      void this.reload().then(() => this.checkForNew(true));
    }, { cls: "blyg-reader-refresh", title: "Look for new posts" });
    refresh.disabled = this.busyCount > 0;
    this.refreshEl = refresh;
    if (!canFilter || !this.filtersOpen || !this.data) return;

    const controls = h.createDiv({ cls: "blyg-reader-controls" });
    const select = (label: string, options: Array<[string, string]>, value: string, set: (v: string) => void, after: () => void = () => this.drawBody()): void => {
      const el = controls.createEl("select", { cls: "dropdown blyg-reader-select", attr: { "aria-label": label, title: label } });
      for (const [v, text] of options) el.createEl("option", { value: v, text });
      el.value = value;
      el.addEventListener("change", () => {
        set(el.value);
        this.drawHeader();
        after();
      });
    };
    select("Order", (Object.keys(SORT_LABELS) as FeedSort[]).map((k): [string, string] => [k, SORT_LABELS[k]]), this.filter.sort, (v) => (this.filter.sort = v as FeedSort));
    const posts = this.data.posts;
    select("Blyg", [["", `All blygs (${posts.length})`], ...sourcesOf(posts).map((s): [string, string] => [s.id, `${s.title} (${s.count})`])], this.filter.source ?? "", (v) => (this.filter.source = v === "" ? null : v));
    select("Length", (Object.keys(LENGTH_LABELS) as FeedLength[]).map((k): [string, string] => [k, LENGTH_LABELS[k]]), this.filter.length, (v) => (this.filter.length = v as FeedLength));
    select("Font for posts", (Object.keys(FONT_LABELS) as ReaderFont[]).map((k): [string, string] => [k, k === "default" ? "Font: as it is" : `Font: ${FONT_LABELS[k]}`]), this.host.font(), (v) => {
      if (isReaderFont(v)) void this.host.setFont(v).then(() => this.applyFont());
    }, () => undefined);
    const unread = controls.createEl("label", { cls: "blyg-reader-toggle" });
    const box = unread.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.filter.unreadOnly;
    unread.appendText(" Unread only");
    box.addEventListener("change", () => {
      this.filter.unreadOnly = box.checked;
      this.drawHeader();
      this.drawBody();
    });
    // How posts open by default: the same choice as the setting "Open posts as", kept when you change it here.
    const open = controls.createDiv({ cls: "blyg-reader-segment", attr: { role: "group", "aria-label": "Open posts as" } });
    const mode = this.host.viewMode();
    for (const [id, label] of [["web", "Web page"], ["text", "Text"]] as const) {
      this.button(open, label, async () => {
        await this.host.setViewMode(id);
        this.drawHeader();
      }, { active: mode === id, title: id === "web" ? "Open posts as the author's web page" : "Open posts as text" });
    }
  }

  private drawPostHeader(h: HTMLElement, p: ReadingPost): void {
    const web = frameable(p.sourceUrl) ? p.sourceUrl : null;
    const row = h.createDiv({ cls: "blyg-reader-bar" });
    this.button(row, "Back", () => {
      this.shown = null;
      this.releasePage();
      this.drawHeader();
      this.drawBody();
    });
    this.button(row, "Reply", () => this.host.replyTo(p), { disabled: p.withdrawn, title: "Reply in Obsidian: a new thread that answers this post" });
    const unread = isUnread(p);
    this.button(row, unread ? "○ Mark read" : "✓ Read", () => this.setRead(p, unread), {
      disabled: p.withdrawn,
      active: !unread,
      cls: "blyg-reader-readtoggle",
      title: unread ? "Mark this post read" : "Read. Tap to mark it unread again",
    });
    this.button(row, "Browser", () => (web ? this.host.openWeb(web) : undefined), { disabled: web === null, title: "Open the whole page in the browser" });
    if (web) {
      this.button(row, this.shownAs === "web" ? "As text" : "As web page", () => {
        this.shownAs = this.shownAs === "web" ? "text" : "web";
        this.drawHeader();
        this.drawBody();
      });
    }
    // Where it is from, and who wrote it, as links; its version when it has been edited; when; whether it is read.
    const meta = h.createDiv({ cls: "blyg-reader-meta blyg-reader-postmeta" });
    const blygUrl = p.origin ?? (web ? new URL(web).origin : null);
    const parts: Array<() => void> = [];
    if (p.subscriptionTitle || blygUrl) parts.push(() => this.link(meta, p.subscriptionTitle || new URL(blygUrl ?? "").host, blygUrl));
    if (p.authorName) parts.push(() => this.link(meta, p.authorName ?? "", p.authorUrl));
    if (p.version > 1) parts.push(() => meta.createSpan({ text: `version ${p.version}` }));
    const when = relativeTime(p.created ?? p.observedAt, Date.now());
    if (when) parts.push(() => meta.createSpan({ text: when }));
    if (!p.withdrawn) parts.push(() => meta.createSpan({ text: readingTimeLabel(p) }));
    parts.push(() => meta.createSpan({ cls: unread ? "blyg-reader-unreadmark" : "blyg-reader-readmark", text: p.withdrawn ? "withdrawn" : unread ? (p.readVersion !== null ? "updated since you read it" : "unread") : "✓ read" }));
    parts.forEach((draw, i) => {
      if (i > 0) meta.createSpan({ text: " · " });
      draw();
    });
  }

  private drawBody(): void {
    const body = this.bodyEl;
    if (!body) return;
    const keepTop = this.shown === null && this.scrollEl?.isConnected ? this.scrollEl.scrollTop : 0;
    body.empty();
    this.scrollEl = null;
    if (this.shown) {
      this.drawPostBody(body, this.shown);
      return;
    }
    const scroll = body.createDiv({ cls: "blyg-reader-scroll" });
    this.scrollEl = scroll;
    const col = scroll.createDiv({ cls: "blyg-reader-column" });
    if (!this.data) {
      col.createDiv({ cls: "blyg-reader-note", text: this.busyCount > 0 ? "" : "The reader has nothing to show yet." });
    } else if (this.tab === "stream") this.drawStream(col, this.data.posts);
    else this.drawMentions(col, this.data.mentions);
    col.createDiv({ cls: "blyg-reader-foot", text: `Blyg reader · plugin ${this.host.version}` });
    scroll.scrollTop = this.feedScroll > 0 ? this.feedScroll : keepTop;
    this.feedScroll = 0;
  }

  private drawStream(col: HTMLElement, posts: ReadingPost[]): void {
    this.cardEls.clear();
    if (posts.length === 0) {
      col.createDiv({ cls: "blyg-reader-note", text: "Nothing to read yet. Subscribe to a blyg in your Studio." });
      return;
    }
    const shown = arrange(posts, this.filter);
    if (shown.length === 0) col.createDiv({ cls: "blyg-reader-note", text: "No post matches." });
    for (const p of shown) {
      const card = col.createDiv({ cls: "blyg-reader-row blyg-reader-card" });
      this.cardEls.set(keyOf(p), card);
      this.fillCard(card, p);
      card.addEventListener("click", () => {
        // A press that selected some text is a selection, not a tap.
        if ((activeWindow.getSelection()?.toString() ?? "") !== "") return;
        this.feedScroll = this.scrollEl?.scrollTop ?? 0;
        this.releasePage();
        this.shown = p;
        this.shownAs = this.host.viewMode();
        this.drawHeader();
        this.drawBody();
      });
    }
  }

  /** One card: what a post is, at a glance. Drawn again in place when its read state changes. */
  private fillCard(card: HTMLElement, p: ReadingPost): void {
    card.empty();
    const unread = isUnread(p);
    card.toggleClass("is-unread", unread);
    card.toggleClass("is-read", !unread && !p.withdrawn);
    const head = card.createDiv({ cls: "blyg-reader-cardhead" });
    const title = head.createDiv({ cls: "blyg-reader-cardtitle" });
    title.createSpan({ cls: "blyg-reader-source", text: p.subscriptionTitle || p.origin || "" });
    const meta = [p.authorName, relativeTime(p.created ?? p.observedAt, Date.now()), p.withdrawn ? "" : readingTimeLabel(p)].filter(Boolean).join(" · ");
    if (meta) title.createSpan({ cls: "blyg-reader-meta", text: ` · ${meta}` });
    if (!p.withdrawn) {
      const check = head.createEl("button", {
        cls: "blyg-reader-check",
        text: unread ? "○" : "✓",
        attr: { "aria-label": unread ? "Mark read" : "Mark unread", title: unread ? "Mark read" : "Read. Tap to mark it unread again" },
      });
      check.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.setRead(p, unread);
      });
    }
    const badges = card.createDiv({ cls: "blyg-reader-badges" });
    if (p.isReply) badges.createSpan({ cls: "blyg-reader-badge", text: "reply" });
    else if (p.kind === "thread") badges.createSpan({ cls: "blyg-reader-badge", text: "thread" });
    if (p.withdrawn) badges.createSpan({ cls: "blyg-reader-badge", text: "withdrawn" });
    if (unread) badges.createSpan({ cls: "blyg-reader-badge is-new", text: p.readVersion !== null ? "updated" : "unread" });
    else if (!p.withdrawn) badges.createSpan({ cls: "blyg-reader-badge is-done", text: "✓ read" });
    if (!p.withdrawn) {
      const c = cardOf(p);
      if (c.quote) card.createDiv({ cls: "blyg-reader-quote", text: c.quote });
      if (c.words) card.createDiv({ cls: "blyg-reader-excerpt", text: c.words });
      if (c.images > 0) card.createDiv({ cls: "blyg-reader-meta", text: `${c.images} image${c.images === 1 ? "" : "s"}` });
    }
  }

  private drawMentions(col: HTMLElement, mentions: InboundMention[]): void {
    if (mentions.length === 0) col.createDiv({ cls: "blyg-reader-note", text: "No one has mentioned your items yet." });
    for (const m of mentions) {
      const row = col.createDiv({ cls: "blyg-reader-row" });
      row.createDiv({ cls: "blyg-reader-meta", text: `${m.sourceAuthorName ?? m.sourceOrigin ?? "Someone"} ${relationWords(m.relation)} one of your items` });
      row.createDiv({ cls: "blyg-reader-excerpt", text: m.firstSeen.slice(0, 10) });
      const web = m.sourcePage;
      if (web) row.addEventListener("click", () => this.host.openWeb(web));
    }
  }

  /** The post as text: images and markup decided before the sanitiser builds an element (see defang.ts). */
  private drawText(into: HTMLElement, p: ReadingPost): void {
    const guard = renderForeign(p.contentHtml, { trustedOrigin: this.data?.studioOrigin ?? null, mode: this.host.imageMode(), baseUrl: p.sourceUrl ?? p.origin }, sanitizeHTMLToDom);
    if (guard.blocked > 0) this.button(into, `Load images (${guard.blocked})`, () => guard.loadAll(), { cls: "blyg-reader-loadall" });
    into.createDiv({ cls: "blyg-reader-body" }).appendChild(guard.fragment);
  }

  private drawPostBody(body: HTMLElement, p: ReadingPost): void {
    const web = frameable(p.sourceUrl) ? p.sourceUrl : null;
    if (this.shownAs === "web" && web && !p.withdrawn) {
      if (this.page.s === "unknown") {
        this.page = { s: "asking" };
        this.setStatus(OPENING);
        this.busy(+1);
        void this.host.preparePage(web).then((prepared) => {
          this.busy(-1);
          if (this.status === OPENING) this.setStatus("");
          if (!this.shown || keyOf(this.shown) !== keyOf(p)) return;
          this.page = prepared.kind === "trimmed" ? { s: "trimmed", url: frameUrlFor(prepared.doc) } : { s: prepared.kind };
          this.drawBody();
        });
      }
      const page = this.pageState();
      if (page.s === "trimmed" || page.s === "full") {
        // The post's own page (trimmed to the post, or whole), as a visit would show it. Sandboxed without scripts and without an origin, so it cannot
        // reach Obsidian; links open outside. It loads its images like any visit: that is what "as on the web" means (the setting says so).
        body.createEl("iframe", { cls: "blyg-reader-frame", attr: { src: page.s === "trimmed" ? page.url : web, sandbox: READER_FRAME_SANDBOX, referrerpolicy: "no-referrer", title: `${p.subscriptionTitle} on the web` } });
        return;
      }
      // Until the page is ready the text is shown, so there is something to read at once; it is replaced by the page when that arrives.
      const scroll = body.createDiv({ cls: "blyg-reader-scroll" });
      const col = scroll.createDiv({ cls: "blyg-reader-column" });
      if (page.s === "forbidden") col.createDiv({ cls: "blyg-reader-note", text: "This blyg does not allow its pages inside other apps, so the post is shown as text." });
      else if (page.s === "unreachable") col.createDiv({ cls: "blyg-reader-note", text: "The page could not be reached, so the post is shown as text." });
      this.drawText(col, p);
      return;
    }
    const scroll = body.createDiv({ cls: "blyg-reader-scroll" });
    this.drawText(scroll.createDiv({ cls: "blyg-reader-column" }), p);
  }
}
