// The Daily's sync-safe state (DG16). One device writes ONLY its own files, `digest/ed-<cutoff>.<device>.json`, one per edition: that file is the device's replica
// of the edition. Every device reads ALL such files and joins them with the pure functions below. The join is commutative, associative and idempotent (a state-based
// CRDT), so a file arriving late, twice, partial (ignored), as a conflict copy, or in any order gives every device the same edition.
//   - a "register" is a value with a stamp (counter, device id): the higher stamp wins, a tie goes to the larger device id (then the larger text);
//   - `created` is the lowest (time, device) seen: the one edition record every device agrees on;
//   - `posts` maps a post id to the earliest time any device first saw it (union, minimum);
//   - every other fact is a register under a key such as `place/<post id>` (which story a post is in, "" = Mixed bag), `sec/<story id>`, `txt/<story id>`, `pSec/<post id>`,
//     `pLine/<post id>`, `about/<section>`, `order`, `auto`, `lock`, `usage/<device>` (each device sums its own, so adding up never double counts), `hist`, `ai/<key>`, `sx/<key>`.
// Names, ids and the AI's own texts only: never a post body. Story ids come from CONTENT (`storyIdFor`), not from a counter, so two devices name one story alike.
import type { EditionRec, StoryRec } from "../edition";
import { hashText } from "../llm";
import { parseHistory, type PastEdition } from "../history";
import { localDay } from "../budget";

export interface Reg<T = unknown> {
  /** Logical clock: the highest counter this device had seen, plus one. */
  c: number;
  /** The device that wrote it. */
  d: string;
  v: T;
}

export interface EdState {
  v: 2;
  /** The edition's id (its cutoff). */
  id: number;
  /** The device that wrote this file, and the name it gave itself (for "made on …"). */
  device: string;
  label: string;
  /** When this file was last written (the writer's clock), for "newer than the last read". */
  at: number;
  /** The creator of the edition: lowest (at, device). Absent in a state that only carries history. */
  created?: { at: number; d: string };
  posts: Record<string, number>;
  regs: Record<string, Reg>;
  clock: number;
}

export const FILE_RE = /^ed-(\d+)\./;
export const fileName = (id: number, device: string): string => `ed-${id}.${device}.json`;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Stamp order: the larger counter wins; a tie goes to the larger device id. */
export const stampCmp = (a: { c: number; d: string }, b: { c: number; d: string }): number => a.c - b.c || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);

/** A register's winner. Equal stamps with different values (a cloned device id) are decided by the value's text, so the join stays deterministic. */
function winner(a: Reg, b: Reg): Reg {
  const s = stampCmp(a, b);
  if (s !== 0) return s > 0 ? a : b;
  return JSON.stringify(a.v) >= JSON.stringify(b.v) ? a : b;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const MAX_REGS = 20_000;

/** Read one file defensively. null: not a state (partial, corrupt, other format): ignored, never trusted. */
export function parseState(text: string): EdState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 2) return null;
  const id = fin(raw.id);
  if (id === null || typeof raw.device !== "string" || !DEVICE_RE.test(raw.device)) return null;
  const posts: Record<string, number> = {};
  if (isObj(raw.posts)) for (const [k, v] of Object.entries(raw.posts)) if (fin(v) !== null) posts[k] = v as number;
  const regs: Record<string, Reg> = {};
  let n = 0;
  if (isObj(raw.regs))
    for (const [k, r] of Object.entries(raw.regs)) {
      if (!isObj(r) || fin(r.c) === null || typeof r.d !== "string" || !DEVICE_RE.test(r.d) || !("v" in r)) continue;
      if (++n > MAX_REGS) break;
      regs[k] = { c: r.c as number, d: r.d, v: r.v };
    }
  const cr = raw.created;
  const created = isObj(cr) && fin(cr.at) !== null && typeof cr.d === "string" && DEVICE_RE.test(cr.d) ? { at: cr.at as number, d: cr.d } : undefined;
  return { v: 2, id, device: raw.device, label: typeof raw.label === "string" ? raw.label.slice(0, 40) : "", at: fin(raw.at) ?? 0, ...(created ? { created } : {}), posts, regs, clock: fin(raw.clock) ?? 0 };
}

