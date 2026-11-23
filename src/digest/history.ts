// The digest's history: the last 14 editions as compact records, written when an edition's AI text is written (plugin storage, `digest-history.json`).
// A record holds what the page shows: story headlines and summaries, section names, and post ids per story, with the author's name per post so a post the
// reader no longer holds can still be shown as a plain row. No post body is kept here, and nothing that could hold the key (only strings built from the
// finished digest). Pure apart from the injected storage ports.
import type { Cluster } from "./cluster";
import { EDITIONS_KEPT } from "./edition";
import type { Outcome } from "./llm";
import type { ReadingPost } from "../studio/reading";
import { authorOf } from "./storyMeta";

/** A sanity cap for the whole file, in characters: past it the oldest editions are dropped (never the newest) and `capped` says so. */
export const HISTORY_MAX_CHARS = 400_000;
const MAX_STORIES = 60;
const MAX_POSTS_PER_STORY = 30;
const MAX_SINGLES = 400;
const MAX_TEXT = 300;
const MAX_NAME = 60;

export interface PastStory {
  headline: string;
  summary: string;
  /** Post ids (remote ids). */
  posts: string[];
  /** When the story's newest post came (ms), for the order of stories within a section; absent in older records. */
  newest?: number;
}
export interface PastSection {
  name: string;
  /** The section's byline, or absent. */
  about?: string;
  /** Positions in `stories`. */
  stories: number[];
  /** Single post ids. */
  posts: string[];
}
export interface PastEdition {
  /** The edition's id (its cutoff timestamp). */
  id: number;
  /** When its text was last written. */
  at: number;
  stories: PastStory[];
  /** The single posts (the Mixed bag), by post id. */
  singles: string[];
  /** null: no sections (the plain front page). */
  sections: PastSection[] | null;
  /** The author's name per post id. */
  who: Record<string, string>;
  /** The AI line of a single post, by post id (absent: none). */
  lines?: Record<string, string>;
}
export interface HistoryStore {
  v: 1;
  /** Oldest first. */
  editions: PastEdition[];
  /** True when editions were dropped only because the file grew past HISTORY_MAX_CHARS. */
  capped?: boolean;
}

export const emptyHistory = (): HistoryStore => ({ v: 1, editions: [] });
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0) : []);

/** The compact record of one written edition, from what the page was drawn from. */
export function buildPast(id: number, clusters: readonly Cluster[], o: Pick<Outcome, "written" | "sections">, singles: readonly ReadingPost[], now: number): PastEdition {
  const who: Record<string, string> = {};
  const stories = clusters.slice(0, MAX_STORIES).map((c, i): PastStory => {
    const w = o.written[i];
    const posts = c.posts.slice(0, MAX_POSTS_PER_STORY);
    for (const p of posts) who[p.remoteId] = authorOf(p).slice(0, MAX_NAME);
    return { headline: str(w?.headline ?? c.headline, MAX_TEXT), summary: str(w?.summary ?? "", MAX_TEXT), posts: posts.map((p) => p.remoteId), newest: c.newest };
  });
  const kept = singles.slice(0, MAX_SINGLES);
  for (const p of kept) who[p.remoteId] = authorOf(p).slice(0, MAX_NAME);
  const ids = new Set(kept.map((p) => p.remoteId));
  const sections = o.sections
    ? o.sections.map((s): PastSection => ({ name: str(s.name, 40), ...(s.about ? { about: str(s.about, 90) } : {}), stories: s.ids.filter((i) => Number.isInteger(i) && i >= 0 && i < stories.length), posts: (s.posts ?? []).filter((x) => ids.has(x)) }))
    : null;
  const lines: Record<string, string> = {};
  for (const s of o.sections ?? []) for (const [k, v] of Object.entries(s.lines ?? {})) if (ids.has(k)) lines[k] = str(v, 80);
  return { id, at: now, stories, singles: kept.map((p) => p.remoteId), sections, who, ...(Object.keys(lines).length ? { lines } : {}) };
}

export function parseHistory(raw: unknown): HistoryStore {
  const out = emptyHistory();
  const r = raw as { editions?: unknown; capped?: unknown } | null;
  if (!r || !Array.isArray(r.editions)) return out;
  for (const e of r.editions as unknown[]) {
    const o = e as Record<string, unknown> | null;
    if (!o || typeof o.id !== "number" || !Number.isFinite(o.id) || typeof o.at !== "number") continue;
    const stories = (Array.isArray(o.stories) ? (o.stories as unknown[]) : []).slice(0, MAX_STORIES).map((s): PastStory => {
      const x = s as Record<string, unknown> | null;
      return { headline: str(x?.headline, MAX_TEXT), summary: str(x?.summary, MAX_TEXT), posts: strs(x?.posts, MAX_POSTS_PER_STORY), ...(typeof x?.newest === "number" && Number.isFinite(x.newest) ? { newest: x.newest } : {}) };
    });
    const sections = Array.isArray(o.sections)
      ? (o.sections as unknown[]).map((s): PastSection => {
          const x = s as Record<string, unknown> | null;
          const about = str(x?.about, 90);
          return { name: str(x?.name, 40), ...(about ? { about } : {}), stories: ints(x?.stories).filter((i) => i < stories.length), posts: strs(x?.posts, MAX_SINGLES) };
        })
      : null;
    const who: Record<string, string> = {};
    for (const [k, v] of Object.entries((o.who as Record<string, unknown> | undefined) ?? {})) if (typeof v === "string") who[k] = v.slice(0, MAX_NAME);
    const lines: Record<string, string> = {};
    for (const [k, v] of Object.entries((o.lines as Record<string, unknown> | undefined) ?? {})) if (typeof v === "string" && v !== "") lines[k] = v.slice(0, 80);
    out.editions.push({ id: o.id, at: o.at, stories, singles: strs(o.singles, MAX_SINGLES), sections, who, ...(Object.keys(lines).length ? { lines } : {}) });
  }
  if (r.capped === true) out.capped = true;
  return trimHistory(out);
}

/** Last EDITIONS_KEPT editions (oldest dropped first), then the size cap (the oldest go first, the newest stays). */
export function trimHistory(store: HistoryStore): HistoryStore {
  let eds = [...store.editions].sort((a, b) => a.id - b.id).slice(-EDITIONS_KEPT);
  let capped = store.capped === true;
  while (eds.length > 1 && JSON.stringify(eds).length > HISTORY_MAX_CHARS) {
    eds = eds.slice(1);
    capped = true;
  }
  return { v: 1, editions: eds, ...(capped ? { capped } : {}) };
}

export const CAPPED_NOTE = "Some older editions were dropped to keep the saved history small.";

export interface HistoryPorts {
  read: () => Promise<unknown>;
  write: (text: string) => Promise<void>;
}

export class History {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly ports: HistoryPorts) {}
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async load(): Promise<HistoryStore> {
    try {
      return parseHistory(await this.ports.read());
    } catch {
      return emptyHistory();
    }
  }
  /** The stored editions, newest first, and whether the size cap dropped some. */
  list(): Promise<{ editions: PastEdition[]; capped: boolean }> {
    return this.queue(async () => {
      const s = await this.load();
      return { editions: [...s.editions].reverse(), capped: s.capped === true };
    });
  }
  /** Keep this edition's record (replacing an earlier one of the same edition). */
  put(rec: PastEdition): Promise<void> {
    return this.queue(async () => {
      const s = await this.load();
      const next = trimHistory({ ...s, editions: [...s.editions.filter((e) => e.id !== rec.id), rec] });
      await this.ports.write(JSON.stringify(next)).catch(() => undefined);
    });
  }
}
