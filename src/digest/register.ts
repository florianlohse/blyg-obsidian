// Wires the Daily into the plugin: the view, the command, the ribbon icon. The Daily is made of editions (edition.ts): the records of the current ones are
// kept in plugin storage (`digest-editions.json`, ids only). New file so main.ts only grows by one call.
import { normalizePath, type Plugin } from "obsidian";
import { BLYG_READER_VIEW, BlygReaderView } from "../ui/ReaderView";
import { BLYG_DAILY_VIEW, BlygDailyView, type DigestHost } from "../ui/DigestView";
import type { InboundMention, ReadingPost } from "../studio/reading";
import { Editions, cachedStories, recordSections, rememberWrite } from "./editionHost";
import { existingSections } from "./sectionRecord";
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
import { cachedSections as cachedSectionsOf, clearBodies, normaliseEndpoint } from "./llm";
import { TextModal } from "../ui/TextModal";
import { emptyStore, parseStore, writeDigest, type LlmDeps, type LlmStore } from "./llm";
import { History, buildPast } from "./history";
import { ChangeNotes, type NoteDeps } from "./changeNotes";
import { addUsage, autoDue, ceilingRefusal } from "./autoWrite";
import { createDigestRefresh, type DigestReader } from "../app/readerRefresh";
import { noteListLoaded, sessionSync } from "../ui/readerStart";

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
  const editionsPath = (): string => normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/digest-editions.json`);
  const editions = new Editions({
    read: async () => ((await plugin.app.vault.adapter.exists(editionsPath())) ? (JSON.parse(await plugin.app.vault.adapter.read(editionsPath())) as unknown) : null),
    write: (text) => plugin.app.vault.adapter.write(editionsPath(), text),
    now: () => Date.now(),
    time: () => deps.time(),
  });
  const historyPath = (): string => normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/digest-history.json`);
  const history = new History({
    read: async () => ((await plugin.app.vault.adapter.exists(historyPath())) ? (JSON.parse(await plugin.app.vault.adapter.read(historyPath())) as unknown) : null),
    write: (text) => plugin.app.vault.adapter.write(historyPath(), text),
  });
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
    ...(llm
      ? {
          ai: {
            enabled: () => ai?.settings().useAi === true,
            cached: async (c) => cachedStories(llm, await editions.current(), c),
            cachedSections: async (c, singles) => recordSections(await editions.current(), c, singles) ?? (await cachedSectionsOf(llm, c, singles)),
            autoDue: async (c) => {
              const st = await loadStore();
              return editions.claimAuto((rec) => autoDue(llmSettings(), rec, st, c.length));
            },
            write: async (c, singles, opts) => {
              const rec = await editions.current();
              const auto = opts?.auto === true;
              const st = auto ? await loadStore() : null;
              // An automatic run never asks (no consent: nothing is sent), never shows the confirm line, and keeps to the daily ceiling.
              const run: LlmDeps = auto ? { ...llm, askConsent: () => Promise.resolve(false) } : llm;
              const o = await writeDigest(run, c, { singles, existing: existingSections(rec, c, singles), resort: opts?.resort === true, ...(auto && st ? { confirm: false, gate: (e) => ceilingRefusal(llmSettings(), st, Date.now(), e) } : {}) });
              if (rec) {
                await rememberWrite(llm, editions, rec.id, c, o, singles);
                if (o.status === "ok") {
                  if (o.tokens) await editions.update(rec.id, (e) => ({ ...e, usage: addUsage(e.usage, o.tokens ?? 0, o.cost ?? null) }));
                  if (o.written.some(Boolean)) await history.put(buildPast(rec.id, c, o, singles, Date.now()));
                } else if (auto) await editions.update(rec.id, (e) => ({ ...e, auto: { note: o.status === "failed" ? `The automatic write did not work: ${o.note ?? "no reason given"}` : (o.note ?? "Not written automatically.") } }));
              }
              return o;
            },
          },
        }
      : {}),
    history: () => history.list(),
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
