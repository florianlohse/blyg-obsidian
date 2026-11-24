// Stable stories within an edition. The first time an edition is read, the posts are grouped by the ordinary rules (cluster.ts). Afterwards a NEW post joins the
// existing story it matches by the same rules (it answers or quotes an item the story's posts touch, or resembles one of its posts by the tf-idf rule), else it
// goes to the Mixed bag; a new post never starts a story by itself, two new posts that match each other (and no story) may. Stories keep their id and order.
// Pure; the record it returns holds ids only.
import type { ReadingPost } from "../studio/reading";
import { clusterPosts, docSimilarity, finishCluster, postTime, prepareDocs, SIMILARITY_THRESHOLD, type Cluster } from "./cluster";
import { quotedIdsOf } from "./quotes";
import type { EditionRec, StoryRec } from "./edition";
import { bySize, byNewestPost } from "./order";
import { storyIdFor } from "./sync/state";

const touched = (p: ReadingPost): string[] => [p.remoteId, ...(p.stubTarget ? [p.stubTarget.id] : []), ...quotedIdsOf(p)];

export interface Grouped {
  /** The stories (two or more posts present) in the order of the record. */
  clusters: Cluster[];
  /** The posts in no story, newest first. */
  mixed: ReadingPost[];
}

/** Put the posts the record does not know yet into it. `posts`: the edition's live posts (in the window, not withdrawn, not the owner's own). Returns a new record. */
export function assignPosts(rec: EditionRec, posts: readonly ReadingPost[], now: number): EditionRec {
  const known = new Set<string>([...rec.stories.flatMap((s) => s.posts), ...rec.mixed]);
  const fresh = posts.filter((p) => !known.has(p.remoteId)).sort((a, b) => postTime(a) - postTime(b) || (a.remoteId < b.remoteId ? -1 : 1));
  if (fresh.length === 0) return rec;
  const out: EditionRec = { ...rec, stories: rec.stories.map((s) => ({ ...s, posts: [...s.posts] })), mixed: [...rec.mixed], seen: { ...rec.seen } };
  for (const p of fresh) out.seen[p.remoteId] = now;

  const docs = new Map(prepareDocs(posts).map((d) => [d.post.remoteId, d]));
  const byId = new Map(posts.map((p) => [p.remoteId, p]));
  const touch = new Map<string, Set<string>>(out.stories.map((s) => [s.id, new Set(s.posts.flatMap((id) => (byId.get(id) ? touched(byId.get(id) as ReadingPost) : [id])))]));
  const leftOver: ReadingPost[] = [];
  for (const p of fresh) {
    const mine = touched(p);
    let into: StoryRec | undefined = out.stories.find((s) => mine.some((id) => touch.get(s.id)?.has(id)));
    if (!into) {
      const d = docs.get(p.remoteId);
      let best = 0;
      for (const s of out.stories) {
        for (const id of s.posts) {
          const o = docs.get(id);
          const score = d && o ? docSimilarity(d, o) : 0;
          if (score >= SIMILARITY_THRESHOLD && score > best) {
            best = score;
            into = s;
          }
        }
      }
    }
    if (into) {
      into.posts.push(p.remoteId);
      for (const id of mine) touch.get(into.id)?.add(id);
    } else leftOver.push(p);
  }
  // Left over: two or more that match each other form a story; the rest go to the Mixed bag. (With no story yet, this is the ordinary grouping.)
  for (const c of clusterPosts(leftOver)) {
    // The id comes from the story's OLDEST post, not from a counter: devices that group the same posts name the story alike (src/digest/sync).
    if (c.posts.length >= 2) {
      const oldest = [...c.posts].sort((a, b) => postTime(a) - postTime(b) || (a.remoteId < b.remoteId ? -1 : 1))[0] as ReadingPost;
      out.stories.push({ id: storyIdFor(oldest.remoteId), posts: c.posts.map((p) => p.remoteId) });
      out.n++;
    }
    else out.mixed.push(...c.posts.map((p) => p.remoteId));
  }
  return out;
}

/** The record's stories and Mixed bag as clusters and posts, for the posts present now (a withdrawn post is gone; a story left with one post is Mixed bag). */
export function groupOf(rec: EditionRec, posts: readonly ReadingPost[]): Grouped {
  const docs = new Map(prepareDocs(posts).map((d) => [d.post.remoteId, d]));
  const inStory = new Set<string>();
  const clusters: Cluster[] = [];
  for (const s of rec.stories) {
    const ds = s.posts.flatMap((id) => docs.get(id) ?? []);
    if (ds.length < 2) continue;
    const c = finishCluster(ds);
    if (!c) continue;
    for (const p of c.posts) inStory.add(p.remoteId);
    clusters.push({ ...c, id: s.id });
  }
  // The page's order, not the record's (the record keeps the order stories were made in, so a story that grew or got a newer post stayed where it was): see order.ts.
  const mixed = posts.filter((p) => !inStory.has(p.remoteId)).sort(byNewestPost);
  return { clusters: clusters.sort(bySize), mixed };
}
