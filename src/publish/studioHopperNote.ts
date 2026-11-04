// "Studio: use the Studio's hoppers for this note" (roadmap S13): the note's hopper properties become what the Studio holds. Nothing is sent.
import type { NoteRef } from "../platform/ports";
import { readStudioRecord } from "../studio/record";
import { M } from "./messages";
import { logError } from "./shared";
import { takeStudioHoppers } from "./studioHoppers";
import { failed, refused, type Outcome, type PublishDeps } from "./types";
import { HttpError } from "../platform/http";

export async function takeHoppersNote(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const studio = deps.studio;
  if (!studio) return refused(deps.studioProblem ?? M.studioNotConfigured);
  if (note.extension !== "md") return refused(M.notMarkdown(note.name));
  const record = readStudioRecord(deps.vault, note, studio.address.origin);
  if (record.kind === "invalid") return refused(M.studioInvalidRecord(record.problem));
  if (record.kind !== "this") return refused(M.hoppersNotPublished);
  try {
    const taken = await takeStudioHoppers(deps, note, record.id);
    if (!taken.ok) return taken.outcome;
    return { status: "published", notices: [M.hoppersTaken(taken.names)], id: record.id };
  } catch (err) {
    logError(deps, "reading the item's hoppers", err);
    return failed(err instanceof HttpError ? err.message : M.studioNetworkSafe);
  }
}
