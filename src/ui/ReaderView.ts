// PROOF OF CONCEPT (roadmap S15): a minimal reader pane. A stream of the posts of the blygs the owner reads, a mentions list, one post at a time,
// and the three hand-offs a reader needs: open on the web, reply in Obsidian, mark read. Drawing only; what it asks of the plugin is `ReaderHost`.
// Foreign markup only ever goes through `sanitizeHTMLToDom` (the Studio's own HTML is already sanitised; this is the second lock). No innerHTML.
import { ItemView, sanitizeHTMLToDom, type WorkspaceLeaf } from "obsidian";
import { plainText, renderForeign, type ImageMode } from "./defang";
import { isUnread, relationWords, type InboundMention, type ReadingPost } from "../studio/reading";

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
}

/** The first words of a post, as plain text. Read from an inert document: a list of posts must not request a single image. */
export function excerptOf(html: string, max = 140): string {
  const text = plainText(html);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class BlygReaderView extends ItemView {
  private data: ReaderData | null = null;
  private tab: "stream" | "mentions" = "stream";
  private shown: ReadingPost | null = null;
  private status = "";

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
  }

  private async reload(): Promise<void> {
    this.status = "Loading…";
    this.draw();
    const got = await this.host.load();
    if (got.ok) {
      this.data = got.data;
      this.status = got.data.note;
    } else {
      this.data = null;
      this.status = got.message;
    }
    this.draw();
  }

  private draw(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("blyg-reader");
    const bar = root.createDiv({ cls: "blyg-reader-bar" });
    if (this.shown) {
      bar.createEl("button", { text: "Back", cls: "blyg-reader-btn" }).addEventListener("click", () => {
        this.shown = null;
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
      bar.createEl("button", { text: "Refresh", cls: "blyg-reader-btn" }).addEventListener("click", () => void this.reload());
    }
    if (this.status) root.createDiv({ cls: "blyg-reader-status", text: this.status });
    if (!this.data) return;
    if (this.shown) return this.drawPost(root, this.shown);
    if (this.tab === "stream") this.drawStream(root, this.data.posts);
    else this.drawMentions(root, this.data.mentions);
  }

  private drawStream(root: HTMLElement, posts: ReadingPost[]): void {
    if (posts.length === 0) root.createDiv({ cls: "blyg-reader-status", text: "Nothing to read yet. Subscribe to a blyg in your Studio." });
    for (const p of posts) {
      const row = root.createDiv({ cls: "blyg-reader-row" });
      if (isUnread(p)) row.addClass("is-unread");
      row.createDiv({ cls: "blyg-reader-meta", text: [p.subscriptionTitle, p.authorName, p.kind].filter(Boolean).join(" · ") });
      row.createDiv({ cls: "blyg-reader-excerpt", text: p.withdrawn ? "(withdrawn)" : excerptOf(p.contentHtml) });
      row.addEventListener("click", () => {
        this.shown = p;
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
    root.createDiv({ cls: "blyg-reader-meta", text: [p.subscriptionTitle, p.authorName, `version ${p.version}`].filter(Boolean).join(" · ") });
    // Images and frames are decided on an inert copy before the sanitiser ever builds an element (see defang.ts), then the result goes on the page.
    const guard = renderForeign(p.contentHtml, { trustedOrigin: this.data?.studioOrigin ?? null, mode: this.host.imageMode() }, sanitizeHTMLToDom);
    root.createDiv({ cls: "blyg-reader-body" }).appendChild(guard.fragment);
    const actions = root.createDiv({ cls: "blyg-reader-actions" });
    const act = (text: string, run: () => void | Promise<void>, enabled = true): void => {
      const b = actions.createEl("button", { text, cls: "blyg-reader-btn" });
      b.disabled = !enabled;
      b.addEventListener("click", () => void run());
    };
    if (guard.blocked > 0) act(`Load images (${guard.blocked})`, () => guard.loadAll());
    act("Reply in Obsidian", () => this.host.replyTo(p), !p.withdrawn);
    const web = p.sourceUrl;
    act("Open on the web", () => (web ? this.host.openWeb(web) : undefined), web !== null);
    act("Mark read", async () => {
      this.status = await this.host.markRead(p);
      this.draw();
    }, !p.withdrawn);
  }
}
