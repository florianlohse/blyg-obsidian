// "Today's editor: <name>" under the masthead, a small muted line, text only. Drawn only for an editor this plugin knows; neutral draws nothing.
import { editorById } from "../digest/editors";

export function drawEditorLine(root: HTMLElement, editorId: string | undefined, past = false): HTMLElement | null {
  const e = editorById(editorId);
  if (!e) return null;
  return root.createDiv({ cls: "blyg-daily-editor", text: `${past ? "Editor" : "Today's editor"}: ${e.name}` });
}
