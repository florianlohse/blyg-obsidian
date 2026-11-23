// Which digest section holds a post, in the editions the plugin keeps (the current record, then the written history). Pure; names and ids only.
import type { EditionRec } from "./edition";
import type { PastEdition } from "./history";

export interface InDigest {
  edition: number;
  section: string;
}

/** The newest edition with a section for this post: the current record first, then the history (newest first). null when no edition places it in a section. */
export function sectionOfPost(postId: string, current: EditionRec | null, past: readonly PastEdition[]): InDigest | null {
  if (current) {
    const story = current.stories.find((s) => s.posts.includes(postId));
    const name = story ? story.section : current.postSections?.[postId];
    if (name) return { edition: current.id, section: name };
  }
  for (const e of [...past].sort((a, b) => b.id - a.id)) {
    if (e.id === current?.id && current) continue;
    for (const sec of e.sections ?? []) {
      if (sec.posts.includes(postId) || sec.stories.some((i) => e.stories[i]?.posts.includes(postId))) return { edition: e.id, section: sec.name };
    }
  }
  return null;
}
