// PROOF OF CONCEPT (roadmap S15): a minimal reader pane. A stream of the posts of the blygs the owner reads, a mentions list, one post at a time,
// and the three hand-offs a reader needs: open on the web, reply in Obsidian, mark read. Drawing only; what it asks of the plugin is `ReaderHost`.
// Foreign markup only ever goes through `sanitizeHTMLToDom` (the Studio's own HTML is already sanitised; this is the second lock). No innerHTML.
import { ItemView, sanitizeHTMLToDom, type WorkspaceLeaf } from "obsidian";
import { plainText, renderForeign, type ImageMode } from "./defang";
import { isUnread, relationWords, type InboundMention, type ReadingPost } from "../studio/reading";
import { arrange, cardOf, DEFAULT_FILTER, frameable, relativeTime, sourcesOf, type FeedFilter, type FeedSort } from "./readerFeed";
import { frameUrlFor, READER_FRAME_SANDBOX } from "./trimmedPage";

export const BLYG_READER_VIEW = "blyg-reader";

export interface ReaderData {
  posts: ReadingPost[];
  mentions: InboundMention[];
  /** One line when something was cut short or could not be read. */
  note: string;
  /** The owner's Studio origin: the only place an image may be loaded from while reading. */
  studioOrigin: string | null;
}

export interface ReaderHost {
  /** The owner's choice for images in posts (the setting `reader.images`), read each time a post is drawn. */
  imageMode(): ImageMode;
  /** Load the stream and the mentions, or say in words why not. */
  load(): Promise<{ ok: true; data: ReaderData } | { ok: false; message: string }>;
  openWeb(url: string): void;
  /** Start a reply thread to this post (the same path as "Reply to an item"). */
  replyTo(post: ReadingPost): Promise<void>;
  /** Mark this version read; returns a line to show. */
  markRead(post: ReadingPost): Promise<string>;
  /** How a post opens (the setting `readerPane.view`). */
  viewMode(): "web" | "text";
  /**
   * Ask the Studio to fetch the blygs it reads now. `force`: the person tapped Refresh (a shorter pause applies than when the reader merely opens).
   * `asked: false` when it was asked too recently, or could not be asked (`reason` says why, in words).
   */
  checkForNew(force: boolean): Promise<{ asked: true; polling: number } | { asked: false; reason?: string }>;
  /** A mark that changes when the Studio's reading list changes (from its change counters), or null when it cannot be read. */
  readingMark(): Promise<string | null>;
  /**
   * Prepare a post's page for the frame: `trimmed` (the post alone, with the blyg's stylesheets, see trimmedPage.ts), `full` (the page has no article
   * the reader recognises, and allows framing: the whole page is shown), `forbidden` (no article, and its headers refuse framing), `unreachable`.
   * Note: Obsidian DESKTOP removes `X-Frame-Options` and CSP `frame-ancestors` from every response (its own session hook, read in Obsidian 1.14.5), so
   * there `forbidden` is never seen; on mobile the headers arrive.
   */
  preparePage(url: string): Promise<{ kind: "trimmed"; doc: string } | { kind: "full" } | { kind: "forbidden" } | { kind: "unreachable" }>;
}

