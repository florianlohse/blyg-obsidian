// Clusters of posts that are about the same thing, with no model: (a) replies join the post they answer, (b) posts that quote the same item join,
// (c) a post left alone joins the post it resembles most (tf-idf cosine) when it resembles it strongly. Pure and deterministic.
//
// (a) and (b) are one rule: every post is linked to the item ids it touches (its own, the one it answers, the ones it quotes) and posts that touch
// the same item are one cluster, even when the item itself is not in the window.
import { graphemePrefix } from "../core/textContent";
import { termCounts, tokenize } from "../core/terms";
import type { ReadingPost } from "../studio/reading";
import { ownWords, quotedIdsOf } from "./quotes";

/** How alike two posts must be to be joined by (c). Cautious on purpose: a missed join leaves a post alone, a wrong join puts strangers together. Not tuned on real data yet. */
export const SIMILARITY_THRESHOLD = 0.4;
/** A post needs this many distinct terms, and the pair this many in common, to be joined by (c). */
export const MIN_TERMS = 5;
export const MIN_SHARED_TERMS = 3;
const HEADLINE_MAX = 110;

export interface Cluster {
  /** The post the others answer or quote when it is in the list, else the oldest; then the rest, oldest first. */
  posts: ReadingPost[];
  newest: number;
  headline: string;
  /** The words that say most about the cluster, most telling first. */
  terms: string[];
}

export const postTime = (p: ReadingPost): number => Date.parse(p.observedAt) || Date.parse(p.created ?? "") || 0;

class Sets {
  private readonly parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r] ?? r;
    while (this.parent[i] !== r) {
      const next = this.parent[i] ?? r;
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const x = this.find(a);
    const y = this.find(b);
    // The lower index is the root, so a cluster's name does not depend on the order of the unions.
    if (x < y) this.parent[y] = x;
    else if (y < x) this.parent[x] = y;
  }
}

/** The first sentence of a text as a headline, cut at a word at most HEADLINE_MAX long. Empty text gives "". */
export function firstSentence(text: string): string {
  const t = text.trim();
  if (t === "") return "";
  const parts = (t.match(/[^.!?…]+[.!?…]+(?=\s|$)|[^.!?…]+$/g) ?? [t]).map((x) => x.trim()).filter(Boolean); // (no lookbehind: not on iOS before 16.4)
  let s = parts[0] ?? "";
  if (s.length < 12 && parts.length > 1) s = `${s} ${parts[1] ?? ""}`.trim(); // "Yes. Here is why." is not a headline
  if (s.length <= HEADLINE_MAX) return s;
  const cut = graphemePrefix(s, HEADLINE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > HEADLINE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

interface Doc {
  post: ReadingPost;
  time: number;
  text: string;
  counts: Map<string, number>;
  weights: Map<string, number>;
  norm: number;
}

/** Group posts. `posts` should be the window's posts: not withdrawn, not the owner's own. */
export function clusterPosts(posts: readonly ReadingPost[], similarity = SIMILARITY_THRESHOLD): Cluster[] {
  const docs: Doc[] = posts.map((post) => {
    const text = ownWords(post);
    return { post, time: postTime(post), text, counts: termCounts(tokenize(text)), weights: new Map(), norm: 0 };
  });
  const sets = new Sets();
  for (let i = 0; i < docs.length; i++) sets.add();
  const itemNode = new Map<string, number>();
  const nodeOf = (id: string): number => {
    let n = itemNode.get(id);
    if (n === undefined) {
      n = sets.add();
      itemNode.set(id, n);
    }
    return n;
  };
  // (a) + (b): the item a post is, the item it answers, the items it quotes.
  docs.forEach((d, i) => {
    sets.union(i, nodeOf(d.post.remoteId));
    if (d.post.stubTarget) sets.union(i, nodeOf(d.post.stubTarget.id));
    for (const id of quotedIdsOf(d.post)) sets.union(i, nodeOf(id));
  });

  // (c): posts still alone, by tf-idf cosine against every other post.
  const size = new Map<number, number>();
  docs.forEach((_, i) => size.set(sets.find(i), (size.get(sets.find(i)) ?? 0) + 1));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  for (const d of docs) {
    let sq = 0;
    for (const [t, c] of d.counts) {
      const w = (1 + Math.log(c)) * Math.log(1 + docs.length / (df.get(t) ?? 1));
      d.weights.set(t, w);
      sq += w * w;
    }
    d.norm = Math.sqrt(sq);
  }
  const alone = docs.map((_, i) => size.get(sets.find(i)) === 1);
  const joins: Array<[number, number]> = [];
  docs.forEach((a, i) => {
    if (!alone[i] || a.counts.size < MIN_TERMS || a.norm === 0) return;
    let best = -1;
    let bestScore = 0;
    docs.forEach((b, j) => {
      if (i === j || b.counts.size < MIN_TERMS || b.norm === 0) return;
      let dot = 0;
      let shared = 0;
      for (const [t, w] of a.weights) {
        const v = b.weights.get(t);
        if (v !== undefined) {
          dot += w * v;
          shared++;
        }
      }
      if (shared < MIN_SHARED_TERMS) return;
      const score = dot / (a.norm * b.norm);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    });
    if (best >= 0 && bestScore >= similarity) joins.push([i, best]);
  });
  for (const [i, j] of joins) sets.union(i, j);

  const groups = new Map<number, number[]>();
  docs.forEach((_, i) => {
    const r = sets.find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });

  const clusters = [...groups.values()].flatMap((members): Cluster[] => {
    const ds = members.map((i) => docs[i] as Doc);
    const targeted = new Set<string>();
    for (const d of ds) {
      if (d.post.stubTarget) targeted.add(d.post.stubTarget.id);
      for (const id of quotedIdsOf(d.post)) targeted.add(id);
    }
    const byTime = [...ds].sort((a, b) => a.time - b.time || (a.post.remoteId < b.post.remoteId ? -1 : 1));
    const lead = byTime.find((d) => targeted.has(d.post.remoteId)) ?? byTime[0];
    if (!lead) return [];
    const ordered = [lead, ...byTime.filter((d) => d !== lead)];
    const score = new Map<string, number>();
    for (const d of ds) for (const [t, w] of d.weights) score.set(t, (score.get(t) ?? 0) + w);
    const terms = [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([t]) => t);
    return [
      {
        posts: ordered.map((d) => d.post),
        newest: Math.max(...ds.map((d) => d.time)),
        headline: firstSentence(lead.text) || terms.join(" · ") || "(no text)",
        terms,
      },
    ];
  });
  return clusters.sort((a, b) => b.posts.length - a.posts.length || b.newest - a.newest || (a.headline < b.headline ? -1 : a.headline > b.headline ? 1 : 0));
}
