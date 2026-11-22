// "Reply" in the reader: what to reply to, and whether a quote can come with it. A post the Studio holds (a blyg you follow) can be quoted; a post of a
// blyg the Studio does not read (a mention's post, one opened by its address) can only be answered with a link, never quoted: quoting follows reading
// (spec §10.2). The reader never sends a selected passage for such a post; the reply is the stub alone, as "Reply to an item" does for an unfollowed blyg.
import type { StudioPick } from "../studio/picker";
import type { ReadingPost } from "../studio/reading";
import { cleanLabel } from "../studio/text";
import { isUnfollowedPost } from "../ui/readerFollow";
import { hostOf } from "./followFlow";

export function replyPlan(post: ReadingPost, selection: string | undefined, excerpt: string): { pick: StudioPick; selection: string | undefined } {
  const base = { source: "studio" as const, id: post.remoteId, kind: post.kind, title: excerpt, origin: post.origin, version: post.version };
  if (!isUnfollowedPost(post)) return { pick: { ...base, detail: post.subscriptionTitle, subscriptionId: post.subscriptionId, label: post.subscriptionTitle, quotable: true }, selection };
  const blyg = post.subscriptionTitle || hostOf(post.origin ?? "");
  return { pick: { ...base, detail: `${blyg} · you do not follow this blyg`, subscriptionId: null, label: cleanLabel(`${blyg}: ${excerpt}`), quotable: false }, selection: undefined };
}
