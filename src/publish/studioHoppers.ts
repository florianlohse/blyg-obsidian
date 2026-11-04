// The hopper half of a Studio send (roadmap S13): read before any write (so a wrong name refuses the send, fail closed), shown in the
// confirmation window, applied right after the text, and afterwards the note says what the Studio holds. A hopper change never makes a new
// version of the item. See studio/hoppers.ts for the rules.
import type { NoteRef } from "../platform/ports";
import { HOPPERS_KEY, HOPPERS_SENT_KEY, hopperChanges, namesOf, readHopperNames, readSentIds, resolveHoppers, usesHoppers } from "../studio/hoppers";
import type { StudioHopper } from "../studio/types";
import { M } from "./messages";
import { fileProperty, logError } from "./shared";
import { studioFailureOutcome } from "./studioFailure";
import { refused, type Outcome, type PublishDeps } from "./types";

export interface HopperPlan {
  /** The names in the note when the plan was made (read from the file): the write-back leaves the note alone if they have changed since. */
  names: string[];
  all: StudioHopper[];
  sent: string[] | null;
  add: string[];
  remove: string[];
  /** The Studio's set once the changes are made. */
  result: string[];
  /** Names of hoppers whose members could not all be read (more than the plugin's page cap): left as they are, and said so. */
  incomplete: string[];
}

/**
 * What the send will do to the item's hoppers, from reads only. Null when the note has nothing to do with hoppers (no request is made).
 * `itemId` is null for an item that does not exist yet.
 */
export async function planHoppers(deps: PublishDeps, note: NoteRef, itemId: string | null): Promise<{ ok: true; plan: HopperPlan | null } | { ok: false; outcome: Outcome }> {
  const studio = deps.studio;
  const rawNames = await fileProperty(deps, note, HOPPERS_KEY);
  const rawSent = await fileProperty(deps, note, HOPPERS_SENT_KEY);
  if (!studio || !usesHoppers(rawNames, rawSent)) return { ok: true, plan: null };
  const names = readHopperNames(rawNames);
  if (!names.ok) return { ok: false, outcome: refused(M.hoppersInvalid(names.problem)) };
  const listed = await studio.client.listHoppers();
  if (listed.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Reading the hoppers", listed) };
  const all = listed.value;
  const sent = readSentIds(rawSent);
  const resolved = resolveHoppers(names.names, all, sent);
  if (!resolved.ok) return { ok: false, outcome: refused(resolved.message) };
  const seen = itemId === null ? { ids: [], unknown: [] } : await membershipsOf(deps, itemId, all);
  if (!("ids" in seen)) return { ok: false, outcome: seen };
  return { ok: true, plan: { names: names.names, all, sent, ...hopperChanges({ wanted: resolved.ids, sent, inStudio: seen.ids, all, unknown: seen.unknown }), incomplete: namesOf(seen.unknown, all) } };
}

/** The hoppers this item is in now: one read per hopper. `unknown` lists those whose members could not all be read and that do not show the item: "not in it" cannot be said of them. */
export async function membershipsOf(deps: PublishDeps, itemId: string, all: StudioHopper[]): Promise<{ ids: string[]; unknown: string[] } | Outcome> {
  const studio = deps.studio;
  if (!studio) return refused(M.studioNotConfigured);
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const hopper of all) {
    const members = await studio.client.hopperMembers(hopper.id);
    if (members.kind === "not-found") continue; // deleted meanwhile
    if (members.kind !== "ok") return studioFailureOutcome("Reading the hoppers", members);
    if (members.value.ids.includes(itemId)) ids.push(hopper.id);
    else if (!members.value.complete) unknown.push(hopper.id);
  }
  return { ids, unknown };
}

/** For the confirmation window. */
export function hopperLines(plan: HopperPlan | null): string[] {
  if (!plan) return [];
  const unchecked = plan.incomplete.length > 0 ? [M.hoppersIncomplete(plan.incomplete)] : [];
  if (plan.add.length === 0 && plan.remove.length === 0) return unchecked;
  return [M.hoppersChange(namesOf(plan.add, plan.all), namesOf(plan.remove, plan.all)), ...unchecked];
}

export const hasHopperChanges = (plan: HopperPlan | null): plan is HopperPlan => plan !== null && (plan.add.length > 0 || plan.remove.length > 0);

/**
 * Make the changes, then write the Studio's set into the note (`blyg_hoppers` by name, `blyg_hoppers_sent` by id). Returns notices; never
 * fails the send (its text is already in the Studio). When a change is refused, the note is left as it was, so the next send tries again.
 */
export async function applyHoppers(deps: PublishDeps, note: NoteRef, itemId: string, plan: HopperPlan): Promise<string[]> {
  return (await applyHoppersReport(deps, note, itemId, plan)).notices;
}

