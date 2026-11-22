// Wires the Daily into the plugin: the view, the command, the ribbon icon. The Daily is one digest per local calendar day and remembers nothing between
// openings. New file so main.ts only grows by one call.
import { normalizePath, type Plugin } from "obsidian";
import { BLYG_READER_VIEW, BlygReaderView } from "../ui/ReaderView";
import { BLYG_DAILY_VIEW, BlygDailyView, type DigestHost } from "../ui/DigestView";
import type { InboundMention, ReadingPost } from "../studio/reading";
import { dayWindow } from "./window";
import type { ReaderFont } from "../ui/readerFonts";
import { Notice } from "obsidian";
import type { Keychain } from "../platform/ports";
import type { RawTransport } from "../platform/http";
import type { BlygSettings } from "../settings/schema";
import { DigestReceiptModal, trailText } from "../ui/DigestReceiptModal";
import { TextModal } from "../ui/TextModal";
import { cachedDigest, emptyStore, parseStore, writeDigest, type LlmDeps, type LlmStore } from "./llm";

export interface DigestDeps {
  /** The reader's saved list (plugin storage), or null. */
  /** The reader's font setting (the digest follows it). */
  font: () => ReaderFont;
  readList: () => Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
  /** The optional AI layer. Absent: no AI. */
  ai?: { settings: () => BlygSettings["digest"]; keychain: Keychain; transport: RawTransport };
}

export function registerDigest(plugin: Plugin, deps: DigestDeps): void {
  const storePath = (): string => normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/digest-ai.json`);
  const loadStore = async (): Promise<LlmStore> => {
    try {
      const adapter = plugin.app.vault.adapter;
      return (await adapter.exists(storePath())) ? parseStore(JSON.parse(await adapter.read(storePath())) as unknown) : emptyStore();
    } catch {
      return emptyStore();
    }
  };
  const ai = deps.ai;
  const llm: LlmDeps | null = ai
    ? {
        settings: () => ai.settings(),
        transport: ai.transport,
        getKey: () => {
          const name = ai.settings().keySecretName;
          return name !== "" && ai.keychain.available() ? ai.keychain.get(name) : null;
        },
        confirm: (receipt) => new Promise<boolean>((resolve) => new DigestReceiptModal(plugin.app, receipt, resolve).open()),
        load: loadStore,
        save: (store) => plugin.app.vault.adapter.write(storePath(), JSON.stringify(store)),
        now: () => Date.now(),
      }
    : null;
  const host: DigestHost = {
    ...(llm ? { ai: { enabled: () => ai?.settings().useAi === true, cached: (c) => cachedDigest(llm, c), write: (c) => writeDigest(llm, c) } } : {}),
    loadList: () => deps.readList(),
    window: () => Promise.resolve(dayWindow(Date.now())),
    font: () => deps.font(),
    showFeed: async (leaf) => void (await leaf.setViewState({ type: BLYG_READER_VIEW, active: true })),
    openPost: async (post, leaf) => {
      await leaf.setViewState({ type: BLYG_READER_VIEW, active: true });
      if (!(leaf.view instanceof BlygReaderView)) return;
      leaf.view.returnTo.set(() => void leaf.setViewState({ type: BLYG_DAILY_VIEW, active: true }));
      leaf.view.openPost(post);
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
  plugin.addCommand({
    id: "show-digest-sent",
    name: "Show what the digest sent",
    callback: () => void loadStore().then((st) => new TextModal(plugin.app, "What the digest sent", "Time, model, host, sizes and post ids. No post text and no key is kept here.", trailText(st), (ok) => new Notice(ok ? "Copied." : "Copy is blocked here; the text is selected.")).open()),
  });
  plugin.addRibbonIcon("newspaper", "Open Blyg Daily", () => void open());
}