export const emptyState = (id: number, device: string, label: string, now: number): EdState => ({ v: 2, id, device, label, at: now, posts: {}, regs: {}, clock: 0 });

const earlier = (a: { at: number; d: string }, b: { at: number; d: string }): boolean => a.at < b.at || (a.at === b.at && a.d < b.d);

/** The join of states of ONE edition (any number, any order, duplicates welcome). `device`/`label`/`at` of the result are those of the newest writer; they are not part of the merged facts. */
export function joinStates(states: readonly EdState[]): EdState | null {
  const first = states[0];
  if (!first) return null;
  const out: EdState = { v: 2, id: first.id, device: first.device, label: first.label, at: first.at, posts: {}, regs: {}, clock: 0 };
  for (const s of states) {
    if (s.id !== out.id) continue;
    if (s.at > out.at || (s.at === out.at && s.device > out.device)) Object.assign(out, { device: s.device, label: s.label, at: s.at });
    out.clock = Math.max(out.clock, s.clock);
    if (s.created && (!out.created || earlier(s.created, out.created))) out.created = s.created;
    for (const [k, t] of Object.entries(s.posts)) if (!(k in out.posts) || t < (out.posts[k] as number)) out.posts[k] = t;
    for (const [k, r] of Object.entries(s.regs)) {
      const have = out.regs[k];
      out.regs[k] = have ? winner(have, r) : r;
      out.clock = Math.max(out.clock, r.c);
    }
  }
  return out;
}

/** All files' states, grouped by edition and joined. */
export function joinAll(states: readonly EdState[]): Map<number, EdState> {
  const by = new Map<number, EdState[]>();
  for (const s of states) (by.get(s.id) ?? by.set(s.id, []).get(s.id) ?? []).push(s);
  const out = new Map<number, EdState>();
  for (const [id, list] of by) {
    const j = joinStates(list);
    if (j) out.set(id, j);
  }
  return out;
}

// ---- typed reads of registers (a register of the wrong shape counts as absent)
const str = (r: Reg | undefined): string | null => (r && typeof r.v === "string" ? r.v : null);
const strMap = (j: EdState, prefix: string, max: number): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const [k, r] of Object.entries(j.regs)) if (k.startsWith(prefix) && typeof r.v === "string" && r.v.trim() !== "") o[k.slice(prefix.length)] = r.v.slice(0, max);
  return o;
};
const byTime = (j: EdState) => (a: string, b: string): number => (j.posts[a] ?? 0) - (j.posts[b] ?? 0) || (a < b ? -1 : a > b ? 1 : 0);

/** The story id for a story made of these posts: derived from the OLDEST post (by time, then id), so two devices that group the same posts name the story alike. */
export function storyIdFor(oldestPostId: string): string {
  return `s${hashText(oldestPostId).slice(0, 8)}`;
}

