// S15, the reader pane: a feed of the posts of the blygs the owner reads, a mentions list, one post at a time, and the hand-offs a reader needs (reply in
// Obsidian, open in the browser, mark read). Drawing only; what it asks of the plugin is `ReaderHost`. Foreign markup goes through defang.ts and
// `sanitizeHTMLToDom` only. A post is always shown as text; "Browser" opens its page outside Obsidian.
//
// Layout: a header that never scrolls away (tabs and controls, or the post's buttons and its blyg, author and read state, then one status line) above a
// body that scrolls by itself. Read state changes at once, in place, and is put back if the Studio refuses.
import { ItemView, sanitizeHTMLToDom, setIcon, type WorkspaceLeaf } from "obsidian";
import { isUnread, type InboundMention, type ReadingPost } from "../studio/reading";
import { plainText, renderForeign, type ImageMode } from "./defang";
import { activeFilters, arrange, cardOf, DEFAULT_FILTER, frameable, LENGTH_LABELS, nextInOrder, postOfQuote, pullProgress, readingTimeLabel, relativeTime, SORT_LABELS, sourcesOf, type FeedFilter, type FeedLength, type FeedSort } from "./readerFeed";
import { FONT_LABELS, isReaderFont, type ReaderFont } from "./readerFonts";
import { CONTRAST_LABELS, CONTRASTS, isReaderContrast, type ReaderContrast } from "./readerLook";
import { responseChip, responseIndex, type ResponseEntry } from "./readerResponses";
import { changedCount, chooseWalk, knownOf, mergeFresh, READER_KEEP, type SyncMemory } from "./readerSync";
import type { StudioListedItem } from "../studio/types";
import { limiter, mentionLead, postOfMention, visibleMentions } from "./readerMentions";

export const BLYG_READER_VIEW = "blyg-reader";

export interface ReaderData {
  posts: ReadingPost[];
  mentions: InboundMention[];
  /** One line when something was cut short or could not be read. */
  note: string;
  /** The owner's Studio origin: the only place an image may be loaded from while reading as text without a tap. */
  studioOrigin: string | null;
  /** True while the list is still arriving (the first pages, shown early). */
  partial?: boolean;
  /** True when `posts` are only the newest rows, to be merged into the list held (the walk stopped where it reached what was held). */
  incremental?: boolean;
  /** False when this load did not ask for the mentions: keep the ones held. */
  mentionsFetched?: boolean;
  /** Shown from the list saved by the last session, while the Studio is asked. */
  fromCache?: boolean;
}

export type ReadResult = { ok: true } | { ok: false; message: string };

/** The Studio's change counters that matter to the reader (see `GET /changes`). */
export interface ChangeMarks {
  epoch: string;
  reading: number;
  subscriptions: number;
}

export interface ReaderHost {
  /** The plugin's own version, shown at the foot of the feed so you can tell which build a device runs. */
  version: string;
  /** Load the stream and the mentions, or say in words why not. */
  load(
    onProgress?: (postsSoFar: ReadingPost[]) => void,
    opts?: { known?: Map<string, string> | null; mentions?: boolean; force?: boolean },
  ): Promise<{ ok: true; data: ReaderData } | { ok: false; message: string }>;
  /** The list kept by the last session (for the Studio now in use), or null. Posts of other people: in the plugin's own folder, never in a note. */
  readCache(): Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number; studioOrigin: string } | null>;
  /** Keep this list for the next session (the host waits a moment and writes once). */
  writeCache(data: { posts: ReadingPost[]; mentions: InboundMention[] }): void;
  openWeb(url: string): void;
  /** Start a reply thread to this post (the same path as "Reply to an item"). */
  replyTo(post: ReadingPost): Promise<void>;
  /** Mark this version read, or unread again. Needs the token permission `reading:state`; the message says so when it is missing. */
  /** The text of what a mention is about, as a post to open: from the list when the Studio reads that blyg, else a peek at it. Null when it cannot be had. */
  mentionPost(m: InboundMention, posts: ReadingPost[]): Promise<ReadingPost | null>;
  /** A short excerpt of the owner's own item that was mentioned; null when it cannot be had. */
  ownExcerpt(itemId: string): Promise<string | null>;
  /** Whether this id is one of the owner's own items (a quote of it is "you"); false when it is not or cannot be told. */
  isOwnItem(itemId: string): Promise<boolean>;
  /** Look an item of another blyg up (through the owner's Studio) and open its page in the browser; false when it cannot be found. */
  openQuotedItem(origin: string, itemId: string): Promise<boolean>;
  /** The owner's own items (for the replies they wrote to a post); empty when they cannot be had. Kept for a few minutes by the host. */
  myItems(): Promise<StudioListedItem[]>;
  /** Open the note of one of the owner's items in Obsidian; false when no note of this vault holds it. */
  openOwnItem(itemId: string): Promise<boolean>;
  markRead(post: ReadingPost): Promise<ReadResult>;
  markUnread(post: ReadingPost): Promise<ReadResult>;
  /** The owner's choices (settings): how a post opens, and what happens to images in the text view. */
  imageMode(): ImageMode;
  /** The font of the text view's content (the setting "Font for posts"). */
  font(): ReaderFont;
  setFont(font: ReaderFont): Promise<void>;
  /** The contrast of the text view's reading surface (the setting "Contrast of the reading surface"). */
  contrast(): ReaderContrast;
  setContrast(contrast: ReaderContrast): Promise<void>;
  /** The feed's order and choices: kept in the settings, so they are the same after every restart. */
  filter(): FeedFilter;
  setFilter(filter: FeedFilter): Promise<void>;
  /**
   * Ask the Studio to fetch the blygs it reads now. `force`: the person tapped Refresh (a shorter pause applies than when the reader merely opens).
   * `asked: false` when it was asked too recently, or could not be asked (`reason` says why, in words).
   */
  checkForNew(force: boolean): Promise<{ asked: true; polling: number } | { asked: false; reason?: string }>;
  /** The Studio's change counters, or null when they cannot be read. The reading counter moves when the list does; the subscriptions counter when a blyg has been fetched. */
  changeMarks(): Promise<ChangeMarks | null>;
}