/** The first words of a post, as plain text. Read from an inert document: a list of posts must not request a single image. */
export function excerptOf(html: string, max = 140): string {
  const text = plainText(html);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type PageState = { s: "unknown" } | { s: "asking" } | { s: "trimmed"; url: string } | { s: "full" } | { s: "forbidden" } | { s: "unreachable" };

export class BlygReaderView extends ItemView {
  private data: ReaderData | null = null;
  private tab: "stream" | "mentions" = "stream";
  private shown: ReadingPost | null = null;
  /** How the open post is shown, and whether its page may be framed (asked once per post). */
  private shownAs: "web" | "text" = "web";
  /** The open post's page, once prepared. `trimmed` holds an object URL that must be revoked when the post closes. */
  private page: PageState = { s: "unknown" };
  /** Read through a call, so a check after an assignment in the same function is not narrowed away by the type checker. */
  private pageState(): PageState {
    return this.page;
  }
  private filter: FeedFilter = { ...DEFAULT_FILTER };
  private status = "";
  private statusEl: HTMLElement | null = null;
  /** Bumped by every check for new posts, so an older check stops when a newer one starts. */
  private checking = 0;

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
    await this.reload();
    void this.checkForNew(false);
  }

  override async onClose(): Promise<void> {
    this.checking++;
    this.releasePage();
    await Promise.resolve();
  }

  /** Forget the open post's page (and free its object URL). */
  private releasePage(): void {
    if (this.page.s === "trimmed") URL.revokeObjectURL(this.page.url);
    this.page = { s: "unknown" };
  }

  /** Read the list from the Studio. `quiet`: keep the status line and do not redraw an open post (its page would reload). */
  private async reload(quiet = false): Promise<void> {
    if (!quiet) this.setStatus("Loading…");
    const got = await this.host.load();
    if (got.ok) {
      this.data = got.data;
      if (!quiet) this.status = got.data.note;
    } else if (!quiet) {
      this.data = null;
      this.status = got.message;
    }
    if (!quiet || !this.shown) this.draw();
  }

  /**
   * Ask the Studio to fetch the blygs it reads, then watch its change counter for up to half a minute and reload the list whenever it moves. The list
   * shown meanwhile is what the Studio already had; the status line says what is going on.
   */
  private async checkForNew(force: boolean): Promise<void> {
    const run = ++this.checking;
    const before = await this.host.readingMark();
    const asked = await this.host.checkForNew(force);
    if (run !== this.checking) return;
    if (!asked.asked) {
      if (asked.reason) this.setStatus(asked.reason);
      return;
    }
    const known = new Set((this.data?.posts ?? []).map((p) => `${p.subscriptionId}/${p.remoteId}/${p.version}`));
    this.setStatus(`Checking ${asked.polling} blyg${asked.polling === 1 ? "" : "s"} for new posts…`);
    let mark = before;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => window.setTimeout(r, 2000));
      if (run !== this.checking || !this.contentEl.isConnected) return;
      const now = await this.host.readingMark();
      if (now !== null && now !== mark) {
        mark = now;
        await this.reload(true);
      }
    }
    if (run !== this.checking) return;
    const fresh = (this.data?.posts ?? []).filter((p) => !known.has(`${p.subscriptionId}/${p.remoteId}/${p.version}`)).length;
    const at = new Date().toTimeString().slice(0, 5);
    this.setStatus(fresh > 0 ? `${fresh} new or changed post${fresh === 1 ? "" : "s"} · checked ${at}` : `Up to date · checked ${at}`);
  }

  private setStatus(text: string): void {
    this.status = text;
    if (this.statusEl?.isConnected) this.statusEl.setText(text);
    else this.draw();
  }

  private draw(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("blyg-reader");
    root.toggleClass("is-post", this.shown !== null);
    const bar = root.createDiv({ cls: "blyg-reader-bar" });
    if (this.shown) {
      bar.createEl("button", { text: "Back", cls: "blyg-reader-btn" }).addEventListener("click", () => {
        this.shown = null;
        this.releasePage();
        this.draw();
      });
    } else {
      for (const [id, label] of [["stream", "Reading"], ["mentions", `Mentions${this.data ? ` (${this.data.mentions.length})` : ""}`]] as const) {
        const b = bar.createEl("button", { text: label, cls: "blyg-reader-btn" });
        if (this.tab === id) b.addClass("is-active");
        b.addEventListener("click", () => {
          this.tab = id;
          this.draw();
        });
      }
      bar.createEl("button", { text: "Refresh", cls: "blyg-reader-btn" }).addEventListener("click", () => {
        void this.reload().then(() => this.checkForNew(true));
      });
    }
    this.statusEl = root.createDiv({ cls: "blyg-reader-status", text: this.status });
    if (!this.data) return;
    if (this.shown) return this.drawPost(root, this.shown);
    if (this.tab === "stream") this.drawStream(root, this.data.posts);
    else this.drawMentions(root, this.data.mentions);
  }

  private drawControls(root: HTMLElement, posts: ReadingPost[]): void {
    const row = root.createDiv({ cls: "blyg-reader-controls" });
    const select = (label: string, options: Array<[string, string]>, value: string, set: (v: string) => void): void => {
      const el = row.createEl("select", { cls: "dropdown blyg-reader-select", attr: { "aria-label": label } });
      for (const [v, text] of options) el.createEl("option", { value: v, text });
      el.value = value;
      el.addEventListener("change", () => {
        set(el.value);
        this.draw();
      });
    };
    select("Order", [["newest", "Newest first"], ["oldest", "Oldest first"]], this.filter.sort, (v) => (this.filter.sort = v as FeedSort));
    const sources = sourcesOf(posts);
    select("Blyg", [["", `All blygs (${posts.length})`], ...sources.map((s): [string, string] => [s.id, `${s.title} (${s.count})`])], this.filter.source ?? "", (v) => (this.filter.source = v === "" ? null : v));
    const unread = row.createEl("label", { cls: "blyg-reader-toggle" });
    const box = unread.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.filter.unreadOnly;
    unread.appendText(" Unread only");
    box.addEventListener("change", () => {
      this.filter.unreadOnly = box.checked;
      this.draw();
    });
  }

  private drawStream(root: HTMLElement, posts: ReadingPost[]): void {
    if (posts.length === 0) {
      root.createDiv({ cls: "blyg-reader-status", text: "Nothing to read yet. Subscribe to a blyg in your Studio." });
      return;
    }
    this.drawControls(root, posts);
    const shown = arrange(posts, this.filter);
    if (shown.length === 0) root.createDiv({ cls: "blyg-reader-status", text: "No post matches." });
    const now = Date.now();
    for (const p of shown) {
      const card = root.createDiv({ cls: "blyg-reader-row blyg-reader-card" });
      if (isUnread(p)) card.addClass("is-unread");
      const head = card.createDiv({ cls: "blyg-reader-cardhead" });
      head.createSpan({ cls: "blyg-reader-source", text: p.subscriptionTitle || p.origin || "" });
      const meta = [p.authorName, relativeTime(p.created ?? p.observedAt, now)].filter(Boolean).join(" · ");
      if (meta) head.createSpan({ cls: "blyg-reader-meta", text: ` · ${meta}` });
      const badges = card.createDiv({ cls: "blyg-reader-badges" });
      if (p.isReply) badges.createSpan({ cls: "blyg-reader-badge", text: "reply" });
      else if (p.kind === "thread") badges.createSpan({ cls: "blyg-reader-badge", text: "thread" });
      if (p.withdrawn) badges.createSpan({ cls: "blyg-reader-badge", text: "withdrawn" });
      if (isUnread(p)) badges.createSpan({ cls: "blyg-reader-badge is-new", text: p.readVersion !== null ? "updated" : "unread" });
      if (!p.withdrawn) {
        const c = cardOf(p);
        if (c.quote) card.createDiv({ cls: "blyg-reader-quote", text: c.quote });
        if (c.words) card.createDiv({ cls: "blyg-reader-excerpt", text: c.words });
        if (c.images > 0) card.createDiv({ cls: "blyg-reader-meta", text: `${c.images} image${c.images === 1 ? "" : "s"}` });
      }
      card.addEventListener("click", () => {
        this.releasePage();
        this.shown = p;
        this.shownAs = this.host.viewMode();
        this.draw();
      });
    }
  }

  private drawMentions(root: HTMLElement, mentions: InboundMention[]): void {
    if (mentions.length === 0) root.createDiv({ cls: "blyg-reader-status", text: "No one has mentioned your items yet." });
    for (const m of mentions) {
      const row = root.createDiv({ cls: "blyg-reader-row" });
      row.createDiv({ cls: "blyg-reader-meta", text: `${m.sourceAuthorName ?? m.sourceOrigin ?? "Someone"} ${relationWords(m.relation)} one of your items` });
      row.createDiv({ cls: "blyg-reader-excerpt", text: m.firstSeen.slice(0, 10) });
      const web = m.sourcePage;
      if (web) row.addEventListener("click", () => this.host.openWeb(web));
    }
  }

  private drawPost(root: HTMLElement, p: ReadingPost): void {
    const web = frameable(p.sourceUrl) ? p.sourceUrl : null;
    const actions = root.createDiv({ cls: "blyg-reader-actions" });
    const act = (text: string, run: () => void | Promise<void>, enabled = true): void => {
      const b = actions.createEl("button", { text, cls: "blyg-reader-btn" });
      b.disabled = !enabled;
      b.addEventListener("click", () => void run());
    };
    act("Reply in Obsidian", () => this.host.replyTo(p), !p.withdrawn);
    act("Mark read", async () => this.setStatus(await this.host.markRead(p)), !p.withdrawn);
    act("Open in browser", () => (web ? this.host.openWeb(web) : undefined), web !== null);
    if (web) {
      act(this.shownAs === "web" ? "Show as text" : "Show as web page", () => {
        this.shownAs = this.shownAs === "web" ? "text" : "web";
        this.draw();
      });
    }
    const source = root.createDiv({ cls: "blyg-reader-meta" });

    if (this.shownAs === "web" && web && !p.withdrawn) {
      const host = new URL(web).host;
      if (this.page.s === "unknown") {
        this.page = { s: "asking" };
        void this.host.preparePage(web).then((prepared) => {
          if (this.shown !== p) return;
          this.page = prepared.kind === "trimmed" ? { s: "trimmed", url: frameUrlFor(prepared.doc) } : { s: prepared.kind };
          this.draw();
        });
      }
      const page = this.pageState();
      if (page.s === "unknown" || page.s === "asking") {
        source.setText(`Opening the post on ${host}…`);
        return;
      }
      if (page.s === "trimmed" || page.s === "full") {
        source.setText(page.s === "trimmed" ? `On the web: ${host} · ${p.subscriptionTitle} · the post only (the whole page: “Open in browser”)` : `On the web: ${host} · ${p.subscriptionTitle}`);
        // The post's own page (trimmed to the post, or whole), as a visit would show it. Sandboxed without scripts and without an origin, so it cannot
        // reach Obsidian; links open outside. It loads its images like any visit: that is what "as on the web" means (the setting says so).
        root.createEl("iframe", { cls: "blyg-reader-frame", attr: { src: page.s === "trimmed" ? page.url : web, sandbox: READER_FRAME_SANDBOX, referrerpolicy: "no-referrer", title: `${p.subscriptionTitle} on the web` } });
        return;
      }
      source.setText(page.s === "forbidden" ? "This blyg does not allow its pages inside other apps, so the post is shown as text." : "The page could not be reached, so the post is shown as text.");
    } else {
      source.setText([p.subscriptionTitle, p.authorName, `version ${p.version}`].filter(Boolean).join(" · "));
    }
    // Images and frames are decided on the text before the sanitiser ever builds an element (see defang.ts), then the result goes on the page.
    const guard = renderForeign(p.contentHtml, { trustedOrigin: this.data?.studioOrigin ?? null, mode: this.host.imageMode() }, sanitizeHTMLToDom);
    if (guard.blocked > 0) act(`Load images (${guard.blocked})`, () => guard.loadAll());
    root.createDiv({ cls: "blyg-reader-body" }).appendChild(guard.fragment);
  }
}
