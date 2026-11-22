// The Daily as data: what the reader's saved list says about the window. No model, no network, no storage. Pure and deterministic.
//   Front page: the clusters. Letters: others' words about the owner's own items (mentions). Corrections: posts revised after the first version.
//   Retractions: posts withdrawn. (From your notes: a later increment.)
// The reader's data carries no change note for a revised version (checked 2026-11: `ReadingPost` has only `version` and `readVersion`; the Studio's
// change notes are not on the reading rows), so a correction says "revised to vN" and, when the owner had read an older version, which one.
import { relationWords, type InboundMention, type ReadingPost } from "../studio/reading";
import { clusterPosts, firstSentence, postTime, type Cluster } from "./cluster";
import { ownWords } from "./quotes";

/** How many clusters the front page shows; the rest are counted, not listed. */
export const FRONT_PAGE_MAX = 15;

export interface Letter {
  mention: InboundMention;
  /** The mentioning post, when the reader holds it. */
  post: ReadingPost | null;
  who: string;
  words: string;
  /** The first sentence of the mentioning post, or "". */
  headline: string;
  when: number;
}

export interface Correction {
  post: ReadingPost;
  headline: string;
  note: string;
  when: number;
}

export interface Retraction {
  post: ReadingPost;
  headline: string;
  when: number;
}

export interface DailyModel {
  since: number;
  until: number;
  /** Posts of blygs read that fall in the window (the owner's own and withdrawn ones are not counted). */
  postCount: number;
  front: Cluster[];
  /** Clusters beyond FRONT_PAGE_MAX. */
  moreClusters: number;
  /** Those clusters themselves: the page lists their posts under "Other posts". */
  rest: Cluster[];
  letters: Letter[];
  corrections: Correction[];
  retractions: Retraction[];
}

const inWindow = (t: number, since: number, until: number): boolean => t >= since && t <= until;

export function buildDaily(posts: readonly ReadingPost[], mentions: readonly InboundMention[], since: number, until: number): DailyModel {
  const read = posts.filter((p) => !p.own && p.subscriptionId !== "");
  const fresh = read.filter((p) => inWindow(postTime(p), since, until));
  const live = fresh.filter((p) => !p.withdrawn);
  const clusters = clusterPosts(live);

  const held = new Map<string, ReadingPost>();
  for (const p of read) held.set(p.remoteId, p);
  const letters: Letter[] = mentions
    .filter((m) => !m.hidden && (m.status === "verified" || m.status === "pending") && inWindow(Date.parse(m.firstSeen) || 0, since, until))
    .map((m): Letter => {
      const post = m.sourceId ? (held.get(m.sourceId) ?? null) : null;
      return {
        mention: m,
        post,
        who: m.sourceAuthorName ?? post?.authorName ?? post?.subscriptionTitle ?? "Someone",
        words: relationWords(m.relation),
        headline: post ? firstSentence(ownWords(post)) : "",
        when: Date.parse(m.firstSeen) || 0,
      };
    })
    .sort((a, b) => b.when - a.when || (a.mention.id < b.mention.id ? -1 : 1));

  const corrections = live
    .filter((p) => p.version > 1)
    .map((p): Correction => ({
      post: p,
      headline: firstSentence(ownWords(p)) || "(no text)",
      note: p.readVersion !== null && p.readVersion < p.version ? `revised to v${p.version} (you read v${p.readVersion})` : `revised to v${p.version}`,
      when: postTime(p),
    }))
    .sort((a, b) => b.when - a.when || (a.post.remoteId < b.post.remoteId ? -1 : 1));

  const retractions = fresh
    .filter((p) => p.withdrawn)
    .map((p): Retraction => ({ post: p, headline: firstSentence(ownWords(p)) || "(withdrawn)", when: postTime(p) }))
    .sort((a, b) => b.when - a.when || (a.post.remoteId < b.post.remoteId ? -1 : 1));

  return {
    since,
    until,
    postCount: live.length,
    front: clusters.slice(0, FRONT_PAGE_MAX),
    moreClusters: Math.max(0, clusters.length - FRONT_PAGE_MAX),
    rest: clusters.slice(FRONT_PAGE_MAX),
    letters,
    corrections,
    retractions,
  };
}