/** The first words of a post, as plain text. Read from the string, never from an element: a list of posts must not request a single image. */
export function excerptOf(html: string, max = 140): string {
  const text = plainText(html);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}


const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;

export class BlygReaderView extends ItemView {
  private data: ReaderData | null = null;
  private tab: "stream" | "mentions" = "stream";
  private shown: ReadingPost | null = null;
  private filter: FeedFilter = { ...DEFAULT_FILTER };
  /** Keep the feed's choices (order, blyg, length, unread) in the settings: every change goes through here. */
  private saveFilter(): void {
    void this.host.setFilter({ ...this.filter });
  }
  /** What the reader remembers about reading the list, to read as little as it can (ui/readerSync.ts). */
  private sync: SyncMemory = { lastFullAt: 0, readingMoved: false, movedWithoutNew: false };
  /** The Studio's change counters as last seen, and when the list was last read, for the watcher below. */
  private lastMarks: ChangeMarks | null = null;
  private lastWalkAt = 0;
  private lastMentionsAt = 0;
  /** Whether the sort and filter choices are open (they start closed, so the header stays slim). */
  private filtersOpen = false;
  private status = "";
  /** How many things are loading right now: the refresh button and the status line show a spinner while it is above zero. */
  private busyCount = 0;
  /** Bumped by every check for new posts, so an older check stops when a newer one starts. */
  private checking = 0;
  private headerEl: HTMLElement | null = null;
  /** What mentions have shown so far (the mentioning post, the item it was about): asked for once, a few at a time. */
  private readonly mentionInfo = new Map<string, { post: ReadingPost | null; own: string | null; done: boolean }>();
  private readonly mentionSlot = limiter(3);
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
    this.filter = host.filter();
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
    this.loadMine();
    this.registerInterval(window.setInterval(() => {
      if (this.checkedAt !== null && this.status.includes(" · checked ")) this.setStatus(this.checkedText());
    }, 20_000));
    // While the reader is on screen, look at the Studio's change counters now and then (a request that costs almost nothing) and read the list only when they moved.
    this.registerInterval(window.setInterval(() => void this.lookForMoves(), 30_000));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.clearBottom()));
    this.registerDomEvent(activeWindow, "resize", () => this.clearBottom());
    this.draw();
    // The list saved by the last session shows at once; the Studio is asked behind it.
    const saved = await this.host.readCache().catch(() => null);
    if (saved && this.data === null) {
      this.data = { posts: saved.posts, mentions: saved.mentions, note: "", studioOrigin: saved.studioOrigin, fromCache: true };
      this.setStatus("Showing the list saved last time · updating…");
      this.draw();
      this.busy(+1);
      try {
        // The saved list may be hours old and read marks may have changed elsewhere: this one walk reads the whole window, behind the list already on screen.
        await this.reload(true, { walk: "full", mentions: true });
      } finally {
        this.busy(-1);
      }
      if (this.status.startsWith("Showing the list saved")) this.setStatus(this.data?.note ?? "");
      return;
    }
    await this.reload();
  }

  override async onClose(): Promise<void> {
    this.checking++;
    await Promise.resolve();
  }

  // ---- state -------------------------------------------------------------------------------------------------------------------------------

  /** The font of the post's content, as a class on the pane (the text view's CSS reads it). */
  private applyFont(): void {
    const font = this.host.font();
    for (const f of ["default", "serif", "sans", "mono"] as const) this.contentEl.toggleClass(`is-font-${f}`, f === font);
    const contrast = this.host.contrast();
    for (const c of CONTRASTS) this.contentEl.toggleClass(`is-contrast-${c}`, c === contrast);
  }

  private busy(delta: number): void {
    this.busyCount = Math.max(0, this.busyCount + delta);
    this.headerEl?.toggleClass("is-busy", this.busyCount > 0);
    this.statusEl?.toggleClass("is-busy", this.busyCount > 0);
    if (this.refreshEl?.isConnected) this.refreshEl.disabled = this.busyCount > 0;
  }

  /** When the Studio was last asked to look for new posts, and what it found: shown as "checked 2 min ago" and kept current while the reader is open. */
  private checkedAt: number | null = null;
  private checkedFresh = 0;
  private checkedText(): string {
    const ago = this.checkedAt === null ? "" : relativeTime(new Date(this.checkedAt).toISOString(), Date.now());
    return `${this.checkedFresh > 0 ? `${this.checkedFresh} new or changed post${this.checkedFresh === 1 ? "" : "s"}` : "Up to date"} · checked ${ago}`;
  }

  private setStatus(text: string): void {
    this.status = text;
    this.statusEl?.setText(text);
  }

  /**
   * Read the list from the Studio. `quiet`: keep the status line and leave an open post alone (its page would reload). `walk`: the whole window, or only the newest
   * rows until the walk reaches what is held (the default is chosen from what has moved, ui/readerSync.ts). `mentions`: ask for the mentions too (the whole window does).
   */
  private async reload(quiet = false, o: { walk?: "full" | "incremental"; force?: boolean; mentions?: boolean } = {}): Promise<void> {
    const walk = o.walk ?? chooseWalk(this.sync, Date.now(), this.data !== null && this.data.partial !== true, o.force === true);
    const held = this.data !== null && this.data.partial !== true ? this.data : null;
    const known = walk === "incremental" && held ? knownOf(held.posts) : null;
    const withMentions = o.mentions === true || walk === "full" || held === null;
    if (!quiet) {
      this.setStatus("Loading…");
      this.busy(+1);
    }
    try {
      // The list arrives a page at a time: the first posts are shown as soon as they are there, and the status line counts what has come.
      const got = await this.host.load(quiet || known !== null ? undefined : (soFar) => {
        if (this.data === null || this.data.partial === true) {
          this.data = { posts: soFar, mentions: [], note: "", studioOrigin: this.data?.studioOrigin ?? null, partial: true };
          if (!this.shown) this.drawBody();
        }
        this.setStatus(`Loading… ${soFar.length} ${soFar.length === 1 ? "post" : "posts"} so far`);
        this.drawHeader();
      }, { known, mentions: withMentions, force: o.force === true });
      if (got.ok) {
        let posts = got.data.posts;
        if (got.data.incremental && held) {
          const changed = changedCount(posts, known ?? new Map<string, string>());
          this.sync.movedWithoutNew = this.sync.readingMoved && changed === 0;
          posts = mergeFresh(held.posts, posts, READER_KEEP);
        } else {
          this.sync.lastFullAt = Date.now();
          this.sync.readingMoved = false;
          this.sync.movedWithoutNew = false;
        }
        this.lastWalkAt = Date.now();
        this.keepLocalReadState(posts);
        const mentions = got.data.mentionsFetched === false && held ? held.mentions : got.data.mentions;
        if (got.data.mentionsFetched !== false) this.lastMentionsAt = Date.now();
        this.data = { ...got.data, posts, mentions, incremental: false, fromCache: false };
        this.host.writeCache({ posts, mentions });
        // A blyg the Studio no longer reads cannot stay chosen: the feed would be empty with no way to tell why.
        if (this.filter.source !== null && !posts.some((q) => q.subscriptionId === this.filter.source)) {
          this.filter.source = null;
          this.saveFilter();
        }
        // (A post opened from the first pages keeps its own status line, e.g. "Opening the page…".)
        if (!quiet && (this.status === "" || this.status.startsWith("Loading"))) this.setStatus(got.data.note);
      } else if (!quiet) {
        this.data = held;
        this.setStatus(got.message);
      } else if (this.data?.fromCache) {
        this.setStatus(got.message);
      }
    } finally {
      if (!quiet) this.busy(-1);
    }
    this.drawHeader();
    if (!this.shown) this.drawBody(); // an open post is left alone: its page would load again
  }

  /** Note what the Studio's change counters say now: did the reading list move since the last look? */
  private noteMarks(now: ChangeMarks): boolean {
    const last = this.lastMarks;
    this.lastMarks = now;
    if (last === null) return false;
    const moved = now.epoch !== last.epoch || now.reading !== last.reading || now.subscriptions !== last.subscriptions;
    if (now.reading !== last.reading || now.epoch !== last.epoch) this.sync.readingMoved = true;
    return moved;
  }

  /** The watcher: a quiet look at the counters, and a read of the list at most once a minute, only when they moved. Nothing while a check runs or the reader is hidden. */
  private async lookForMoves(): Promise<void> {
    if (!this.contentEl.isShown() || this.busyCount > 0 || this.moving) return;
    const now = await this.host.changeMarks();
    if (now === null) return;
    if (this.noteMarks(now) && Date.now() - this.lastWalkAt >= 60_000) await this.reload(true);
  }

  /**
   * "Refresh": ask the Studio to fetch the blygs it reads, then watch its change counters (every three seconds) and read the list ONCE when it is done: when
   * every blyg has reported (the subscriptions counter rises once per blyg fetched), after four quiet seconds once one has, or after half a minute. (The reader
   * used to read the whole list again whenever the reading counter moved, which with many blygs was dozens of reads of everything; measured in the notes.)
   */
  private async checkForNew(force: boolean): Promise<void> {
    const run = ++this.checking;
    this.busy(+1);
    try {
      const before = await this.host.changeMarks();
      if (before !== null) this.noteMarks(before);
      const asked = await this.host.checkForNew(force);
      if (run !== this.checking) return;
      if (!asked.asked) {
        if (asked.reason) this.setStatus(asked.reason);
        await this.reload(true, { force });
        return;
      }
      const known = new Set((this.data?.posts ?? []).map((p) => `${keyOf(p)}/${p.version}`));
      this.setStatus(`Checking ${asked.polling} blyg${asked.polling === 1 ? "" : "s"} for new posts…`);
      let mark = before;
      const startedAt = Date.now();
      let lastMove = startedAt;
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 3000));
        if (run !== this.checking || !this.contentEl.isConnected) return;
        const now = await this.host.changeMarks();
        if (now !== null) {
          const reset = mark !== null && now.epoch !== mark.epoch;
          const moved = this.noteMarks(now) || mark === null || reset;
          if (moved) lastMove = Date.now();
          mark = now;
          if (reset) break;
        }
        const reported = mark !== null && before !== null ? mark.subscriptions - before.subscriptions : 0;
        if (reported >= asked.polling) break;
        if (reported > 0 && Date.now() - lastMove >= 4000) break;
        if (Date.now() - startedAt >= 30_000) break;
      }
      if (run !== this.checking) return;
      await this.reload(true, { force });
      const fresh = (this.data?.posts ?? []).filter((p) => !known.has(`${keyOf(p)}/${p.version}`)).length;
      this.checkedAt = Date.now();
      this.checkedFresh = fresh;
      this.setStatus(this.checkedText());
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
    this.clearBottom();
  }

  private button(parent: HTMLElement, text: string, run: () => void | Promise<void>, opts: { active?: boolean; disabled?: boolean; title?: string; cls?: string } = {}): HTMLButtonElement {
    const b = parent.createEl("button", { text, cls: `blyg-reader-btn${opts.cls ? ` ${opts.cls}` : ""}`, ...(opts.title ? { attr: { title: opts.title, "aria-label": opts.title } } : {}) });
    if (opts.active) b.addClass("is-active");
    b.disabled = opts.disabled === true;
    b.addEventListener("click", () => void run());
    return b;
  }

  /** An icon of Obsidian's own set before an element's text (never an emoji character: on a phone those draw as colour pictures). */
  private addIcon(el: HTMLElement, icon: string): void {
    const span = createSpan({ cls: "blyg-reader-icon" });
    setIcon(span, icon);
    el.prepend(span);
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

  /** Whether the open post is one of the feed's (a mention's post from a blyg the Studio does not read has no read mark and no "next"). */
  private inFeed(p: ReadingPost): boolean {
    return p.subscriptionId !== "" && (this.data?.posts.some((q) => keyOf(q) === keyOf(p)) ?? false);
  }

  /** True while the "marked read" moment plays, so a second tap or pull does not start a second one. */
  private moving = false;

  /**
   * Mark the post read (if it is not) and open the next unread one in the feed's order; with none left, back to the feed. Used by the header button
   * and the pull-up. The mark is shown at once and goes to the Studio meanwhile; the text fades and "Marked read" shows for a moment before the next post.
   */
  private async goNext(p: ReadingPost): Promise<void> {
    if (!this.inFeed(p) || this.moving) return;
    this.moving = true;
    try {
      const wasUnread = isUnread(p) && !p.withdrawn;
      if (wasUnread) void this.setRead(p, true);
      const after = this.nextFor(p);
      await this.markedMoment(wasUnread);
      if (after) this.openPost(after);
      else {
        this.trail = []; // nothing is left to read: the list, not the post a quote was followed from
        this.closePost();
        this.setStatus("No more unread posts in this order.");
      }
    } finally {
      this.moving = false;
    }
  }

  /** The short moment between two posts: the text fades, a centred "Marked read" appears and goes again. (Reduced motion: no waiting.) */
  private async markedMoment(wasUnread: boolean): Promise<void> {
    const reduce = activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const body = this.bodyEl;
    if (!body || reduce) return;
    const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
    body.addClass("is-leaving");
    const note = wasUnread ? body.createDiv({ cls: "blyg-reader-done", text: "✓ Marked read" }) : null;
    await pause(30);
    note?.addClass("is-in");
    await pause(wasUnread ? 520 : 200);
    note?.removeClass("is-in");
    await pause(wasUnread ? 220 : 0);
    note?.remove();
    body.removeClass("is-leaving");
  }

  /**
   * Pull up at the end of a post in the text view, as at the end of a feed in other readers: a label shows what will happen and fills as you pull;
   * let go early and nothing happens. Touch only; a mouse has the button.
   */
  private attachPull(scroll: HTMLElement, p: ReadingPost): void {
    if (!this.inFeed(p)) return;
    const hint = this.bodyEl?.createDiv({ cls: "blyg-reader-pull" });
    if (!hint) return;
    const words = (ready: boolean): string => {
      const next = this.nextFor(p);
      const unread = isUnread(this.live(p));
      const what = unread ? (next ? "mark read and open next" : "mark read and go back") : next ? "open next" : "go back to the feed";
      return ready ? `Let go to ${what}` : `Keep pulling to ${what}`;
    };
    let startY: number | null = null;
    let ready = false;
    const reset = (): void => {
      startY = null;
      ready = false;
      hint.removeClass("is-shown", "is-ready");
      hint.setCssProps({ "--pull": "0" });
      scroll.setCssProps({ "--pull": "0" });
    };
    const atEnd = (): boolean => scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
    scroll.addEventListener("touchstart", (e) => {
      startY = atEnd() && e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
    }, { passive: true });
    scroll.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      const y = e.touches[0]?.clientY;
      if (y === undefined) return;
      const progress = pullProgress(startY - y);
      if (progress <= 0 || !atEnd()) {
        hint.removeClass("is-shown", "is-ready");
        scroll.setCssProps({ "--pull": "0" });
        ready = false;
        return;
      }
      ready = progress >= 1;
      hint.setText(words(ready));
      hint.addClass("is-shown");
      hint.toggleClass("is-ready", ready);
      hint.setCssProps({ "--pull": String(progress) });
      scroll.setCssProps({ "--pull": String(progress) });
    }, { passive: true });
    scroll.addEventListener("touchend", () => {
      const go = ready;
      reset();
      if (go) void this.goNext(p);
    }, { passive: true });
    scroll.addEventListener("touchcancel", reset, { passive: true });
  }

  /**
   * Obsidian's bottom bar floats over the pane on a phone and its height is not something we can read from a CSS variable we know: measure where it
   * is and keep the pane's last line above it. Nothing to do where there is no such bar (a desktop).
   */
  private clearBottom(): void {
    const root = this.contentEl;
    const bar = root.ownerDocument.querySelector(".mobile-navbar");
    if (!bar?.instanceOf(HTMLElement)) {
      root.style.removeProperty("--blyg-bottom-clear");
      return;
    }
    const overlap = Math.max(0, root.getBoundingClientRect().bottom - bar.getBoundingClientRect().top);
    root.style.setProperty("--blyg-bottom-clear", `${Math.ceil(overlap)}px`);
  }

  /** The owner's own items, loaded when a post is opened: their replies to it make the green "You" chip. Null until loaded. */
  private mine: StudioListedItem[] | null = null;
  private mineAsked = false;
  private responsesEl: HTMLElement | null = null;

  private loadMine(): void {
    if (this.mineAsked) return;
    this.mineAsked = true;
    void this.host.myItems().then((items) => {
      this.mine = items;
      if (this.shown) this.drawHeader();
      else if (this.tab === "stream") for (const q of this.data?.posts ?? []) this.refreshPost(q); // the green badges of the feed's cards
    }).catch(() => {
      this.mine = [];
    }).finally(() => {
      // asked again after a few minutes, not for every post
      window.setTimeout(() => (this.mineAsked = false), 5 * 60_000);
    });
  }

  private closeResponses(): void {
    this.responsesEl?.remove();
    this.responsesEl = null;
  }

  /** The replies to this post that the reader can see, as cards like the feed's (your own highlighted); a tap opens one. */
  private showResponses(p: ReadingPost, entries: ResponseEntry[]): void {
    this.closeResponses();
    const body = this.bodyEl;
    if (!body) return;
    const sheet = body.createDiv({ cls: "blyg-reader-responses" });
    this.responsesEl = sheet;
    const top = sheet.createDiv({ cls: "blyg-reader-responses-top" });
    top.createDiv({ cls: "blyg-reader-responses-title", text: "Replies you can see" });
    this.button(top, "Close", () => this.closeResponses(), { title: "Close the list" });
    sheet.createDiv({ cls: "blyg-reader-meta blyg-reader-responses-note", text: "Your own replies, and posts of blygs you read that answer this one. Other replies are not visible from here." });
    const list = sheet.createDiv({ cls: "blyg-reader-column" });
    for (const e of entries) {
      const card = list.createDiv({ cls: `blyg-reader-row blyg-reader-card blyg-reader-response${e.kind === "mine" ? " is-mine" : ""}` });
      const meta = card.createDiv({ cls: "blyg-reader-meta" });
      if (e.kind === "mine") {
        meta.createSpan({ cls: "blyg-reader-badge is-mine", text: "You" });
        meta.appendText(` ${e.draft ? "draft" : "your reply"} · ${relativeTime(e.when, Date.now())}`);
        card.createDiv({ cls: "blyg-reader-excerpt", text: excerptOf(`<p>${e.text.replace(/[<>&]/g, " ")}</p>`, 200) });
        card.addEventListener("click", () => {
          void this.host.openOwnItem(e.itemId).then((ok) => {
            if (!ok) this.setStatus("That note is not in this vault.");
          });
        });
      } else {
        meta.appendText([e.post.authorName, e.post.subscriptionTitle].filter((x): x is string => !!x).join(" · ") + ` · ${relativeTime(e.when, Date.now())}`);
        card.createDiv({ cls: "blyg-reader-excerpt", text: excerptOf(e.post.contentHtml, 200) });
        card.addEventListener("click", () => {
          this.closeResponses();
          this.openPost(e.post, "quote");
        });
      }
    }
    if (entries.length === 0) list.createDiv({ cls: "blyg-reader-note", text: `Nothing visible answers “${excerptOf(p.contentHtml, 40)}” yet.` });
  }

  /** The order the feed has now (without "unread only"), kept while the list and the order choices stay as they are: the open post and its buttons ask for the next unread post often. */
  private orderMemo: { posts: ReadingPost[]; key: string; order: ReadingPost[] } | null = null;
  private nextFor(p: ReadingPost): ReadingPost | null {
    const posts = this.data?.posts;
    if (!posts) return null;
    const key = `${this.filter.sort}|${this.filter.source ?? ""}|${this.filter.length}`;
    if (!this.orderMemo || this.orderMemo.posts !== posts || this.orderMemo.key !== key) this.orderMemo = { posts, key, order: arrange(posts, { ...this.filter, unreadOnly: false }) };
    return nextInOrder(this.orderMemo.order, p);
  }

  /** The replies you can see, looked up per post from an index built once per list and set of own items. */
  private respMemo: { posts: ReadingPost[]; mine: StudioListedItem[]; index: (p: ReadingPost) => ResponseEntry[] } | null = null;
  private respFor(p: ReadingPost): ResponseEntry[] {
    const posts = this.data?.posts ?? [];
    const mine = this.mine ?? [];
    if (!this.respMemo || this.respMemo.posts !== posts || this.respMemo.mine !== mine) this.respMemo = { posts, mine, index: responseIndex(mine, posts) };
    return this.respMemo.index(p);
  }

  /** The posts you came from by following a quote to its source: Back goes to the last of them, and to the list when there is none. */
  private trail: ReadingPost[] = [];

  private closePost(): void {
    const back = this.trail.pop();
    if (back) {
      this.openPost(back, "back");
      return;
    }
    this.shown = null;
    this.drawHeader();
    this.drawBody();
  }

  /**
   * Open a post from the feed (or the next one): the page state starts afresh, the post starts at its top. `via`: "quote" follows a quote to its source
   * (the post you leave is kept for Back), "back" is that Back; anything else starts a fresh trail.
   */
  private openPost(p: ReadingPost, via: "feed" | "quote" | "back" = "feed"): void {
    if (this.shown === null) this.feedScroll = this.scrollEl?.scrollTop ?? 0;
    if (via === "quote" && this.shown) this.trail.push(this.shown);
    else if (via === "feed") this.trail = [];
    this.closeResponses();
    this.shown = p;
    this.drawHeader();
    this.drawBody();
    this.loadMine();
  }

  private drawFeedHeader(h: HTMLElement): void {
    const row = h.createDiv({ cls: "blyg-reader-bar" });
    for (const [id, label] of [["stream", "Reading"], ["mentions", `Mentions${this.data ? ` (${this.data.mentions.length})` : ""}`]] as const) {
      this.button(row, label, () => {
        this.tab = id;
        this.drawHeader();
        this.drawBody();
        // The mentions are read with the whole window, not with every quick look: when they are old, read them as the tab opens.
        if (id === "mentions" && Date.now() - this.lastMentionsAt > 60_000) void this.reload(true, { walk: "incremental", mentions: true });
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
      void this.checkForNew(true);
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
    select("Order", (Object.keys(SORT_LABELS) as FeedSort[]).map((k): [string, string] => [k, SORT_LABELS[k]]), this.filter.sort, (v) => { this.filter.sort = v as FeedSort; this.saveFilter(); });
    const posts = this.data.posts;
    select("Blyg", [["", `All blygs (${posts.length})`], ...sourcesOf(posts).map((s): [string, string] => [s.id, `${s.title} (${s.count})`])], this.filter.source ?? "", (v) => { this.filter.source = v === "" ? null : v; this.saveFilter(); });
    select("Length", (Object.keys(LENGTH_LABELS) as FeedLength[]).map((k): [string, string] => [k, LENGTH_LABELS[k]]), this.filter.length, (v) => { this.filter.length = v as FeedLength; this.saveFilter(); });
    select("Font for posts", (Object.keys(FONT_LABELS) as ReaderFont[]).map((k): [string, string] => [k, k === "default" ? "Font: as it is" : `Font: ${FONT_LABELS[k]}`]), this.host.font(), (v) => {
      if (isReaderFont(v)) void this.host.setFont(v).then(() => this.applyFont());
    }, () => undefined);
    select("Contrast of the reading surface", CONTRASTS.map((k): [string, string] => [k, CONTRAST_LABELS[k]]), this.host.contrast(), (v) => {
      if (isReaderContrast(v)) void this.host.setContrast(v).then(() => this.applyFont());
    }, () => undefined);
    const unread = controls.createEl("label", { cls: "blyg-reader-toggle" });
    const box = unread.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.filter.unreadOnly;
    unread.appendText(" Unread only");
    box.addEventListener("change", () => {
      this.filter.unreadOnly = box.checked;
      this.saveFilter();
      this.drawHeader();
      this.drawBody();
    });
  }

  private drawPostHeader(h: HTMLElement, p: ReadingPost): void {
    const web = frameable(p.sourceUrl) ? p.sourceUrl : null;
    const held = p.subscriptionId !== ""; // the Studio reads this blyg; otherwise (a mention's post) there is no read mark and nothing to quote from
    const unread = isUnread(p);
    // The two things done most come first and large: the way back, and on to the next post. The rest sits below them.
    const main = h.createDiv({ cls: "blyg-reader-bar blyg-reader-bar-main" });
    this.button(main, "Back", () => this.closePost(), { cls: "blyg-reader-back", title: this.trail.length > 0 ? "Back to the post you came from" : "Back to the list" });
    main.createDiv({ cls: "blyg-reader-spacer" });
    if (this.inFeed(p)) {
      const next = this.nextFor(p);
      this.button(main, unread ? "Read & next ›" : "Next ›", () => this.goNext(p), { cls: "blyg-reader-nextbtn", active: unread, title: unread ? "Mark this post read and open the next unread one" : next ? "Open the next unread post" : "No unread post left: back to the feed" });
    }
    const row = h.createDiv({ cls: "blyg-reader-bar" });
    this.button(row, "Reply", () => this.host.replyTo(p), { disabled: p.withdrawn || !held, title: held ? "Reply in Obsidian: a new thread that answers this post" : "Subscribe to this blyg in your Studio to reply to its posts from here" });
    this.button(row, unread ? "○ Mark read" : "✓ Read", () => this.setRead(p, unread), {
      disabled: p.withdrawn || !held,
      active: !unread,
      cls: "blyg-reader-readtoggle",
      title: unread ? "Mark this post read" : "Read. Tap to mark it unread again",
    });
    const chip = responseChip(this.respFor(p));
    if (chip) {
      const b = this.button(row, chip.text, () => (this.responsesEl ? this.closeResponses() : this.showResponses(p, this.respFor(p))), { cls: `blyg-reader-resp${chip.mine ? " is-mine" : ""}`, title: chip.title });
      this.addIcon(b, "reply");
    }
    this.button(row, "Browser", () => (web ? this.host.openWeb(web) : undefined), { disabled: web === null, title: "Open the whole page in the browser" });
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
        this.openPost(p);
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
    // The replies you can see (same rule as in an open post): green when one of them is yours.
    const chip = this.mine !== null || (this.data?.posts.length ?? 0) > 0 ? responseChip(this.respFor(p)) : null;
    if (chip) this.addIcon(badges.createSpan({ cls: `blyg-reader-badge blyg-reader-resp-badge${chip.mine ? " is-mine" : ""}`, text: chip.text, attr: { title: chip.title } }), "reply");
    if (!p.withdrawn) {
      const c = cardOf(p);
      if (c.quote) card.createDiv({ cls: "blyg-reader-quote", text: c.quote });
      if (c.words) card.createDiv({ cls: "blyg-reader-excerpt", text: c.words });
      if (c.images > 0) card.createDiv({ cls: "blyg-reader-meta", text: `${c.images} image${c.images === 1 ? "" : "s"}` });
    }
  }

  private drawMentions(col: HTMLElement, mentions: InboundMention[]): void {
    const shown = visibleMentions(mentions);
    if (shown.length === 0) col.createDiv({ cls: "blyg-reader-note", text: "No one has mentioned your items yet." });
    for (const m of shown) {
      const row = col.createDiv({ cls: "blyg-reader-row blyg-reader-mention" });
      row.createDiv({ cls: "blyg-reader-meta", text: `${mentionLead(m)} · ${relativeTime(m.firstSeen, Date.now())}` });
      const text = row.createDiv({ cls: "blyg-reader-excerpt" });
      const own = row.createDiv({ cls: "blyg-reader-meta blyg-reader-ownitem" });
      const fill = (): void => {
        const info = this.mentionInfo.get(m.id);
        text.setText(info?.post ? excerptOf(info.post.contentHtml, 220) || "(no text)" : info?.done ? "Its text could not be shown here." : "…");
        own.setText(info?.own ? `On: ${info.own}` : "");
        own.toggleClass("is-empty", !info?.own);
      };
      fill();
      void this.loadMention(m).then(fill);
      row.addEventListener("click", () => {
        if ((activeWindow.getSelection()?.toString() ?? "") !== "") return;
        void this.openMention(m);
      });
    }
  }

  /** What a mention shows, fetched once and a few at a time; a card redraws itself when its answer is there. */
  private loadMention(m: InboundMention): Promise<void> {
    const have = this.mentionInfo.get(m.id);
    if (have?.done) return Promise.resolve();
    return this.mentionSlot(async () => {
      const posts = this.data?.posts ?? [];
      const [post, own] = await Promise.all([
        postOfMention(posts, m) ?? this.host.mentionPost(m, posts).catch(() => null),
        this.host.ownExcerpt(m.targetItemId).catch(() => null),
      ]);
      this.mentionInfo.set(m.id, { post, own, done: true });
    });
  }

  /** Open the mentioning post like any post: the same header, the same bar below. */
  private async openMention(m: InboundMention): Promise<void> {
    await this.loadMention(m);
    const post = this.mentionInfo.get(m.id)?.post;
    if (post) this.openPost(post);
    else if (m.sourcePage) this.host.openWeb(m.sourcePage);
    else this.setStatus("That item could not be opened here.");
  }

  /** The post as text: images and markup decided before the sanitiser builds an element (see defang.ts). */
  private drawText(into: HTMLElement, p: ReadingPost): void {
    const guard = renderForeign(p.contentHtml, { trustedOrigin: this.data?.studioOrigin ?? null, mode: this.host.imageMode(), baseUrl: p.sourceUrl ?? p.origin }, sanitizeHTMLToDom);
    if (guard.blocked > 0) this.button(into, `Load images (${guard.blocked})`, () => guard.loadAll(), { cls: "blyg-reader-loadall" });
    const body = into.createDiv({ cls: "blyg-reader-body" });
    body.appendChild(guard.fragment);
    this.nameQuoteSources(body, p);
  }

  /**
   * Under each quote of another blyg's item say where it comes from, as far as the post and the Studio can tell. The quote carries the item's id, the
   * origin of a REMOTE source (the post's own blyg is the source when there is none) and, when the author gave one, a label: the quoter's own name for
   * the quoted item, which a reader may use as the anchor text of its attribution line and for nothing else (spec 0.4 §10.1).
   *   - a post of a blyg you read: "label · Author · Blog", a tap opens it here (Back returns to this post);
   *   - another blyg's item: "label · host", a tap looks the item up through your Studio and opens its page in the browser;
   *   - your own item: "You, in your own item".
   * Text only, set as text.
   */
  private nameQuoteSources(body: HTMLElement, p: ReadingPost): void {
    for (const quote of Array.from(body.querySelectorAll("blockquote.blyg-transclusion"))) {
      if (!quote.instanceOf(HTMLElement)) continue;
      const id = quote.getAttribute("data-blyg-id") ?? "";
      const label = (quote.getAttribute("data-blyg-label") ?? "").trim();
      const origin = quote.getAttribute("data-blyg-origin") ?? p.origin;
      const from = postOfQuote(this.data?.posts ?? [], id);
      const link = (text: string, title: string, open: () => void): void => {
        const line = quote.createDiv({ cls: "blyg-quote-source is-link", text, attr: { role: "link", tabindex: "0", title } });
        this.addIcon(line, "arrow-up-right");
        line.addEventListener("click", open);
        line.addEventListener("keydown", (e) => {
          if (e.key === "Enter") open();
        });
      };
      if (from && !(from.subscriptionId === p.subscriptionId && from.remoteId === p.remoteId)) {
        const who = [from.authorName, from.subscriptionTitle].filter((x): x is string => !!x && x !== "").join(" · ");
        link(`${[label, who].filter((x) => x !== "").join(" · ") || "Open the post"}`, "Open this post here", () => this.openPost(from, "quote"));
        continue;
      }
      if (id === "") continue;
      void this.host.isOwnItem(id).then((own) => {
        if (!quote.isConnected) return;
        if (own) {
          quote.createDiv({ cls: "blyg-quote-source", text: label ? `You, in your own item · ${label}` : "You, in your own item" });
        } else if (origin) {
          let host = "";
          try {
            host = new URL(origin).host;
          } catch {
            return;
          }
          link(`${[label, host].filter((x) => x !== "").join(" · ")}`, "Look this item up and open its page in the browser", () => {
            void this.host.openQuotedItem(origin, id).then((ok) => {
              if (!ok) this.setStatus("That item could not be found.");
            });
          });
        }
      }).catch(() => undefined);
    }
  }

  private drawPostBody(body: HTMLElement, p: ReadingPost): void {
    const scroll = body.createDiv({ cls: "blyg-reader-scroll blyg-reader-surface" });
    this.attachPull(scroll, p);
    this.drawText(scroll.createDiv({ cls: "blyg-reader-column" }), p);
  }
}
