// The two doors for a shared blyg address (HK6): the command "Open post address from clipboard", and the share inbox (a folder the iOS share sheet's
// Location writes new notes into; the plugin looks at each NEW note there, opens the post it names, and touches nothing else). Both end in
// `openSharedText`. The inbox is off while the setting is empty. Notes that already exist, or that are edited later, are never looked at; no note is changed,
// moved or deleted.
import { Notice, TFile, type Plugin } from "obsidian";
import { BLYG_READER_VIEW, BlygReaderView } from "../ui/ReaderView";
import type { BlygSettings } from "../settings/schema";
import { inShareInbox, openSharedText, shareText } from "./shareOpen";
import type { buildStudio } from "./run";

export interface ShareEntryDeps {
  settings: () => BlygSettings;
  build: () => ReturnType<typeof buildStudio>;
  openReader: () => Promise<void>;
}

/** How long a new note is left alone before it is read (a share sheet may write it in two steps), and how often an empty one is tried again. */
const SETTLE_MS = 800;
const TRIES = 3;

export function registerShareEntry(plugin: Plugin, deps: ShareEntryDeps): void {
  const { app } = plugin;
  const open = async (text: string): Promise<void> => {
    const built = deps.build();
    if (!built.ok) return void new Notice(built.message, 8000);
    const result = await openSharedText(text, {
      client: built.studio.client,
      address: built.studio.address,
      showPost: async (post) => {
        await deps.openReader();
        const view = app.workspace.getLeavesOfType(BLYG_READER_VIEW).map((l) => l.view).find((v): v is BlygReaderView => v instanceof BlygReaderView);
        view?.openPost(post);
      },
      openOwn: async (id) => {
        const file = app.vault.getMarkdownFiles().find((f) => app.metadataCache.getFileCache(f)?.frontmatter?.blyg_id === id);
        if (!file) return false;
        await app.workspace.getLeaf("tab").openFile(file);
        return true;
      },
    });
    if (result.kind === "refused") new Notice(result.message, 8000);
  };

  plugin.addCommand({
    id: "open-address-from-clipboard",
    name: "Open post address from clipboard",
    callback: () => {
      void (async () => {
        let text = "";
        try {
          text = await navigator.clipboard.readText();
        } catch {
          return void new Notice(shareText.clipboardDenied, 8000);
        }
        if (text.trim() === "") return void new Notice(shareText.clipboardEmpty, 8000);
        await open(text);
      })();
    },
  });

  const handled = new Set<string>();
  const look = async (file: TFile): Promise<void> => {
    for (let i = 0; i < TRIES; i++) {
      await new Promise((r) => window.setTimeout(r, SETTLE_MS));
      const text = await app.vault.cachedRead(file).catch(() => "");
      if (text.trim() !== "") return void (await open(text));
    }
  };
  // Registered once the vault has loaded: before that, `create` fires for every file already there.
  app.workspace.onLayoutReady(() => {
    plugin.registerEvent(
      app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || handled.has(file.path) || !inShareInbox(file.path, deps.settings().readerPane.shareInbox)) return;
        handled.add(file.path);
        void look(file);
      }),
    );
  });
}
