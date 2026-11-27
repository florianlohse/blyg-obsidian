// Which voice writes an edition's texts, and how a run is told about it. There is one voice (digest/editors.ts) and no setting. An edition keeps the voice that wrote it (no mixed voices
// on one page), an edition that already has texts from before the voice existed stays plain (it is never written again just because the plugin changed), and only an edition with no
// texts yet gets the voice. Pure.
import type { EditionRec } from "./edition";
import { EDITOR, NEUTRAL, voiceId } from "./editors";

/** The voice id for this edition's texts. */
export function editorIdFor(rec: Pick<EditionRec, "id" | "editor" | "stories"> | null): string {
  if (!rec) return EDITOR;
  if (rec.editor !== undefined) return voiceId(rec.editor) ?? NEUTRAL;
  if (rec.stories.some((s) => s.textKey !== undefined)) return NEUTRAL;
  return EDITOR;
}

/** The same deps, with the settings carrying the resolved voice id (llm.ts reads it for the voice line and the cache key). */
export function withEditor<S extends { model: string; endpoint: string }, T extends { settings: () => S }>(deps: T, editor: string): T {
  return { ...deps, settings: () => ({ ...deps.settings(), editor }) };
}
