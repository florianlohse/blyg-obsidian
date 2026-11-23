// The sections as the edition record keeps them: each story's section name (`StoryRec.section`), each single post's (`postSections`, post id to name; a post in the
// Mixed bag with no entry has no section) and the order of the names (`sections`). Names and ids only, never text. Pure.
import type { ReadingPost } from "../studio/reading";
import type { Cluster } from "./cluster";
import type { EditionRec } from "./edition";
import { OTHER_NAME, type Section } from "./sections";
import type { ExistingSections } from "./sectionPass";

const storyNames = (rec: EditionRec, clusters: readonly Cluster[]): Array<string | undefined> => clusters.map((c) => rec.stories.find((s) => s.id === c.id)?.section);

/** The names in the record's order first, then any other in the order given; Other last. */
function ordered(rec: EditionRec, used: Iterable<string>): string[] {
  const set = new Set(used);
  const names = [...(rec.sections ?? []).filter((n) => set.has(n)), ...[...set].filter((n) => !(rec.sections ?? []).includes(n))];
  return [...names.filter((n) => n !== OTHER_NAME), ...names.filter((n) => n === OTHER_NAME)];
}

/** The sections the record keeps: each story's own section (a story that has none is "Other"), each single post's. null when nothing has one. */
export function recordSections(rec: EditionRec | null, clusters: readonly Cluster[], singles: readonly ReadingPost[] = []): Section[] | null {
  if (!rec) return null;
  const names = storyNames(rec, clusters);
  const posts = singles.flatMap((p): Array<[string, string]> => (rec.postSections?.[p.remoteId] ? [[p.remoteId, rec.postSections[p.remoteId] as string]] : []));
  if (!names.some(Boolean) && posts.length === 0) return null;
  const byName = new Map<string, Section>();
  const at = (name: string): Section => {
    let s = byName.get(name);
    if (!s) byName.set(name, (s = { name, ids: [] }));
    return s;
  };
  names.forEach((n, i) => at(n ?? OTHER_NAME).ids.push(i));
  for (const [id, name] of posts) {
    const s = at(name);
    (s.posts ??= []).push(id);
    const line = rec.postLines?.[id];
    if (line) (s.lines ??= {})[id] = line;
  }
  for (const s of byName.values()) if (rec.sectionAbout?.[s.name]) s.about = rec.sectionAbout[s.name];
  return ordered(rec, byName.keys()).map((n) => byName.get(n) as Section);
}

/** What the next run starts from: the record's section names and what each current story and single post already has. null when nothing has a section yet. */
export function existingSections(rec: EditionRec | null, clusters: readonly Cluster[], singles: readonly ReadingPost[]): ExistingSections | null {
  if (!rec) return null;
  const stories = storyNames(rec, clusters);
  const posts: Record<string, string> = {};
  for (const p of singles) {
    const n = rec.postSections?.[p.remoteId];
    if (n) posts[p.remoteId] = n;
  }
  const names = ordered(rec, [...stories.filter((n): n is string => n !== undefined), ...Object.values(posts)]);
  return names.length > 0 ? { names, stories, posts, ...(rec.sectionAbout ? { about: rec.sectionAbout } : {}), ...(rec.postLines ? { lines: rec.postLines } : {}) } : null;
}

/** The record after a run that arranged `sections`: single posts and the order of the names are remembered (a story's own name is set by the caller). Unchanged when there are none. */
export function withPostSections(rec: EditionRec, singles: readonly ReadingPost[], sections: readonly Section[] | null | undefined): EditionRec {
  if (!sections || sections.length === 0) return rec;
  const postSections: Record<string, string> = {};
  for (const p of singles) {
    const name = sections.find((s) => s.posts?.includes(p.remoteId))?.name ?? rec.postSections?.[p.remoteId];
    if (name) postSections[p.remoteId] = name;
  }
  // The bylines and lines: what this run gave, else what the record already had (a line is written once and kept; only new single posts get one).
  const postLines: Record<string, string> = {};
  for (const p of singles) {
    const line = sections.find((s) => s.posts?.includes(p.remoteId))?.lines?.[p.remoteId] ?? rec.postLines?.[p.remoteId];
    if (line) postLines[p.remoteId] = line;
  }
  const sectionAbout: Record<string, string> = {};
  for (const s of sections) {
    const about = s.about ?? rec.sectionAbout?.[s.name];
    if (about) sectionAbout[s.name] = about;
  }
  const { postSections: _old, postLines: _oldLines, sectionAbout: _oldAbout, ...rest } = rec;
  return { ...rest, sections: sections.map((s) => s.name), ...(Object.keys(postSections).length ? { postSections } : {}), ...(Object.keys(postLines).length ? { postLines } : {}), ...(Object.keys(sectionAbout).length ? { sectionAbout } : {}) };
}
