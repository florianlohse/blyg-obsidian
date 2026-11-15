// S15: the replies to a post that the reader can SEE, and nothing more. The protocol keeps "who has responded to an item you did not publish" off the wire
// on purpose (spec 0.4 §13, "forward discovery"; mentions are signals of the target's own Studio, a public responses list is presentation readers must not
// parse), so this never asks the blyg and never counts strangers. It joins two things the owner already holds:
//   - the owner's own replies (their items whose `stub_of` names this post): "you replied";
//   - posts of blygs the Studio reads that answer this post (`stubOf` of a reading-list row): "replies in blygs you read".
// Both are private to the owner and say nothing about completeness. Pure.
import { sameOrigin } from "../studio/record";
import type { ReadingPost } from "../studio/reading";
import { isBlygStub } from "../studio/stub";
import type { StudioListedItem } from "../studio/types";

export type ResponseEntry =
  | { kind: "mine"; itemId: string; text: string; when: string; draft: boolean }
  | { kind: "read"; post: ReadingPost; when: string };

const sameTarget = (t: { origin: string; id: string } | null | undefined, post: ReadingPost): boolean => !!t && !!post.origin && t.id === post.remoteId && sameOrigin(t.origin, post.origin);

/** The replies to `post` the reader can see, newest first. */
export function responsesTo(post: ReadingPost, mine: StudioListedItem[], read: ReadingPost[]): ResponseEntry[] {
  const out: ResponseEntry[] = [];
  for (const item of mine) {
    const t = item.stubOf;
    if (t && isBlygStub(t) && sameTarget(t, post)) out.push({ kind: "mine", itemId: item.id, text: item.published?.contentMd || item.contentMd, when: item.created ?? item.updated ?? "", draft: item.status === "draft" });
  }
  for (const q of read) {
    if (q.subscriptionId === post.subscriptionId && q.remoteId === post.remoteId) continue;
    if (q.withdrawn) continue;
    if (sameTarget(q.stubTarget, post)) out.push({ kind: "read", post: q, when: q.created ?? q.observedAt });
  }
  return out.sort((a, b) => (Date.parse(b.when) || 0) - (Date.parse(a.when) || 0));
}

/** The words on the chip that opens the list (an icon goes before them, drawn by the reader), and what it says when held: green when the owner replied. */
export function responseChip(entries: ResponseEntry[]): { text: string; title: string; mine: boolean } | null {
  if (entries.length === 0) return null;
  const mine = entries.filter((e) => e.kind === "mine").length;
  const others = entries.length - mine;
  if (mine > 0) {
    return { text: others > 0 ? `You + ${others}` : mine > 1 ? `You replied ×${mine}` : "You replied", title: others > 0 ? `You replied, and ${others} more ${others === 1 ? "reply" : "replies"} in blygs you read` : mine > 1 ? `You replied ${mine} times` : "You replied to this post", mine: true };
  }
  return { text: `${others} ${others === 1 ? "reply" : "replies"}`, title: `${others} ${others === 1 ? "reply" : "replies"} in blygs you read`, mine: false };
}
