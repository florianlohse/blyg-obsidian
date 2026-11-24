// Which editor writes an edition, and how a run is told about it. The edition keeps the editor that wrote it (no mixed voices on one page); the setting applies
// to the next edition, or when the person asks for the manual re-sort. Pure.
import type { EditionRec } from "./edition";
import { editorFor, editorById, NEUTRAL } from "./editors";

/** The editor id for this edition's texts: the one that wrote it, else (nothing written yet) the setting's pick; an edition written before editors existed is neutral. */
export function editorIdFor(rec: Pick<EditionRec, "id" | "editor" | "stories"> | null, setting: unknown): string {
  if (!rec) return editorFor(setting, 0)?.id ?? NEUTRAL;
  if (rec.editor !== undefined) return editorById(rec.editor)?.id ?? NEUTRAL;
  if (rec.stories.some((s) => s.textKey !== undefined)) return NEUTRAL;
  return editorFor(setting, rec.id)?.id ?? NEUTRAL;
}

/** The same deps, with the settings carrying the resolved editor id (llm.ts reads it for the voice line and the cache key). */
export function withEditor<S extends { model: string; endpoint: string }, T extends { settings: () => S }>(deps: T, editor: string): T {
  return { ...deps, settings: () => ({ ...deps.settings(), editor }) };
}
