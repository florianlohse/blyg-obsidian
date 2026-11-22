// Wires the Daily into the plugin: the view, the command, the ribbon icon, and the memory of when it was last opened (one small file in the plugin's own
// folder, never in the vault). New file so main.ts only grows by one call.
import { normalizePath, type Plugin } from "obsidian";
import { BLYG_READER_VIEW, BlygReaderView } from "../ui/ReaderView";
import { BLYG_DAILY_VIEW, BlygDailyView, type DigestHost } from "../ui/DigestView";
import type { InboundMention, ReadingPost } from "../studio/reading";
import { nextWindow, parseDailyState } from "./window";

export interface DigestDeps {
  /** The reader's saved list (plugin storage), or null. */
  readList: () => Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
}

export function registerDigest(plugin: Plugin, deps: DigestDeps): void {
  const statePath = (): string => normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/daily-state.json`);
  const host: DigestHost = {
    loadList: () => deps.readList(),
    window: async () => {
      const now = Date.now();
      let prev = null;
      try {
        const adapter = plugin.app.vault.adapter;
        if (await adapter.exists(statePath())) prev = parseDailyState(JSON.parse(await adapter.read(statePath())) as unknown, now);
      } catch {
        prev = null;
      }
      const next = nextWindow(prev, now);
      return { since: next.since, until: now, commit: () => plugin.app.vault.adapter.write(statePath(), JSON.stringify(next.state)) };
    },
    openPost: async (post) => {
      const { workspace } = plugin.app;
      let leaf = workspace.getLeavesOfType(BLYG_READER_VIEW)[0];
      if (!leaf) {
        leaf = workspace.getLeaf("tab");
        await leaf.setViewState({ type: BLYG_READER_VIEW, active: true });
      }
      await workspace.revealLeaf(leaf);
      if (leaf.view instanceof BlygReaderView) leaf.view.openPost(post);
    },
    openWeb: (url) => window.open(url, "_blank"),
  };
  const open = async (): Promise<void> => {
    const { workspace } = plugin.app;
    const existing = workspace.getLeavesOfType(BLYG_DAILY_VIEW)[0];
    if (existing) return void (await workspace.revealLeaf(existing));
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: BLYG_DAILY_VIEW, active: true });
    await workspace.revealLeaf(leaf);
  };
  plugin.registerView(BLYG_DAILY_VIEW, (leaf) => new BlygDailyView(leaf, host));
  plugin.addCommand({ id: "open-daily", name: "Open Daily", callback: () => void open() });
  plugin.addRibbonIcon("newspaper", "Open Blyg Daily", () => void open());
}
