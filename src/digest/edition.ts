// The Daily's editions. An edition is made at the first open after a cutoff (the setting "Digest time", local device clock) and covers the posts from 24 hours
// before that cutoff until now; it keeps growing until the next cutoff. Its id is the cutoff's timestamp. Pure: the clock, the records and their pruning;
// no storage, no network. The records hold ids only (post ids, story ids, section names), never a post body.
export const DEFAULT_DIGEST_TIME = "07:00";
export const EDITION_MS = 24 * 3600 * 1000;
/** Edition records kept; older ones are dropped. */
export const EDITIONS_KEPT = 14;
const MAX_ABOUT_CHARS = 90;
const MAX_LINE_CHARS = 80;

/** A "HH:MM" 24-hour time, or the default for anything else. */
export function parseDigestTime(v: unknown): string {
  const m = typeof v === "string" ? /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(v) : null;
  return m ? `${String(Number(m[1])).padStart(2, "0")}:${m[2]}` : DEFAULT_DIGEST_TIME;
}

/** The local clock time `time` on the local date of `ref`, `days` days later (negative: earlier). DST is the device's own rule (a time in a gap is the next valid one). */
function occurrence(ref: number, days: number, time: string): number {
  const d = new Date(ref);
  const [h, m] = parseDigestTime(time).split(":").map(Number) as [number, number];
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m).getTime();
}

/** The latest cutoff at or before `now`. */
export function latestCutoff(now: number, time: string): number {
  const today = occurrence(now, 0, time);
  return today <= now ? today : occurrence(now, -1, time);
}

export interface StoryRec {
  id: string;
  /** Post ids (remote ids) in the order they joined. */
  posts: string[];
  /** The section's name (plain text) the last "Write the digest" put it in. */
  section?: string;
  /** The post ids the story's AI text was written from, and that text's cache key (a hash): what "+N new posts" is measured against. */
  textPosts?: string[];
  textKey?: string;
}

export interface EditionRec {
  /** The cutoff's timestamp. */
  id: number;
  createdAt: number;
  /** Next story number (story ids are "s" + a number, never reused within the edition). */
  n: number;
  stories: StoryRec[];
  /** The Mixed bag's post ids: the posts with no section. */
  mixed: string[];
  /** The section of a single post that has one (post id to section name); a post in `mixed` with no entry has no section. */
  postSections?: Record<string, string>;
  /** The section names in the order the page shows them. */
  sections?: string[];
  /** The AI byline of a section (section name to one plain line); a section with none shows no byline. */
  sectionAbout?: Record<string, string>;
  /** The AI line of a single post ("<Author> on <topic>", post id to line); a post with none shows its first sentence. */
  postLines?: Record<string, string>;
  /** When each post was first seen in this edition. */
  seen: Record<string, number>;
  /** Present once the automatic write has been tried for this edition (it is never tried twice); `note`: why it did not write, plain text. */
  auto?: { note?: string };
  /** The tokens (as counted) and rough cost of the runs of this edition, for the footer. cost null: unknown price. */
  usage?: { tokens: number; cost: number | null };
  /** The editor (src/digest/editors.ts) whose voice the stories' texts are in; absent: neutral (also every record from before editors). */
  editor?: string;
}

export interface EditionStore {
  v: 1;
  /** Oldest first. */
  editions: EditionRec[];
}

export const emptyEditions = (): EditionStore => ({ v: 1, editions: [] });

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored map of plain strings, each cut to `max` characters; anything else is dropped. */
const textMap = (v: unknown, max: number): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries((v as Record<string, unknown> | null | undefined) ?? {})) if (typeof x === "string" && x.trim() !== "") out[k] = x.slice(0, max);
  return out;
};

