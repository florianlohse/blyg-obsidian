// Wires the Daily into the plugin: the view, the command, the ribbon icon, and the memory of when it was last opened (one small file in the plugin's own
// folder, never in the vault). New file so main.ts only grows by one call.
import { normalizePath, type Plugin } from "obsidian";
import { BLYG_READER_VIEW, BlygReaderView } from "../ui/ReaderView";
import { BLYG_DAILY_VIEW, BlygDailyView, type DigestHost } from "../ui/DigestView";
import type { InboundMention, ReadingPost } from "../studio/reading";
import { nextWindow, parseDailyState } from "./window";
import { Notice } from "obsidian";
import type { Keychain } from "../platform/ports";
import type { RawTransport } from "../platform/http";
import type { BlygSettings } from "../settings/schema";
import { DigestConfirmModal, DigestConsentModal } from "../ui/DigestModals";
import { trailText } from "./trailText";
import { setConsentGate } from "./consentGate";
import { clearBodies, normaliseEndpoint } from "./llm";
import { TextModal } from "../ui/TextModal";
import { cachedDigest, emptyStore, parseStore, writeDigest, type LlmDeps, type LlmStore } from "./llm";

export interface DigestDeps {
  /** The reader's saved list (plugin storage), or null. */
  readList: () => Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
  /** The optional AI layer. Absent: no AI. */
  ai?: { settings: () => BlygSettings["digest"]; keychain: Keychain; transport: RawTransport };
}

export function registerDigest(plugin: Plugin, deps: DigestDeps): void {
  const statePath = (): string => normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/daily-state.json`);
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
        confirm: (estimate) => new Promise<boolean>((resolve) => new DigestConfirmModal(plugin.app, estimate, resolve).open()),
        askConsent: (hostName) => new Promise<boolean>((resolve) => new DigestConsentModal(plugin.app, hostName, resolve).open()),
        load: loadStore,
        save: (store) => plugin.app.vault.adapter.write(storePath(), JSON.stringify(store)),
        now: () => Date.now(),
      }
    : null;
  // The settings toggle "Use an AI model" asks here before it turns on; the agreement is recorded for the endpoint's host (a different host asks again at the next run).
  setConsentGate(async () => {
    if (!llm) return false;
    const host = normaliseEndpoint(llm.settings().endpoint)?.host;
    if (!host) return false;
    const store = await loadStore();
    if (store.consent?.host === host) return true;
    if (!(await llm.askConsent(host, llm.settings().model.trim()))) return false;
    store.consent = { host, model: llm.settings().model.trim(), at: llm.now() };
    await llm.save(store);
    return true;
  });
  const host: DigestHost = {
    ...(llm ? { ai: { enabled: () => ai?.settings().useAi === true, cached: (c) => cachedDigest(llm, c), write: (c) => writeDigest(llm, c) } } : {}),
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
  if (llm) plugin.addCommand({
    id: "show-digest-sent",
    name: "Show what the digest sent",
    callback: () => void loadStore().then((st) => new TextModal(plugin.app, "What the digest sent", "Time, model, host, tokens and a rough cost for each run, and the text of the last three requests, kept on this device only. No key is kept here.", trailText(st), (ok) => new Notice(ok ? "Copied." : "Copy is blocked here; the text is selected.")).open()),
  });
  plugin.addCommand({
    id: "clear-digest-requests",
    name: "Clear stored requests",
    callback: () =>
      void loadStore().then(async (st) => {
        clearBodies(st);
        await plugin.app.vault.adapter.write(storePath(), JSON.stringify(st));
        new Notice("The stored digest requests were removed.");
      }),
  });
  plugin.addRibbonIcon("newspaper", "Open Blyg Daily", () => void open());
}
