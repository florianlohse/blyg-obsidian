// Wires the Daily into the plugin: the view, the command, the ribbon icon. The Daily is made of editions (edition.ts): the records of the current ones are
// kept in plugin storage (`digest-editions.json`, ids only). New file so main.ts only grows by one call.
import { normalizePath, type Plugin } from "obsidian";
import { BLYG_READER_VIEW, BlygReaderView } from "../ui/ReaderView";
import { BLYG_DAILY_VIEW, BlygDailyView, type DigestHost } from "../ui/DigestView";
import type { InboundMention, ReadingPost } from "../studio/reading";
import { Editions, cachedStories, recordSections } from "./editionHost";
import { useReaderMode, type ModeStore } from "../ui/readerMode";
import { placedSection } from "./placement";
import { setDigestChips } from "../ui/readerDigestChip";
import { sectionOfPost } from "./postSection";
import { requestJump } from "./scrollMemory";
import type { ReaderFont } from "../ui/readerFonts";
import { Notice } from "obsidian";
import type { Keychain } from "../platform/ports";
import type { RawTransport } from "../platform/http";
import type { BlygSettings } from "../settings/schema";
import { DigestConfirmModal, DigestConsentModal } from "../ui/DigestModals";
import { trailText } from "./trailText";
import { setConsentGate } from "./consentGate";
import { setSyncCheck } from "./syncCheck";
import { editorIdFor, withEditor } from "./editorRun";
import { editorFor, NEUTRAL } from "./editors";
import { cachedSections as cachedSectionsOf, clearBodies, normaliseEndpoint } from "./llm";
import { TextModal } from "../ui/TextModal";
import { emptyStore, parseStore, type LlmDeps, type LlmStore } from "./llm";
import { History } from "./history";
import { ChangeNotes, type NoteDeps } from "./changeNotes";
import { autoDue } from "./autoWrite";
import { createDigestRefresh, type DigestReader } from "../app/readerRefresh";
import { noteListLoaded, sessionSync } from "../ui/readerStart";
import { SyncedDigest, type SyncFs } from "./sync/store";
import { sharedStore, writeShared } from "./sync/aiWrite";
import { deviceId, deviceLabel } from "./sync/device";
import { syncLines } from "./sync/line";
import { Platform, type EventRef } from "obsidian";

export interface DigestDeps {
  /** The reader's saved list (plugin storage), or null. */
  /** The reader's font setting (the digest follows it). */
  font: () => ReaderFont;
  /** The setting "Digest time" ("HH:MM", the device's clock). */
  time: () => string;
  readList: () => Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number } | null>;
  /** The reader's Studio conversation, so the digest's Refresh is the feed's Refresh (app/readerRefresh.ts). Absent: Refresh only reads the saved list again. */
  reader?: DigestReader;
  /** The reader's mode (Feed or Digest), kept in the settings (ui/readerMode.ts). */
  mode: ModeStore;
  /** The reader's own mark-read path (`reading:state`), used by the digest's "Mark read" buttons. Absent: no buttons. */
  markRead?: (post: ReadingPost) => Promise<{ ok: boolean; message?: string }>;
  /** The reader's own reply path (the quick menu's Reply). Absent: no Reply there. */
  replyTo?: (post: ReadingPost) => Promise<void>;
  /** The reader's own mark-unread path (same permission): the digest's read symbol puts a mark back. */
  markUnread?: (post: ReadingPost) => Promise<{ ok: boolean; message?: string }>;
  /** Reads one revised post's change notes from the Studio (`importedNotes`); absent: corrections show no note. */
  notes?: NoteDeps["fetch"];
  /** The optional AI layer. Absent: no AI. */
  ai?: { settings: () => BlygSettings["digest"]; keychain: Keychain; transport: RawTransport };
}

/** The fallback re-read of the synced files while the Daily is open (the events are the main way). */
export const SYNC_FALLBACK_MS = 30_000;

