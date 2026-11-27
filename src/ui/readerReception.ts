// Reception at the foot of one of your own posts in the reader (feature `marginalia`): who quoted or answered it, when, and a short excerpt. Nothing is asked
// for here that the reader does not hold already: the mentions come with the list, the mentioning post from the list or from the Mentions tab's own lookup
// (ui/ReaderView.ts `loadMention`: a few at a time, once). Read-only; every word of a stranger goes in as text.
import type { InboundMention, ReadingPost } from "../studio/reading";
import { plainText } from "./defang";
import { relativeTime } from "./readerFeed";
import { hostOf, mentionBadge, visibleMentions } from "./readerMentions";

/** How many rows the section lists; the rest is counted and left to the Mentions tab. */
export const RECEPTION_ROWS = 5;

/** The visible mentions of this item (not hidden, not failed or gone), newest first. */
export function receptionOf(item: ReadingPost, mentions: InboundMention[]): InboundMention[] {
  return item.own === true ? visibleMentions(mentions).filter((m) => m.targetItemId === item.remoteId) : [];
}

export const receptionTitle = (n: number): string => `Reception (${n})`;

const excerpt = (html: string, max = 140): string => {
  const t = plainText(html);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export interface ReceptionDeps {
  mentions: InboundMention[];
  /** The mentioning post when it is known now (null: not yet, or it cannot be had). */
  post(m: InboundMention): ReadingPost | null;
  /** Make it known (the reader's lookup); the row redraws when it has answered. */
  load(m: InboundMention): Promise<void>;
  open(m: InboundMention): void;
}

/** Draw the section into `col`; nothing at all when nobody has quoted or answered the post. Returns the section, or null. */
export function drawOwnReception(col: HTMLElement, item: ReadingPost, d: ReceptionDeps): HTMLElement | null {
  const all = receptionOf(item, d.mentions);
  if (all.length === 0) return null;
  const box = col.createDiv({ cls: "blyg-reader-responses blyg-reader-reception", attr: { role: "region", "aria-label": "Reception" } });
  box.createDiv({ cls: "blyg-reader-responses-title", text: receptionTitle(all.length) });
  for (const m of all.slice(0, RECEPTION_ROWS)) {
    const row = box.createDiv({ cls: "blyg-reader-row blyg-reader-card blyg-reader-response", attr: { role: "button", tabindex: "0" } });
    const fill = (): void => {
      row.empty();
      const meta = row.createDiv({ cls: "blyg-reader-meta" });
      const who = d.post(m)?.authorName ?? m.sourceAuthorName ?? hostOf(m.sourceOrigin) ?? "Someone";
      const when = relativeTime(m.firstSeen, Date.now());
      meta.createSpan({ cls: "blyg-reader-source", text: who });
      meta.appendText(` · ${mentionBadge(m.relation)}${when ? ` · ${when}` : ""}`);
      const post = d.post(m);
      if (post && !post.withdrawn) {
        const text = excerpt(post.contentHtml);
        if (text !== "") row.createDiv({ cls: "blyg-reader-excerpt", text });
      }
    };
    fill();
    void d.load(m).then(fill);
    const open = (): void => d.open(m);
    row.addEventListener("click", () => (activeWindow.getSelection()?.toString() ?? "") === "" && open());
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open();
    });
  }
  if (all.length > RECEPTION_ROWS) box.createDiv({ cls: "blyg-reader-meta blyg-reader-responses-note", text: `${all.length - RECEPTION_ROWS} more in Mentions.` });
  return box;
}
