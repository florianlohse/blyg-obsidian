// The Daily as data: what the reader's saved list says about the window. No model, no network, no storage. Pure and deterministic.
//   Front page: the stories (clusters of two or more posts). Mixed bag: the posts that did not fit a story. Letters: others' words about the owner's own items (mentions). Corrections: posts revised after the first version.
//   Retractions: posts withdrawn. (From your notes: a later increment.)
// The reader's data carries no change note for a revised version (checked 2026-11: `ReadingPost` has only `version` and `readVersion`; the Studio's
// change notes are not on the reading rows), so a correction says "revised to vN" and, when the owner had read an older version, which one.
import { relationWords, type InboundMention, type ReadingPost } from "../studio/reading";
import { clusterPosts, firstSentence, postTime, type Cluster } from "./cluster";
import { ownWords } from "./quotes";
import type { Grouped } from "./stable";

/** How many stories the front page shows; the rest are counted, not listed. */
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
  /** The edition's id (its cutoff), when the page is an edition: the masthead's day. */
  edition?: number;
  since: number;
  until: number;
  /** Posts of blygs read that fall in the window (the owner's own and withdrawn ones are not counted). */
  postCount: number;
  /** Stories (two or more posts) on the front page: the only ones the AI layer is asked about. */
  front: Cluster[];
  /** Stories beyond FRONT_PAGE_MAX. */
  moreClusters: number;
  /** Those stories themselves: the page lists their posts under "Other posts". */
  rest: Cluster[];
  /** The posts that did not fit a story, newest story first. No AI request is made for them. */
  mixed: ReadingPost[];
  letters: Letter[];
  corrections: Correction[];
  retractions: Retraction[];
}

const inWindow = (t: number, since: number, until: number): boolean => t >= since && t <= until;

/** The posts of blygs read that fall in the window and are not withdrawn: what a Daily is made of. */
export const livePosts = (posts: readonly ReadingPost[], since: number, until: number): ReadingPost[] =>
  posts.filter((p) => !p.own && p.subscriptionId !== "" && !p.withdrawn && inWindow(postTime(p), since, until));

/** `grouped`: the stories and Mixed bag an edition has already settled (src/digest/stable.ts); absent: group the window's posts afresh. */
export function buildDaily(posts: readonly ReadingPost[], mentions: readonly InboundMention[], since: number, until: number, grouped?: Grouped, edition?: number): DailyModel {
  const read = posts.filter((p) => !p.own && p.subscriptionId !== "");
  const fresh = read.filter((p) => inWindow(postTime(p), since, until));
  const live = fresh.filter((p) => !p.withdrawn);
  const all = grouped ? [] : clusterPosts(live);
  const clusters = grouped ? grouped.clusters : all.filter((c) => c.posts.length >= 2);
  const mixed = grouped ? grouped.mixed : all.filter((c) => c.posts.length < 2).flatMap((c) => c.posts);

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
    ...(edition !== undefined ? { edition } : {}),
    since,
    until,
    postCount: live.length,
    front: clusters.slice(0, FRONT_PAGE_MAX),
    moreClusters: Math.max(0, clusters.length - FRONT_PAGE_MAX),
    rest: clusters.slice(FRONT_PAGE_MAX),
    mixed,
    letters,
    corrections,
    retractions,
  };
}
