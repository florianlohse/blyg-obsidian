// S15: the text of the item a reply (or a quote) points at, for a view-only preview in the note. Nothing here is written anywhere: the caller draws it and
// forgets it (strangers' text does not enter the vault, decision of 2026-10-06). Asks the owner's Studio only.
import type { StudioClient } from "./client";
import type { ReadingPost } from "./reading";

export interface PreviewItem {
  /** Whose it is, in words: "Your item", or the blyg's title / host. */
  who: string;
  /** The item's HTML as the Studio holds it (foreign: the caller must draw it through the reader's filter), or the owner's own text as plain paragraphs. */
  html: string;
  own: boolean;
  draft: boolean;
  withdrawn: boolean;
}

export type PreviewResult = { kind: "ready"; item: PreviewItem } | { kind: "missing" } | { kind: "unavailable"; message: string };

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The owner's own Markdown as plain paragraphs (no Markdown is rendered: it is a preview of the words). */
export function paragraphsOf(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b !== "")
    .map((b) => `<p>${esc(b).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The preview of a post the reader already holds (no request needed): the same words the Studio would answer with. */
export function previewOfPost(post: ReadingPost): PreviewItem {
  return { who: post.subscriptionTitle, html: post.withdrawn ? "" : post.contentHtml, own: false, draft: false, withdrawn: post.withdrawn };
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Find an item by its id: one of the owner's own, else one held from a blyg the Studio reads (found by the Studio's search, an exact id), else, when the
 * note says which blyg it answers (`hintOrigin`), a look at that blyg by address. `missing`: none of them knows it.
 */
export async function resolvePreview(client: StudioClient, id: string, hintOrigin: string | null): Promise<PreviewResult> {
  // Two questions at once: it is one of the owner's own, or held from a blyg the Studio reads. Asked one after the other, an item of someone else waited
  // for the answer "not mine" before the second question even started.
  const [own, found] = await Promise.all([client.getItem(id), client.search({ q: id, source: "imported", limit: 25 })]);
  if (own.kind === "ok") {
    const item = own.value;
    const html = item.published?.contentHtml || paragraphsOf(item.contentMd);
    return { kind: "ready", item: { who: item.status === "draft" || item.version === 0 ? "Your item (a draft)" : "Your item", html, own: true, draft: item.status === "draft" || item.version === 0, withdrawn: item.status === "withdrawn" } };
  }
  if (own.kind !== "not-found") return { kind: "unavailable", message: "The Studio could not be asked." };
  if (found.kind === "ok") {
    const hit = found.value.items.find((h) => h.id === id && h.subscriptionId !== null);
    if (hit && hit.subscriptionId !== null) {
      const got = await client.getImported(hit.subscriptionId, id);
      if (got.kind === "ok") return { kind: "ready", item: { who: hit.sourceTitle ?? "", html: got.value.state === "tombstone" ? "" : got.value.contentHtml, own: false, draft: false, withdrawn: got.value.state === "tombstone" } };
      if (got.kind !== "not-found") return { kind: "unavailable", message: "The Studio could not be asked." };
    }
  } else {
    return { kind: "unavailable", message: "The Studio could not be asked." };
  }
  if (hintOrigin) {
    const peek = await client.peekItem(hintOrigin, id);
    if (peek.kind === "ok") return { kind: "ready", item: { who: hostOf(peek.value.origin), html: peek.value.kind === "withdrawn" ? "" : peek.value.contentHtml, own: false, draft: false, withdrawn: peek.value.kind === "withdrawn" } };
    if (peek.kind !== "not-found") return { kind: "unavailable", message: "The blyg could not be reached through your Studio." };
  }
  return { kind: "missing" };
}