/** Read a stored file defensively: anything odd is dropped, never trusted. */
export function parseEditions(raw: unknown): EditionStore {
  const out = emptyEditions();
  const list = (raw as { editions?: unknown } | null)?.editions;
  if (!Array.isArray(list)) return out;
  for (const e of list as unknown[]) {
    const r = e as Record<string, unknown> | null;
    const id = num(r?.id);
    const createdAt = num(r?.createdAt);
    if (!r || id === null || createdAt === null) continue;
    const stories = (Array.isArray(r.stories) ? (r.stories as unknown[]) : []).flatMap((s): StoryRec[] => {
      const o = s as Record<string, unknown> | null;
      if (!o || typeof o.id !== "string") return [];
      const rec: StoryRec = { id: o.id, posts: strs(o.posts) };
      if (typeof o.section === "string") rec.section = o.section;
      if (Array.isArray(o.textPosts)) rec.textPosts = strs(o.textPosts);
      if (typeof o.textKey === "string") rec.textKey = o.textKey;
      return [rec];
    });
    const seen: Record<string, number> = {};
    for (const [k, v] of Object.entries((r.seen as Record<string, unknown> | undefined) ?? {})) if (num(v) !== null) seen[k] = v as number;
    const postSections: Record<string, string> = {};
    for (const [k, v] of Object.entries((r.postSections as Record<string, unknown> | undefined) ?? {})) if (typeof v === "string") postSections[k] = v;
    const names = strs(r.sections);
    const sectionAbout = textMap(r.sectionAbout, MAX_ABOUT_CHARS);
    const postLines = textMap(r.postLines, MAX_LINE_CHARS);
    const au = r.auto as { note?: unknown } | undefined;
    const us = r.usage as { tokens?: unknown; cost?: unknown } | undefined;
    const tokens = num(us?.tokens);
    out.editions.push({ id, createdAt, n: num(r.n) ?? stories.length + 1, stories, mixed: strs(r.mixed), seen, ...(au && typeof au === "object" ? { auto: typeof au.note === "string" ? { note: au.note.slice(0, 200) } : {} } : {}), ...(typeof r.editor === "string" && /^[a-z0-9-]{1,40}$/.test(r.editor) ? { editor: r.editor } : {}), ...(tokens !== null && tokens >= 0 ? { usage: { tokens, cost: num(us?.cost) } } : {}), ...(Object.keys(postSections).length ? { postSections } : {}), ...(names.length ? { sections: names } : {}), ...(Object.keys(sectionAbout).length ? { sectionAbout } : {}), ...(Object.keys(postLines).length ? { postLines } : {}) });
  }
  out.editions.sort((a, b) => a.id - b.id);
  return pruneEditions(out);
}

/** Keep the last EDITIONS_KEPT editions. */
export function pruneEditions(store: EditionStore): EditionStore {
  return { v: 1, editions: [...store.editions].sort((a, b) => a.id - b.id).slice(-EDITIONS_KEPT) };
}

/**
 * The next cutoff after an edition: the next occurrence of `time` after the edition was made, and never on the same local day as the edition's own (so a
 * changed "Digest time" cannot make a second edition on that day). Changing the setting moves only this; no edition is rewritten.
 */
export function nextCutoff(e: Pick<EditionRec, "id" | "createdAt">, time: string): number {
  for (let day = 1; ; day++) {
    const t = occurrence(e.id, day, time);
    if (t > e.createdAt) return t;
  }
}

export interface EditionWindow {
  id: number;
  since: number;
  until: number;
}

export const windowOf = (e: Pick<EditionRec, "id">, now: number): EditionWindow => ({ id: e.id, since: e.id - EDITION_MS, until: now });

/** The edition for `now`: the latest one while its next cutoff has not come, else a new one (id: the latest cutoff, even if the person was away for days). */
export function ensureEdition(store: EditionStore, now: number, time: string): { store: EditionStore; edition: EditionRec; created: boolean } {
  const eds = store.editions;
  const cur = eds[eds.length - 1];
  if (cur && nextCutoff(cur, time) > now) return { store, edition: cur, created: false };
  const edition: EditionRec = { id: latestCutoff(now, time), createdAt: now, n: 1, stories: [], mixed: [], seen: {} };
  return { store: pruneEditions({ v: 1, editions: [...eds, edition] }), edition, created: true };
}
