// Hoppers from the plugin (roadmap S13, docs/plans/S13-hoppers-and-import.md §2.1): what a note's `blyg_hoppers` property asks for, which
// of the Studio's hoppers that is, and what to change. Pure. Decisions (Florian, 2026-11-01): hoppers are written by NAME (D2); on a send
// only the note's own changes since the last send are applied, so a membership changed in the Studio is not undone (D3); hoppers are
// created in the Studio only (D4).
import type { StudioHopper } from "./types";

/** The note's property: the hoppers it should be in, by name. */
export const HOPPERS_KEY = "blyg_hoppers";
/** Written by the plugin only: the hopper ids the Studio held after the last send, so the next send knows what the note itself changed. */
export const HOPPERS_SENT_KEY = "blyg_hoppers_sent";

/** `blyg_hoppers` as names: absent is none; one name or a list of names; anything else is refused, never guessed. */
export function readHopperNames(raw: unknown): { ok: true; names: string[] } | { ok: false; problem: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, names: [] };
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (list === null || !list.every((v) => typeof v === "string")) return { ok: false, problem: "blyg_hoppers must be a list of hopper names" };
  const names: string[] = [];
  for (const v of list) {
    const name = v.trim();
    if (name !== "" && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return { ok: true, names };
}

/** `blyg_hoppers_sent`: the ids, or null when the note was never sent with hoppers (or the value is not a list of strings). */
export function readSentIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.every((v) => typeof v === "string") ? [...new Set(raw)] : null;
}

/** Whether a note takes part at all: it names hoppers, or it was sent with some. A note with neither costs no request. */
export function usesHoppers(rawNames: unknown, rawSent: unknown): boolean {
  const names = readHopperNames(rawNames);
  return !names.ok || names.names.length > 0 || rawNames !== undefined || readSentIds(rawSent) !== null;
}

const fold = (s: string): string => s.trim().toLowerCase();

/**
 * The hoppers the names mean: a name matches a hopper's name, ignoring case; failing that, its slug. A name that matches none or two is a
 * problem, and so the send is refused (fail closed). A name that matches none but the note was last sent with a hopper that has since been
 * renamed is said so, with the new name.
 */
export function resolveHoppers(names: string[], hoppers: StudioHopper[], sentIds: string[] | null): { ok: true; ids: string[] } | { ok: false; message: string } {
  const ids: string[] = [];
  const problems: string[] = [];
  for (const name of names) {
    let found = hoppers.filter((h) => fold(h.name) === fold(name));
    if (found.length === 0) found = hoppers.filter((h) => h.slug !== null && fold(h.slug) === fold(name));
    if (found.length === 1) {
      const id = (found[0] as StudioHopper).id;
      if (!ids.includes(id)) ids.push(id);
    } else if (found.length > 1) {
      problems.push(`“${name}” is the name of ${found.length} hoppers in the Studio; rename one there`);
    } else {
      const renamed = (sentIds ?? []).map((id) => hoppers.find((h) => h.id === id)).filter((h): h is StudioHopper => h !== undefined && !names.some((n) => fold(n) === fold(h.name)));
      problems.push(renamed.length === 1 ? `there is no hopper “${name}” (renamed to “${(renamed[0] as StudioHopper).name}”?)` : `there is no hopper “${name}”`);
    }
  }
  if (problems.length === 0) return { ok: true, ids };
  const known = hoppers.length === 0 ? "The Studio has no hoppers yet: make them in the Studio." : `The Studio's hoppers: ${hoppers.map((h) => `“${h.name}”`).join(", ")}.`;
  return { ok: false, message: `Not sent — blyg_hoppers: ${problems.join("; ")}. ${known}` };
}

/**
 * What a send changes (D3). With a record of the last send, only the note's own changes since then: a hopper added to the note is added, one
 * taken off the note is taken out; what was changed in the Studio meanwhile stays. Without one (the first send with hoppers), the hoppers
 * named are added and nothing is taken out. `result` is the Studio's set afterwards, in the order of `all`.
 */
export function hopperChanges(input: { wanted: string[]; sent: string[] | null; inStudio: string[]; all: StudioHopper[]; /** Hoppers whose members could not all be read: not added to, not removed from, and kept in the result if the note names them. */ unknown?: string[] }): { add: string[]; remove: string[]; result: string[] } {
  const { wanted, sent, inStudio } = input;
  const unknown = input.unknown ?? [];
  const has = new Set(inStudio);
  const add = wanted.filter((id) => !has.has(id) && !unknown.includes(id) && (sent === null || !sent.includes(id)));
  const remove = sent === null ? [] : sent.filter((id) => !wanted.includes(id) && has.has(id));
  const after = new Set([...inStudio.filter((id) => !remove.includes(id)), ...add, ...unknown.filter((id) => wanted.includes(id) || (sent?.includes(id) ?? false))]);
  // A hopper the note adds again although it was in the last send (removed in the Studio since): the note's own wish did not change, so the
  // Studio's removal stands (D3).
  const result = [...input.all.map((h) => h.id).filter((id) => after.has(id)), ...[...after].filter((id) => !input.all.some((h) => h.id === id))];
  return { add, remove, result };
}

/** Names for ids, in the Studio's order; an id the Studio no longer has is left out. */
export function namesOf(ids: string[], all: StudioHopper[]): string[] {
  return all.filter((h) => ids.includes(h.id)).map((h) => h.name);
}
