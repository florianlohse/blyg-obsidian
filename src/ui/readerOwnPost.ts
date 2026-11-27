// A quote of one of the owner's OWN items inside another person's post opens that item in the reader, as the owner's own post (the same shape the Studio's merged list gives,
// so the detail view shows its "Open note" button). Built from the item the Studio returns for an id; null when the item has nothing to show. Pure.
import type { ReadingPost } from "../studio/reading";
import type { StudioItem } from "../studio/types";

const escapeText = (md: string): string => md.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

/** The text of the source line under a quote of your own item. */
export function ownSourceText(label: string): string {
  return label ? `You, in your own item · ${label}` : "You, in your own item";
}

/** One of the owner's items as a post of the reader: the published text when there is one, else the working copy as plain paragraphs. */
export function ownPostOfItem(item: StudioItem): ReadingPost | null {
  const html = item.published?.contentHtml?.trim() ? item.published.contentHtml : escapeText(item.contentMd.trim()).split(/\n{2,}/).filter((s) => s.trim() !== "").map((s) => `<p>${s}</p>`).join("");
  if (html === "") return null;
  const when = item.updated ?? item.created ?? "";
  return {
    subscriptionId: "",
    subscriptionTitle: "Your blyg",
    origin: null,
    remoteId: item.id,
    kind: item.kind === "thread" ? "thread" : "fragment",
    withdrawn: item.status === "withdrawn",
    version: Math.max(1, item.version),
    readVersion: Math.max(1, item.version),
    observedAt: when,
    created: item.updated ?? item.created ?? (when || null),
    isReply: false,
    contentHtml: html,
    contentMd: "",
    authorName: null,
    authorUrl: null,
    sourceUrl: null,
    own: true,
  };
}
