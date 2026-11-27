// The second transport of the Daily's sync (DG20): this device's editions inside the plugin's data.json, which Obsidian Sync carries (extra files of the plugin folder were not
// seen on the other device). Each device writes ONLY its own top-level key `digestSync_<deviceId>` (never one shared key: two devices writing one key would conflict) and reads all
// the others. Pure functions here; the file access is in dataPort.ts and src/app/dataUpdater.ts, which never lets a write drop a foreign key. Plugin storage only: no token,
// key or post body is ever put into the payload (it is built from the join's own fields by name, below).
import { EDITIONS_KEPT } from "../edition";
import { parseState, type EdState } from "./state";

export const KEY_PREFIX = "digestSync_";
/** How many editions (cutoffs) a device keeps in its key. */
export const KEY_EDITIONS = 3;
/** The most a device's key may hold, in bytes of JSON. A bigger one is thinned (below), never written whole. */
export const MAX_KEY_BYTES = 200_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const keyOf = (device: string): string => `${KEY_PREFIX}${device}`;
export const isSyncKey = (k: string): boolean => k.startsWith(KEY_PREFIX);

/** How many local days of cost this device keeps in its key (a bit more than two months, so a whole calendar month is always covered). */
export const COST_DAYS = 62;
/** The cost register: the estimated dollars this device's AI writes cost on each local day ("YYYY-MM-DD"). Numbers only, no text of any post. */
export type CostRegister = Record<string, number>;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The newest `COST_DAYS` days of a register, as a fresh object built field by field. */
export function boundCost(reg: CostRegister): CostRegister {
  return Object.fromEntries(Object.entries(reg).filter(([d, n]) => DAY_RE.test(d) && Number.isFinite(n) && n > 0).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, COST_DAYS).map(([d, n]) => [d, round6(n)]));
}

/** A register read from data.json: undefined (a key of an older version) is an empty register; anything that is not a plain object of day -> non-negative number is null (unreadable: the total is then not shown). */
export function parseCost(raw: unknown): CostRegister | null {
  if (raw === undefined) return {};
  if (!isObj(raw)) return null;
  const out: CostRegister = {};
  for (const [d, n] of Object.entries(raw)) {
    if (!DAY_RE.test(d) || typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    out[d] = n;
  }
  return boundCost(out);
}

export interface KeyPayload {
  v: 1;
  device: string;
  /** The writer's clock when it last changed. */
  at: number;
  editions: EdState[];
  /** The cost register of this device (absent while it is empty). */
  cost?: CostRegister;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A copy that carries only the fields the join knows (by name), so nothing else can ride along into the synced file. */
const strip = (s: EdState): EdState => ({ v: 2, id: s.id, device: s.device, label: "", at: s.at, ...(s.created ? { created: { at: s.created.at, d: s.created.d } } : {}), posts: { ...s.posts }, regs: { ...s.regs }, clock: s.clock });

const without = (s: EdState, drop: (k: string) => boolean): EdState => ({ ...s, regs: Object.fromEntries(Object.entries(s.regs).filter(([k]) => !drop(k))) });

/**
 * This device's key: the newest `KEY_EDITIONS` editions it holds, within `MAX_KEY_BYTES`. Over the limit it thins, oldest edition first: first the old editions' day-switcher
 * records and AI texts (the story texts are rewritten on demand), then whole old editions; the newest edition is always kept as it is. null: even the newest alone is too big
 * (the key is not written; the folder files still carry it).
 */
export function buildPayload(own: readonly EdState[], device: string, cost: CostRegister = {}): { payload: KeyPayload; bytes: number } | null {
  const newest = [...own].filter((s) => s.device === device).sort((a, b) => b.id - a.id).slice(0, KEY_EDITIONS).map(strip);
  if (newest.length === 0) return null;
  const reg = boundCost(cost);
  const make = (eds: EdState[]): KeyPayload => ({ v: 1, device, at: Math.max(...eds.map((e) => e.at)), editions: eds, ...(Object.keys(reg).length > 0 ? { cost: reg } : {}) });
  const size = (p: KeyPayload): number => JSON.stringify(p).length;
  let eds = newest;
  const steps: Array<(s: EdState, i: number) => EdState> = [
    (s, i) => (i === 0 ? s : without(s, (k) => k === "hist")),
    (s, i) => (i === 0 ? s : without(s, (k) => k === "hist" || k.startsWith("ai/") || k.startsWith("sx/"))),
  ];
  for (const f of [null, ...steps]) {
    if (f) eds = eds.map(f);
    if (size(make(eds)) <= MAX_KEY_BYTES) return { payload: make(eds), bytes: size(make(eds)) };
  }
  while (eds.length > 1) {
    eds = eds.slice(0, -1);
    if (size(make(eds)) <= MAX_KEY_BYTES) return { payload: make(eds), bytes: size(make(eds)) };
  }
  return null;
}

export interface KeyRead {
  device: string;
  at: number;
  bytes: number;
  states: EdState[];
  /** This device's cost register; null when the key holds one that cannot be read. */
  cost: CostRegister | null;
}

/** Every device's key found in the parsed data.json (this device's too). Keys that do not parse are ignored here (and kept untouched when writing). */
export function readKeys(data: Record<string, unknown>): KeyRead[] {
  const out: KeyRead[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (!isSyncKey(k) || !isObj(v) || v.v !== 1 || typeof v.device !== "string" || !ID_RE.test(v.device) || k !== keyOf(v.device) || !Array.isArray(v.editions)) continue;
    const states: EdState[] = [];
    for (const e of v.editions.slice(0, EDITIONS_KEPT)) {
      const st = parseState(JSON.stringify(e));
      if (st && st.device === v.device) states.push(st);
    }
    out.push({ device: v.device, at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0, bytes: JSON.stringify(v).length, states, cost: parseCost(v.cost) });
  }
  return out;
}

/** `next` with every sync key of `disk` put back as found, except `own` (the one key a caller is allowed to change). A key the change removed or edited comes back. */
export function keepForeign(disk: Record<string, unknown>, next: Record<string, unknown>, own: string | null): Record<string, unknown> {
  const out = { ...next };
  for (const k of Object.keys(disk)) if (isSyncKey(k) && k !== own) out[k] = disk[k];
  return out;
}