/** The record of the edition as the old code knows it, from a joined state. null: the state has no creator (history only). */
export function projectEdition(j: EdState): EditionRec | null {
  if (!j.created) return null;
  const order = byTime(j);
  const placed = new Map<string, string[]>();
  const mixed: string[] = [];
  const storyIds = Object.keys(j.regs).filter((k) => k.startsWith("story/")).map((k) => k.slice(6));
  const known = new Set(storyIds);
  for (const id of Object.keys(j.posts)) {
    const to = str(j.regs[`place/${id}`]);
    if (to !== null && to !== "" && known.has(to)) (placed.get(to) ?? placed.set(to, []).get(to) ?? []).push(id);
    else mixed.push(id);
  }
  const stories: StoryRec[] = storyIds.map((sid): StoryRec => {
    const posts = (placed.get(sid) ?? []).sort(order);
    const rec: StoryRec = { id: sid, posts };
    const sec = str(j.regs[`sec/${sid}`]);
    if (sec) rec.section = sec;
    const t = j.regs[`txt/${sid}`]?.v;
    if (isObj(t) && typeof t.key === "string" && Array.isArray(t.posts)) {
      rec.textKey = t.key;
      rec.textPosts = t.posts.filter((x): x is string => typeof x === "string");
    }
    return rec;
  });
  stories.sort((a, b) => (a.posts.length ? (j.posts[a.posts[0] as string] ?? 0) : Infinity) - (b.posts.length ? (j.posts[b.posts[0] as string] ?? 0) : Infinity) || (a.id < b.id ? -1 : 1));
  const postSections = strMap(j, "pSec/", 40);
  const postLines = strMap(j, "pLine/", 80);
  const sectionAbout = strMap(j, "about/", 90);
  const names = j.regs.order && Array.isArray(j.regs.order.v) ? (j.regs.order.v as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const au = j.regs.auto?.v;
  const ed = j.regs.editor?.v;
  let tokens = 0;
  let cost: number | null = 0;
  let used = false;
  for (const [k, r] of Object.entries(j.regs)) {
    if (!k.startsWith("usage/") || !isObj(r.v) || fin(r.v.tokens) === null || (r.v.tokens as number) < 0) continue;
    used = true;
    tokens += r.v.tokens as number;
    cost = cost === null || fin(r.v.cost) === null ? null : cost + (r.v.cost as number);
  }
  return {
    id: j.id,
    createdAt: j.created.at,
    n: stories.length + 1,
    stories,
    mixed: mixed.sort(order),
    seen: { ...j.posts },
    ...(typeof ed === "string" && /^[a-z0-9-]{1,40}$/.test(ed) ? { editor: ed } : {}),
    ...(au !== undefined && au !== null && isObj(au) ? { auto: typeof au.note === "string" ? { note: au.note.slice(0, 200) } : {} } : {}),
    ...(used ? { usage: { tokens, cost } } : {}),
    ...(Object.keys(postSections).length ? { postSections } : {}),
    ...(names.length ? { sections: names } : {}),
    ...(Object.keys(sectionAbout).length ? { sectionAbout } : {}),
    ...(Object.keys(postLines).length ? { postLines } : {}),
  };
}

/** The history record of the edition (the day switcher), if a device wrote one. */
export function projectHistory(j: EdState): PastEdition | null {
  const h = j.regs.hist?.v;
  return h === undefined ? null : (parseHistory({ editions: [h] }).editions[0] ?? null);
}

/** A lock: another device is writing this edition's AI text since `since`. */
export interface Lock {
  device: string;
  label: string;
  since: number;
}
export const LOCK_TTL_MS = 2 * 60 * 1000;
export function lockOf(j: EdState | undefined, me: string, now: number): Lock | null {
  const v = j?.regs.lock?.v;
  if (!isObj(v) || v.done === true || typeof v.device !== "string" || v.device === me || fin(v.since) === null) return null;
  return (v.since as number) + LOCK_TTL_MS > now ? { device: v.device, label: typeof v.label === "string" ? v.label : "another device", since: v.since as number } : null;
}

// ---- writing: the changes a device makes are turned into registers of its OWN state
/** Set a register in `own` (a new stamp above everything seen). Returns true if it changed. */
export function setReg(own: EdState, key: string, v: unknown, counter: number): boolean {
  const have = own.regs[key];
  if (have && JSON.stringify(have.v) === JSON.stringify(v)) return false;
  own.regs[key] = { c: counter, d: own.device, v };
  own.clock = Math.max(own.clock, counter);
  return true;
}

/**
 * Put the changes between `base` (what the merged state projected to) and `next` (what the code made of it) into `own`. A fact that did not change gets no new stamp, so
 * an older concurrent change of another device is not overridden by accident. Nothing is ever removed (an old key is harmless: only posts that exist are looked up).
 * Returns true if `own` changed.
 */
export function applyChange(own: EdState, base: EditionRec | null, next: EditionRec, counter: number, day = ""): boolean {
  let changed = false;
  const set = (k: string, v: unknown): void => void (changed = setReg(own, k, v, counter) || changed);
  // Only the device that makes an edition (nothing of it was known) claims it; a device that adopts an edition leaves `created` to the one who made it.
  if (!base && !own.created) {
    own.created = { at: next.createdAt, d: own.device };
    changed = true;
  }
  for (const [id, t] of Object.entries(next.seen)) if (!(id in own.posts) || t < (own.posts[id] as number)) { own.posts[id] = t; changed = true; }
  const was = new Map(base?.stories.map((s) => [s.id, s]));
  const placeOf = new Map<string, string>();
  for (const s of base?.stories ?? []) for (const p of s.posts) placeOf.set(p, s.id);
  for (const s of next.stories) {
    if (!was.has(s.id)) set(`story/${s.id}`, 1);
    const b = was.get(s.id);
    for (const p of s.posts) if (placeOf.get(p) !== s.id) set(`place/${p}`, s.id);
    if (s.section && s.section !== b?.section) set(`sec/${s.id}`, s.section);
    if (s.textKey && (s.textKey !== b?.textKey || JSON.stringify(s.textPosts) !== JSON.stringify(b?.textPosts))) set(`txt/${s.id}`, { key: s.textKey, posts: s.textPosts ?? [] });
  }
  for (const p of next.mixed) if (!placeOf.has(p) && !(base?.mixed ?? []).includes(p)) set(`place/${p}`, "");
  const maps: Array<[string, Record<string, string> | undefined, Record<string, string> | undefined]> = [
    ["pSec/", next.postSections, base?.postSections],
    ["pLine/", next.postLines, base?.postLines],
    ["about/", next.sectionAbout, base?.sectionAbout],
  ];
  for (const [prefix, n, b] of maps) for (const [k, v] of Object.entries(n ?? {})) if (b?.[k] !== v) set(`${prefix}${k}`, v);
  if (next.sections && JSON.stringify(next.sections) !== JSON.stringify(base?.sections)) set("order", next.sections);
  if (next.auto && !base?.auto) set("auto", next.auto);
  // The editor whose voice the texts are in: one register; "" = neutral again (a re-sort in another voice). A write keeps the edition's editor, so the value only changes on purpose.
  if ((next.editor ?? "") !== (base?.editor ?? "")) set("editor", next.editor ?? "");
  if (next.usage && next.usage.tokens !== (base?.usage?.tokens ?? 0)) {
    const mine = ownUsage(own);
    const dt = next.usage.tokens - (base?.usage?.tokens ?? 0);
    const dc = next.usage.cost === null || base?.usage?.cost === null ? null : next.usage.cost - (base?.usage?.cost ?? 0);
    // `days`: this device's tokens by local day (the last few), so the daily ceiling can add up what ALL devices used on one day (`usedOnDay`).
    const days = { ...mine.days };
    if (day) days[day] = Math.max(0, (days[day] ?? 0) + dt);
    set(`usage/${own.device}`, { tokens: Math.max(0, mine.tokens + dt), cost: mine.cost === null || dc === null ? null : Math.max(0, mine.cost + dc), ...(Object.keys(days).length ? { days: Object.fromEntries(Object.entries(days).sort().slice(-3)) } : {}) });
  }
  return changed;
}

/** The device's own usage of this edition is the difference between the sum it wrote and the sum now (the code adds to the sum). */
export function ownUsage(own: EdState): { tokens: number; cost: number | null; days: Record<string, number> } {
  const v = own.regs[`usage/${own.device}`]?.v;
  return isObj(v) && fin(v.tokens) !== null ? { tokens: v.tokens as number, cost: fin(v.cost), days: daysOf(v) } : { tokens: 0, cost: 0, days: {} };
}

const daysOf = (v: Record<string, unknown>): Record<string, number> => {
  const out: Record<string, number> = {};
  if (isObj(v.days)) for (const [d, t] of Object.entries(v.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && fin(t) !== null && (t as number) >= 0) out[d] = t as number;
  return out;
};

/**
 * What each device used on the local day `day`, added up over the joined editions: the `days` of each device's `usage/<device>` register. A register from before `days` existed
 * (no map at all) counts whole for the day the edition's newest file was written (an over-count at worst: the ceiling then errs towards refusing).
 */
export function usedOnDay(joined: Iterable<EdState>, day: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const j of joined) {
    for (const [k, r] of Object.entries(j.regs)) {
      if (!k.startsWith("usage/") || !isObj(r.v) || fin(r.v.tokens) === null) continue;
      const dev = k.slice(6);
      const days = daysOf(r.v);
      const t = isObj(r.v.days) ? days[day] ?? 0 : localDay(j.at) === day ? (r.v.tokens as number) : 0;
      if (t > 0) out.set(dev, (out.get(dev) ?? 0) + t);
    }
  }
  return out;
}
