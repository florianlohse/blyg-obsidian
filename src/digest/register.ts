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
import { DigestConfirmModal, DigestConsentModal, DigestTimeModal } from "../ui/DigestModals";
import { trailText } from "./trailText";
import { setConsentGate } from "./consentGate";
import { setSyncCheck } from "./syncCheck";
import { editorIdFor, withEditor } from "./editorRun";
import { cachedSections as cachedSectionsOf, clearBodies, normaliseEndpoint } from "./llm";
import { TextModal } from "../ui/TextModal";
import { emptyStore, parseStore, type LlmDeps, type LlmStore } from "./llm";
import { History } from "./history";
import { ChangeNotes, type NoteDeps } from "./changeNotes";
import { autoDue } from "./autoWrite";
import { createDigestRefresh, type DigestReader } from "../app/readerRefresh";
import { noteListLoaded, sessionSync } from "../ui/readerStart";
import { SyncedDigest, type SyncFs } from "./sync/store";
import { dataPort, type DataIo } from "./sync/dataPort";
import { sharedStore, writeShared } from "./sync/aiWrite";
import { deviceId } from "./sync/device";
import { syncLines } from "./sync/line";
import { seedSaved } from "../ui/readerStart";
import { type EventRef } from "obsidian";
import type { ShelfFacade } from "../app/shelfService";

