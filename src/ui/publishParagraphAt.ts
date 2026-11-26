// V1-C.3: "Update item…" in the panel: put the editor's cursor in the paragraph and run the command "Publish this paragraph", the one path that publishes one.
import { MarkdownView, type App } from "obsidian";

const COMMAND_SUFFIX = ":publish-paragraph";

export async function publishParagraphAt(app: App, path: string, line: number | null): Promise<void> {
  if (line === null) return;
  const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view instanceof MarkdownView && l.view.file?.path === path);
  if (!leaf || !(leaf.view instanceof MarkdownView)) return;
  app.workspace.setActiveLeaf(leaf, { focus: true });
  leaf.view.editor.setCursor({ line: line - 1, ch: 0 });
  const commands = (app as unknown as { commands?: { commands?: Record<string, unknown>; executeCommandById?: (id: string) => boolean } }).commands;
  const id = Object.keys(commands?.commands ?? {}).find((k) => k.endsWith(COMMAND_SUFFIX));
  if (id) commands?.executeCommandById?.(id);
}
