// Opening a post from a blyg address that came from outside (HK6): a note the share sheet made, or the clipboard. One function for both doors:
// the address in the text (studio/sharedAddress.ts) → the Studio's own lookup (studio/lookup.ts; the plugin asks no other site) → the post shown in the reader.
// Opens only. Reply and Follow stay the reader's own buttons. Fails closed: no address, several addresses, or a Studio that cannot place it is a
// message, and nothing is opened, followed or written. The text it was given is read and never kept.
import type { StudioAddress } from "../studio/address";
import type { StudioClient } from "../studio/client";
import { lookupAddress } from "../studio/lookup";
import type { StudioPick } from "../studio/picker";
import type { ReadingPost } from "../studio/reading";
import { extractSharedAddress } from "../studio/sharedAddress";
import type { StudioPeek } from "../studio/types";
import { hostOf } from "./followFlow";

export const shareText = {
  none: "No blyg address found in that text.",
  several: (n: number) => `Found ${n} different addresses, so nothing was opened. Copy just the address of the post.`,
  ownNoNote: "That is one of your own posts, but no note in this vault holds it.",
  cannotRead: "Your Studio could not read that post.",
  unreachable: "The Studio could not be reached.",
  clipboardEmpty: "The clipboard has no text.",
  clipboardDenied: "Obsidian could not read the clipboard.",
} as const;

export type ShareOpenResult = { kind: "opened" } | { kind: "refused"; message: string };

export interface ShareOpenDeps {
  client: StudioClient;
  address: StudioAddress;
  /** Show this post in the reader. */
  showPost(post: ReadingPost): Promise<void>;
  /** Open the note of one of the owner's own items; false when no note holds it. */
  openOwn(itemId: string): Promise<boolean>;
}

/** A post as the reader shows it, from what the Studio's peek returned (the held copy when the Studio reads that blyg). */
export function postFromPeekItem(peek: StudioPeek, blygTitle: string, now: number): ReadingPost {
  return {
    subscriptionId: peek.subscriptionId ?? "",
    subscriptionTitle: blygTitle,
    origin: peek.origin,
    remoteId: peek.id,
    kind: peek.kind === "thread" ? "thread" : "fragment",
    withdrawn: peek.kind === "withdrawn",
    version: peek.version,
    readVersion: null,
    observedAt: new Date(now).toISOString(),
    created: null,
    isReply: false,
    contentHtml: peek.kind === "withdrawn" ? "" : peek.contentHtml,
    contentMd: "",
    authorName: null,
    authorUrl: null,
    sourceUrl: peek.url || null,
  };
}

const isOwn = (pick: StudioPick): boolean => pick.subscriptionId === null && (pick.origin === null || pick.origin === undefined);

export async function openSharedText(text: string, deps: ShareOpenDeps, now: () => number = Date.now): Promise<ShareOpenResult> {
  const found = extractSharedAddress(text);
  if (found.kind === "none") return { kind: "refused", message: shareText.none };
  if (found.kind === "ambiguous") return { kind: "refused", message: shareText.several(found.count) };
  try {
    const looked = await lookupAddress(deps.client, deps.address, found.url);
    if (looked.kind === "not-an-address") return { kind: "refused", message: shareText.none };
    if (looked.kind === "problem") return { kind: "refused", message: looked.message };
    const pick = looked.pick;
    if (isOwn(pick)) return (await deps.openOwn(pick.id)) ? { kind: "opened" } : { kind: "refused", message: shareText.ownNoNote };
    const peek = await deps.client.peekItem(pick.origin ?? "", pick.id);
    if (peek.kind !== "ok") return { kind: "refused", message: shareText.cannotRead };
    let title = "";
    if (peek.value.subscriptionId !== null) {
      const sub = await deps.client.getSubscription(peek.value.subscriptionId);
      title = sub.kind === "ok" ? sub.value.title : "";
    }
    await deps.showPost(postFromPeekItem(peek.value, title || hostOf(peek.value.origin), now()));
    return { kind: "opened" };
  } catch {
    return { kind: "refused", message: shareText.unreachable };
  }
}

/** Is this path a file directly inside, or below, the share inbox folder? An empty folder setting means off. */
export function inShareInbox(path: string, folder: string): boolean {
  const dir = folder.trim().replace(/^\/+|\/+$/g, "");
  return dir !== "" && path.startsWith(`${dir}/`) && path.toLowerCase().endsWith(".md");
}