export interface DigestDeps {
  /** The reader's saved list (plugin storage), or null. */
  /** The reader's font setting (the digest follows it). */
  font: () => ReaderFont;
  /** The setting "Digest time" ("HH:MM", the device's clock). */
  time: () => string;
  /** Change the settings the Daily menu owns (Digest time, Write automatically) and keep them. */
  set?: (patch: Partial<Pick<BlygSettings["digest"], "time" | "autoWrite">>) => void;
  readList: () => Promise<{ posts: ReadingPost[]; mentions: InboundMention[]; savedAt: number; studioOrigin: string } | null>;
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
  /** The shelf (SH1): the quick menu's "Save for later". Absent: no such entry. */
  shelf?: ShelfFacade;
  /** Reads one revised post's change notes from the Studio (`importedNotes`); absent: corrections show no note. */
  notes?: NoteDeps["fetch"];
  /** The plugin's data.json (read fresh, written by read-modify-write only): the Daily's second sync transport. Absent: the digest folder only. */
  data?: DataIo;
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
  const me = { id: meId };
  const readJson = async (p: string): Promise<unknown> => ((await adapter.exists(p)) ? (JSON.parse(await adapter.read(p)) as unknown) : null);
  const sync = new SyncedDigest(fs, normalizePath(`${base()}/digest`), me, () => Date.now(), {
    editions: () => readJson(normalizePath(`${base()}/digest-editions.json`)),
    history: () => readJson(normalizePath(`${base()}/digest-history.json`)),
    entries: async () => (await loadLocal()).entries,
  }, deps.data ? dataPort(deps.data) : undefined);
  setSyncCheck(async () => ({ devices: await sync.devicesSeen(), ownKeyBytes: sync.ownKeyBytes() }));
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
    sync: { load: () => sync.load(), save: (s) => sync.save(s), hold: (id) => sync.hold(id) },
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
              return cachedStories(withEditor(llm, editorIdFor(rec)), rec, c);
            },
            cachedSections: async (c, singles) => {
              const rec = await editions.current();
              return recordSections(rec, c, singles) ?? (await cachedSectionsOf(withEditor(llm, editorIdFor(rec)), c, singles));
            },
            autoOn: async () => {
              const s = llmSettings();
              const h = normaliseEndpoint(s.endpoint)?.host;
              return s.useAi && s.autoWrite && !!h && (await loadStore()).consent?.host === h;
            },
            autoDue: async (c) => {
              const st = await loadStore();
              return editions.claimAuto((rec) => autoDue(llmSettings(), rec, st, c.length));
            },
            write: (c, singles, opts) => writeShared({ llm, settings: llmSettings, editions, history, sync, now: () => Date.now(), voiceOf: (rec) => editorIdFor(rec), withVoice: withEditor }, c, singles, opts),
          },
        }
      : {}),
    history: () => history.list(),
    // The Daily's hamburger menu (ui/digestMenu.ts): Digest time and Write automatically live here; Show what the digest sent and the billing line need the AI layer.
    menu: {
      time: () => deps.time(),
      pickTime: (done) => new DigestTimeModal(plugin.app, deps.time(), (t) => (t !== null && deps.set?.({ time: t }), done())).open(),
      autoWrite: () => (ai?.settings().useAi === true && deps.set ? ai.settings().autoWrite : null),
      setAutoWrite: (on) => deps.set?.({ autoWrite: on }),
      ...(llm ? { showSent: () => showSent(), monthCost: () => sync.monthCost(Date.now()) } : {}),
      settings: () => {
        // Obsidian's own settings window, on this plugin's tab (an internal handle: when it is absent nothing happens).
        const setting = (plugin.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
        setting?.open();
        setting?.openTabById(plugin.manifest.id);
      },
    },
    syncLines: async (id) => (await sync.refresh().catch(() => undefined), syncLines(sync.info(id), id)),
    // The Daily re-reads the synced files when the app comes to the front and on the vault's "raw" event (both below). While the Daily is open, a fallback every 30 s while it is visible
    // (a local list and stat of a few small files, no network) catches a changed file where neither event was reported.
    watchSync: (fn) => {
      const off = sync.onChange(fn);
      const t = window.setInterval(() => void (activeDocument.visibilityState === "visible" && sync.refresh().catch(() => undefined)), SYNC_FALLBACK_MS);
      // A first open that is still checking for the other devices: read data.json again every second, and draw once the bound has passed (the edition is then made here).
      let waiting = false;
      const h = window.setInterval(() => {
        const was = waiting;
        waiting = sync.holding();
        if (waiting) void sync.refresh().catch(() => undefined);
        else if (was) fn(); // the bound has passed: draw again, the edition is made here now
      }, 1000);
      return () => (off(), window.clearInterval(t), window.clearInterval(h));
    },
    loadList: async () => seedSaved(await deps.readList()),
    ...(deps.reader ? { refresh: createDigestRefresh(deps.reader, Date.now, (l, origin, at) => noteListLoaded({ posts: l.posts, mentions: l.mentions, savedAt: at, studioOrigin: origin }), sessionSync) } : {}),
    ...(changeNotes ? { changeNote: (p: ReadingPost) => changeNotes.get(p) } : {}),
    ...(deps.markRead ? { markRead: deps.markRead } : {}),
    ...(deps.markUnread ? { markUnread: deps.markUnread } : {}),
    ...(deps.replyTo ? { replyTo: deps.replyTo } : {}),
    ...(deps.shelf ? { shelf: deps.shelf } : {}),
    edition: (posts) => editions.open(posts),
    font: () => deps.font(),
    showFeed: async (leaf) => void (await leaf.setViewState({ type: BLYG_READER_VIEW, active: true })),
    openPost: async (post, leaf, order) => {
      await leaf.setViewState({ type: BLYG_READER_VIEW, active: true });
      if (!(leaf.view instanceof BlygReaderView)) return;
      leaf.view.returnTo.set(() => void leaf.setViewState({ type: BLYG_DAILY_VIEW, active: true }));
      leaf.view.walk.set(order ?? null); // Next and Previous walk the Daily's order, top to bottom (one rule for a story's post and a single post alike)
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
  const dataPath = (): string => normalizePath(`${base()}/data.json`);
  let timer: number | null = null;
  const onRaw = (path: string): void => {
    if (path === dataPath() ? false : !sync.isStateFile(path) || sync.isOwnFile(path)) return;
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
  // The header has ONE update action (the refresh icon); the other actions stay reachable here.
  const dailyView = (): BlygDailyView | null => (plugin.app.workspace.getLeavesOfType(BLYG_DAILY_VIEW)[0]?.view as BlygDailyView | undefined) ?? null;
  plugin.addCommand({ id: "refresh-daily", name: "Refresh the digest", callback: () => void dailyView()?.refreshNow() });
  if (llm) {
    plugin.addCommand({ id: "write-digest", name: "Write the digest", callback: () => void dailyView()?.writeFromCommand(false) });
    plugin.addCommand({ id: "resort-digest", name: "Re-sort digest sections", callback: () => void dailyView()?.writeFromCommand(true) });
  }
  const showSent = (): void => void loadStore().then((st) => new TextModal(plugin.app, "What the digest sent", "Time, model, host, tokens and a rough cost for each run, and the text of the last three requests, kept on this device only. No key is kept here.", trailText(st), (ok) => new Notice(ok ? "Copied." : "Copy is blocked here; the text is selected.")).open());
  if (llm) plugin.addCommand({ id: "show-digest-sent", name: "Show what the digest sent", callback: showSent });
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
