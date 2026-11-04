// The items the owner chose not to import ("don't offer these again", roadmap S7), kept in data.json under their own key: settings saves
// replace the settings keys only, so an older plugin on another device leaves this list alone. Ticking an item later takes it off.
import { isBlygId } from "../core/ids";

export const IGNORE_KEY = "studioImportIgnored";
/** Enough for every item a person writes; the oldest entries drop off first. */
const MAX = 5000;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The ignored ids in data.json (anything that is not an id is dropped). */
export function readIgnored(data: unknown): Set<string> {
  const raw = isPlain(data) ? data[IGNORE_KEY] : undefined;
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && isBlygId(v)) : []);
}

/** data.json with `add` on the list and `remove` off it. */
export function updateIgnored(data: Record<string, unknown>, change: { add: string[]; remove: string[] }): void {
  const drop = new Set(change.remove);
  const kept = [...readIgnored(data)].filter((id) => !drop.has(id));
  for (const id of change.add) if (isBlygId(id) && !kept.includes(id)) kept.push(id);
  data[IGNORE_KEY] = kept.slice(-MAX);
}
