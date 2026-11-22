// The foot of the reader's feed when older posts can be loaded (HK4): a button, a word while it works, a sentence when it could not, a sentence at the limit.
// It owns what it shows (state), the reader owns the list (callbacks). Pure of the reader's other parts, so the merge is tested without a screen.
import type { ReadingPost } from "../studio/reading";
import type { ReaderData } from "./ReaderView";
import { mergeFresh, OLDER_MAX, READER_KEEP, type OlderResult } from "./readerSync";

export interface OlderLinks {
  /** Ask the host for the next older posts. */
  load: () => Promise<OlderResult>;
  /** The list held now, or null. */
  data: () => ReaderData | null;
  /** Put a merged list in place of the one held (and take read changes made here into account). */
  replace: (posts: ReadingPost[]) => void;
  /** Draw the feed again. */
  redraw: () => void;
}

export class OlderPosts {
  private more = false;
  private capped = false;
  private busy = false;
  private failure = "";
  constructor(private readonly links: OlderLinks) {}

  /** What a read of the newest window says: are there older posts beyond it? */
  setMore(more: boolean | undefined): void {
    this.more = more === true;
    if (this.more) this.capped = false;
  }

  /** The row under the last card; nothing when there is nothing older to load (and it never said so). */
  draw(into: HTMLElement): void {
    if (this.busy) into.createDiv({ cls: "blyg-reader-note", text: "Loading older posts…" });
    else if (this.more) {
      const row = into.createDiv({ cls: "blyg-reader-olderrow" });
      if (this.failure !== "") row.createDiv({ cls: "blyg-reader-note", text: this.failure });
      const button = row.createEl("button", { text: "Load older posts", cls: "blyg-reader-btn", attr: { title: "Read the next 200 older posts from your Studio" } });
      button.addEventListener("click", () => void this.load());
    } else if (this.capped) into.createDiv({ cls: "blyg-reader-note", text: `That is as far back as the reader goes: the newest ${OLDER_MAX} posts.` });
  }

  async load(): Promise<void> {
    if (this.busy || !this.links.data()) return;
    this.busy = true;
    this.failure = "";
    this.links.redraw();
    const got = await this.links.load().catch((): OlderResult => ({ ok: false, message: "The Studio could not be reached." }));
    this.busy = false;
    const held = this.links.data();
    if (got.ok) {
      this.more = got.more;
      this.capped = got.capped;
      if (held) this.links.replace(mergeFresh(held.posts, got.posts, READER_KEEP));
    } else this.failure = got.message;
    this.links.redraw();
  }
}
