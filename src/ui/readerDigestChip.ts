// The reader's small "In the digest: <section>" chip on an open post, when a digest edition the plugin holds (the current one or the history) put the post in a
// section. A tap opens that edition scrolled to the section. Kept out of ReaderView.ts (its size is capped). Text only.
import type { ReadingPost } from "../studio/reading";

export interface DigestChipSource {
  /** The section a post is in, in the digest editions held (src/digest/postSection.ts), or null. */
  sectionOf(post: ReadingPost): Promise<{ edition: number; section: string } | null>;
  /** Open that edition in the digest, scrolled to the section. */
  open(edition: number, section: string): void;
}

let source: DigestChipSource | null = null;
/** The Daily registers itself only when its feature is on (features/registry.ts); the chip exists only then. (Module state, like the Feed / Digest switch: a reload of the plugin starts it off again.) */
export function setDigestChips(s: DigestChipSource | null): void {
  source = s;
}

/** Add the chip to `line` (after what is already there) when the post has a section. Asked after the header is drawn; nothing is added if the header has gone by then. */
export function drawDigestChip(line: HTMLElement, post: ReadingPost): void {
  const src = source;
  if (!src) return;
  void src
    .sectionOf(post)
    .then((where) => {
      if (!where || !line.isConnected) return;
      line.createSpan({ cls: "blyg-reader-postsep", text: "·" });
      const a = line.createEl("a", { cls: "blyg-reader-link blyg-reader-digestchip", text: `In the digest: ${where.section}`, attr: { href: "#", role: "button", title: "Open this edition of the digest at that section" } });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        src.open(where.edition, where.section);
      });
    })
    .catch(() => undefined);
}