async function applyHoppersReport(deps: PublishDeps, note: NoteRef, itemId: string, plan: HopperPlan): Promise<{ ok: boolean; notices: string[] }> {
  const studio = deps.studio;
  if (!studio) return { ok: false, notices: [] };
  try {
    for (const id of plan.add) {
      const done = await studio.client.addToHopper(id, itemId);
      if (done.kind !== "ok") return { ok: false, notices: [failureNotice(done.kind, "message" in done ? done.message : "")] };
    }
    for (const id of plan.remove) {
      const done = await studio.client.removeFromHopper(id, itemId);
      if (done.kind !== "ok" && done.kind !== "not-found") return { ok: false, notices: [failureNotice(done.kind, "message" in done ? done.message : "")] };
    }
  } catch (err) {
    logError(deps, "changing the item's hoppers", err);
    return { ok: false, notices: [M.hoppersFailed("the Studio could not be reached")] };
  }
  const sentBefore = plan.sent;
  const unchangedRecord = sentBefore !== null && sentBefore.length === plan.result.length && sentBefore.every((id) => plan.result.includes(id));
  const names = namesOf(plan.result, plan.all);
  const sameNames = plan.names.length === names.length && plan.names.every((n, i) => n === names[i]);
  const notices: string[] = [];
  if (!unchangedRecord || !sameNames) {
    let kept = false;
    try {
      await deps.vault.updateFrontmatter(note, (fm) => {
        // The Studio's set is always recorded (it is what the next send compares with). The names are written only if the note still says what
        // it said when the send was planned: what was typed meanwhile is the owner's, and is applied by the next send.
        const live = readHopperNames(fm[HOPPERS_KEY]);
        const unchanged = live.ok && live.names.length === plan.names.length && live.names.every((n, i) => n.toLowerCase() === (plan.names[i] ?? "").toLowerCase());
        if (unchanged) fm[HOPPERS_KEY] = names;
        else kept = true;
        fm[HOPPERS_SENT_KEY] = plan.result;
      });
    } catch (err) {
      logError(deps, "writing the hoppers into the note (ignored)", err);
    }
    if (kept) notices.push(M.hoppersNoteChanged(names));
  }
  if (hasHopperChanges(plan)) notices.unshift(M.hoppersDone(namesOf(plan.add, plan.all), namesOf(plan.remove, plan.all)));
  if (plan.incomplete.length > 0) notices.push(M.hoppersIncomplete(plan.incomplete));
  return { ok: true, notices };
}

function failureNotice(kind: string, message: string): string {
  if (kind === "forbidden") return M.hoppersNoPermission;
  return M.hoppersFailed(message || kind);
}

/** "Nothing to send" for the text, but the note's hoppers changed: apply those alone (no new version) and say so. */
export async function hoppersOnly(deps: PublishDeps, note: NoteRef, itemId: string, plan: HopperPlan | null, otherwise: Outcome): Promise<Outcome> {
  if (plan === null) return otherwise;
  const report = await applyHoppersReport(deps, note, itemId, plan);
  if (plan.add.length === 0 && plan.remove.length === 0) return plan.incomplete.length > 0 ? { ...otherwise, notices: [...otherwise.notices, M.hoppersIncomplete(plan.incomplete)] } : otherwise;
  return { status: report.ok ? "published" : "failed", notices: [M.hoppersOnlyText, ...report.notices], id: itemId };
}

/**
 * "Use the Studio's hoppers": the note's `blyg_hoppers` and `blyg_hoppers_sent` become what the Studio holds for its item. Reads only; nothing
 * is sent. A note that takes no part in hoppers and whose item is in none is left alone (`changed` false).
 */
export async function takeStudioHoppers(deps: PublishDeps, note: NoteRef, itemId: string): Promise<{ ok: true; names: string[]; changed: boolean } | { ok: false; outcome: Outcome }> {
  const studio = deps.studio;
  if (!studio) return { ok: false, outcome: refused(deps.studioProblem ?? M.studioNotConfigured) };
  const listed = await studio.client.listHoppers();
  if (listed.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Reading the hoppers", listed) };
  const seen = await membershipsOf(deps, itemId, listed.value);
  if (!("ids" in seen)) return { ok: false, outcome: seen };
  // Writing a partial set into the note as "what the Studio holds" would be wrong: reads only, so refuse and say why.
  if (seen.unknown.length > 0) return { ok: false, outcome: refused(M.hoppersIncomplete(namesOf(seen.unknown, listed.value))) };
  const inStudio = seen.ids;
  const names = namesOf(inStudio, listed.value);
  if (inStudio.length === 0 && !usesHoppers(deps.vault.frontmatterValue(note, HOPPERS_KEY), deps.vault.frontmatterValue(note, HOPPERS_SENT_KEY))) return { ok: true, names, changed: false };
  await deps.vault.updateFrontmatter(note, (fm) => {
    fm[HOPPERS_KEY] = names;
    fm[HOPPERS_SENT_KEY] = inStudio;
  });
  return { ok: true, names, changed: true };
}
