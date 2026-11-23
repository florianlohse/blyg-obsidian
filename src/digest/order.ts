// The order of the digest page, in one place. The rule (also said in the page's "How this is grouped" note):
//   - Front page lead and the plain front page: the biggest stories first (most posts), then the one with the newest post, then by id.
//   - Within a section: stories by the time of their NEWEST post, newest first; single posts newest first.
//   - Read posts sink: inside a section a story or post you have already read comes after the unread ones (the relative order is kept otherwise).
//   - Window: a post belongs to an edition by `postTime` (when the Studio first saw it), not by its published date, so a post imported late can show an older date.
//   - Sections: the section holding the newest item first; "Other" always last.
// "Newest" is a post's own time (`postTime`: when the Studio first saw it, else its date). Sorting is on numbers, never on text, except as the last tie-break.
// Pure; the record's own order (the order stories were made in) is never the page's order.
import type { ReadingPost } from "../studio/reading";
import { postTime, type Cluster } from "./cluster";
import { isUnread } from "../studio/reading";
import { OTHER_NAME, type Section } from "./sections";

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Biggest story first, then the newest post, then the id. */
export const bySize = (a: Cluster, b: Cluster): number => b.posts.length - a.posts.length || b.newest - a.newest || text(a.id ?? a.headline, b.id ?? b.headline);
/** Newest post first (a story by its newest post). */
export const byNewestStory = (a: Cluster, b: Cluster): number => b.newest - a.newest || text(a.id ?? a.headline, b.id ?? b.headline);
export const byNewestPost = (a: ReadingPost, b: ReadingPost): number => postTime(b) - postTime(a) || text(a.remoteId, b.remoteId);

/** A section as it is drawn: the stories (positions in `front`) and single posts it holds, in page order. */
export interface Drawn {
  name: string;
  about?: string;
  stories: number[];
  singles: ReadingPost[];
  /** The newest time of anything in it. */
  newest: number;
}

/** The sections in page order, each with its stories and single posts in page order. `skip`: story positions drawn elsewhere (the lead block). Empty sections are left out. */
export function drawnSections(sections: readonly Section[], front: readonly Cluster[], singles: ReadonlyMap<string, ReadingPost>, skip: (i: number) => boolean = () => false): Drawn[] {
  const out: Drawn[] = [];
  for (const s of sections) {
    const unreadStory = (i: number): number => ((front[i] as Cluster).posts.some(isUnread) ? 0 : 1);
    const stories = s.ids.filter((i) => !skip(i) && front[i] !== undefined).sort((a, b) => unreadStory(a) - unreadStory(b) || byNewestStory(front[a] as Cluster, front[b] as Cluster));
    const posts = (s.posts ?? []).flatMap((id) => singles.get(id) ?? []).sort((a, b) => Number(!isUnread(a)) - Number(!isUnread(b)) || byNewestPost(a, b));
    if (stories.length + posts.length === 0) continue;
    const newest = Math.max(...stories.map((i) => (front[i] as Cluster).newest), ...posts.map(postTime));
    out.push({ name: s.name, ...(s.about ? { about: s.about } : {}), stories, singles: posts, newest });
  }
  return out.sort((a, b) => Number(a.name === OTHER_NAME) - Number(b.name === OTHER_NAME) || b.newest - a.newest || text(a.name, b.name));
}
