// V1-C.2: the entry points of "Publish this paragraph": a command, and an entry in the editor's own menu (the long-press menu on a phone). Registered only
// when the feature `tangle` is on (features/register.ts).
import type { Plugin } from "obsidian";
import { routeFor } from "../core/routes";
import { runPublishParagraph, type AppEnv } from "../app/run";
import type { Route } from "../settings/schema";
import type { Outcome } from "../publish/types";

export interface TangleEntryDeps {
  /** Runs one write the way the publish command does (one at a time, the outcome shown, the panel redrawn). */
  write: (action: (env: AppEnv) => Promise<Outcome>) => Promise<void>;
  routes: () => Route[];
}

const TITLE = "Publish this paragraph";

export function registerTangleEntries(plugin: Plugin, deps: TangleEntryDeps): void {
  const publishAt = (line: number): Promise<void> => deps.write((env) => runPublishParagraph(env, line));
  plugin.addCommand({
    id: "publish-paragraph",
    name: TITLE,
    editorCallback: (editor) => void publishAt(editor.getCursor().line + 1),
  });
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu, editor, view) => {
      const path = view.file?.path;
      const route = path === undefined ? null : routeFor(deps.routes(), path);
      if (route?.mode !== "studio" || route.draftsOnly === true) return;
      const line = editor.getCursor("from").line + 1;
      menu.addItem((item) => item.setTitle(TITLE).setIcon("send").onClick(() => void publishAt(line)));
    }),
  );
}