export function registerDigest(plugin: Plugin, deps: DigestDeps): void {
  const base = (): string => plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  // The Daily's state is shared by every device through files in the plugin folder, each device writing only its own (src/digest/sync, docs/ARCHITECTURE.md).
  const adapter = plugin.app.vault.adapter;
  const fs: SyncFs = {
    list: async (dir) => ((await adapter.exists(dir)) ? (await adapter.list(dir)).files : []),
    read: (p) => adapter.read(p),
    write: (p, t) => adapter.write(p, t),
    mkdir: async (dir) => void ((await adapter.exists(dir)) || (await adapter.mkdir(dir))),
    remove: (p) => adapter.remove(p),
    stat: async (p) => {
      const st = await adapter.stat(p);
      return st ? { mtime: st.mtime, size: st.size } : null;
    },
  };
  // This device's own storage (never synced). Where it is not there the id lasts for the session only.
  const local = {
    load: (k: string): unknown => {
      try {
        return plugin.app.loadLocalStorage(k) as unknown;
      } catch {
        return null;
      }
    },
    save: (k: string, v: string | null): void => {
      try {
        plugin.app.saveLocalStorage(k, v);
      } catch {
        /* session only */
      }
    },
  };
  const meId = deviceId(local, (n) => crypto.getRandomValues(new Uint8Array(n)));
  // The name set under Daily → "This device's name", else the platform's; a short suffix from the id only when another synced device has the same platform name.
  const me = { id: meId, label: (taken?: readonly string[]) => deviceLabel(local, Platform, meId, taken) };
  const readJson = async (p: string): Promise<unknown> => ((await adapter.exists(p)) ? (JSON.parse(await adapter.read(p)) as unknown) : null);
  const sync = new SyncedDigest(fs, normalizePath(`${base()}/digest`), me, () => Date.now(), {
    editions: () => readJson(normalizePath(`${base()}/digest-editions.json`)),
    history: () => readJson(normalizePath(`${base()}/digest-history.json`)),
    entries: async () => (await loadLocal()).entries,
  });
  setSyncCheck(() => sync.devicesSeen());
  const storePath = (): string => normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/digest-ai.json`);
  const loadLocal = async (): Promise<LlmStore> => {
    try {
      return (await adapter.exists(storePath())) ? parseStore(JSON.parse(await adapter.read(storePath())) as unknown) : emptyStore();
    } catch {
      return emptyStore();
    }
  };
  const editions = new Editions({
    read: async () => null, // the synced store replaces it; the old digest-editions.json is read once by the migration and stays where it is
    write: () => Promise.resolve(),
    sync: { load: () => sync.load(), save: (s) => sync.save(s) },
    now: () => Date.now(),
    time: () => deps.time(),
  });
  const history = new History({ read: async () => null, write: () => Promise.resolve(), sync: { list: () => sync.history(), put: (r) => sync.putHistory(r) } });
  // The AI texts (and the sections cache) are content-keyed: what any device wrote is used by every device, so a text is paid for once (sync/aiWrite.ts).
  const shared = sharedStore(sync, editions, { load: loadLocal, save: (st) => adapter.write(storePath(), JSON.stringify(st)) });
  const loadStore = shared.load;
  const saveStore = shared.save;
  const notesPath = (): string => normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/digest-notes.json`);
  const changeNotes = deps.notes
    ? new ChangeNotes({ fetch: deps.notes, load: async () => ((await plugin.app.vault.adapter.exists(notesPath())) ? (JSON.parse(await plugin.app.vault.adapter.read(notesPath())) as unknown) : null), save: (t) => plugin.app.vault.adapter.write(notesPath(), t) })
    : null;
  const llmSettings = (): BlygSettings["digest"] => (ai ? ai.settings() : { useAi: false, endpoint: "", model: "", keySecretName: "", dailyTokenCeiling: 0, autoWrite: false, time: "07:00" });
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
        save: saveStore,
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
    ...(llm
      ? {
          ai: {
            enabled: () => ai?.settings().useAi === true,
            cached: async (c) => {
              const rec = await editions.current();
              return cachedStories(withEditor(llm, editorIdFor(rec, ai?.settings().editor)), rec, c);
            },
            cachedSections: async (c, singles) => {
              const rec = await editions.current();
              return recordSections(rec, c, singles) ?? (await cachedSectionsOf(withEditor(llm, editorIdFor(rec, ai?.settings().editor)), c, singles));
            },
            autoDue: async (c) => {
              const st = await loadStore();
              return editions.claimAuto((rec) => autoDue(llmSettings(), rec, st, c.length));
            },
            sharedToday: async () => (await sync.usedToday(Date.now()))?.total ?? null,
            write: (c, singles, opts) => writeShared({ llm, settings: llmSettings, editions, history, sync, now: () => Date.now(), voiceOf: (rec, resort) => (resort && rec ? (editorFor(ai?.settings().editor, rec.id)?.id ?? NEUTRAL) : editorIdFor(rec, ai?.settings().editor)), withVoice: withEditor }, c, singles, opts),
          },
        }
      : {}),
    history: () => history.list(),
    syncLines: async (id) => (await sync.refresh().catch(() => undefined), syncLines(sync.info(id), id)),
    // The Daily re-reads the synced files when the app comes to the front and on the vault's "raw" event (both below). While the Daily is open, a fallback every 30 s while it is visible
    // (a local list and stat of a few small files, no network) catches a changed file where neither event was reported.
    watchSync: (fn) => {
      const off = sync.onChange(fn);
      const t = window.setInterval(() => void (activeDocument.visibilityState === "visible" && sync.refresh().catch(() => undefined)), SYNC_FALLBACK_MS);
      return () => (off(), window.clearInterval(t));
    },
    loadList: () => deps.readList(),
    ...(deps.reader ? { refresh: createDigestRefresh(deps.reader, Date.now, (l, origin, at) => noteListLoaded({ posts: l.posts, mentions: l.mentions, savedAt: at, studioOrigin: origin }), sessionSync) } : {}),
    ...(changeNotes ? { changeNote: (p: ReadingPost) => changeNotes.get(p) } : {}),
    ...(deps.markRead ? { markRead: deps.markRead } : {}),
    ...(deps.markUnread ? { markUnread: deps.markUnread } : {}),
    ...(deps.replyTo ? { replyTo: deps.replyTo } : {}),
    edition: (posts) => editions.open(posts),
    font: () => deps.font(),
    showFeed: async (leaf) => void (await leaf.setViewState({ type: BLYG_READER_VIEW, active: true })),
    openPost: async (post, leaf, story) => {
      await leaf.setViewState({ type: BLYG_READER_VIEW, active: true });
      if (!(leaf.view instanceof BlygReaderView)) return;
      leaf.view.returnTo.set(() => void leaf.setViewState({ type: BLYG_DAILY_VIEW, active: true }));
      leaf.view.walk.set(story ?? null); // Next and Previous walk that story (a single post: the feed's order, as before)
      leaf.view.openPost(post, "digest");
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
  // A file of another device changed (the synced folder is raw: Obsidian reports it as a "raw" event): read again once it has been quiet for a moment.
  let timer: number | null = null;
  const onRaw = (path: string): void => {
    if (!sync.isStateFile(path) || sync.isOwnFile(path)) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => ((timer = null), void sync.refresh().catch(() => undefined)), 700);
  };
  plugin.registerEvent((plugin.app.vault as unknown as { on(name: "raw", cb: (p: string) => void): EventRef }).on("raw", onRaw));
  plugin.register(() => timer !== null && window.clearTimeout(timer));
  // Files carried in while the app was away (a phone in the pocket) are read when it comes back, if the "raw" event did not say.
  if (typeof activeDocument !== "undefined") plugin.registerDomEvent(activeDocument, "visibilitychange", () => activeDocument.visibilityState === "visible" && void sync.refresh().catch(() => undefined));
  // The reader being opened also starts the day's edition, if its cutoff has passed.
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", (leaf) => void (leaf?.view.getViewType() === BLYG_READER_VIEW && editions.touch())));
  // The reader's "In the digest: <section>" chip: asks the editions held (current, then the history) and opens the Daily in the reader's own leaf, scrolled to the section.
  setDigestChips({
    sectionOf: async (p) => {
      const cur = await editions.current();
      return placedSection(p.remoteId, cur?.id) ?? sectionOfPost(p.remoteId, cur, (await history.list()).editions);
    },
    open: (edition, section) => {
      requestJump(edition, section);
      const leaf = plugin.app.workspace.getLeavesOfType(BLYG_READER_VIEW)[0] ?? plugin.app.workspace.getLeaf("tab");
      void leaf.setViewState({ type: BLYG_DAILY_VIEW, active: true });
    },
  });
  plugin.registerView(BLYG_DAILY_VIEW, (leaf) => new BlygDailyView(leaf, host));
  useReaderMode(deps.mode, open);
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
