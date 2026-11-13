import { debounce, MarkdownView, moment, normalizePath, Notice, Plugin, type Editor, type TAbstractFile, type TFile } from "obsidian";
import { activeBranch, activeChannel, describeTarget } from "./app/publishSettings";
import { buildImportDeps, runStudioLookup, runStudioReplyTarget, runStudioHoppers, runTakeHoppers, runDeleteDraft, runFetchQuotable, runPublish, runPull, runRepost, runStudioFacts, runStudioQuotable, runStudioSearch, runStudioWarnings, runWithdraw, type AppEnv } from "./app/run";
import { watchCommit } from "./app/deploy";
import { adoptOldInstall, isPluginEnabled, OLD_PLUGIN_ID } from "./app/adoptOldInstall";
import { loadPanelState, type PanelState } from "./app/panelState";
import { createDataUpdater } from "./app/dataUpdater";
import { createDataWatch } from "./app/dataWatch";
import { createDeployMemory } from "./app/deployMemory";
import { TM } from "./app/threadMessages";
import { expandTemplate, newItemText, templatePath, type ItemKind, type TemplateProblem } from "./app/itemTemplate";
import { blockToInsert, embedReplacement, extractedItemBody, extractionVerdict, newItemName, pickerCandidates, quoteBlock, quoteBlockOf, renamedForThread, threadConversion, type PickerEntry, type QuoteChoice } from "./app/threadCommands";
import { localKind } from "./core/blyg";
import { isBlygId } from "./core/ids";
import { newItemRoute, routeFor } from "./core/routes";
import { createPublishedStore, foldOldFile, isOwnFormat, type PublishedStore } from "./app/publishedStore";
import { checkConnection, formatReport, type ConnectionReport } from "./github/connection";
import { studioAddress } from "./studio/address";
import { repostMap, repostMapText } from "./studio/repostMap";
import { TextModal } from "./ui/TextModal";
import { openWebQuote } from "./ui/WebQuoteModal";
import { endOf, planInsert } from "./core/webQuote";
import { checkStudioConnection } from "./studio/connection";
import { contractCacheFor } from "./studio/client";
import type { DigestCache } from "./studio/media";
import type { ContractVerdict } from "./studio/version";
import { createPendingDrafts, type PendingDrafts } from "./studio/pending";
import { createLiveCache } from "./studio/live";
import { vaultPicks, writtenRef, type StudioPick, type StudioVaultNote } from "./studio/picker";
import { actionsUrlOf } from "./github/deployStatus";
import { createGithubHttp } from "./platform/http";
import { obsidianKeychain, obsidianNotifier, systemClock, webRandom, windowTimers } from "./platform/obsidianPorts";
import { obsidianTransport } from "./platform/obsidianTransport";
import { createSiteReader } from "./platform/siteReader";
import { noteRefOf, obsidianBinaryVault, obsidianNoteEdit, obsidianVault, obsidianYaml } from "./platform/obsidianVault";
import { redactingLogger } from "./platform/redact";
import type { Outcome } from "./publish/types";
import { migrateSettings } from "./settings/migrate";
import { devGuardProblem, isDevBuildId, isDevStudioLock, realPluginId, setDevStudioLock } from "./studio/devLock";
import { defaultSettings, type BlygSettings } from "./settings/schema";
import { isStudioOnly } from "./settings/studioOnly";
import { BlygSettingTab } from "./settings/tab";
import { BLYG_PANEL_VIEW, BlygPanelView, type PanelHost } from "./ui/BlygPanelView";
import { promptForItem, promptForQuote } from "./ui/QuotePicker";
import { promptForStudioItem } from "./ui/StudioPicker";
import { BLYG_READER_VIEW, BlygReaderView, excerptOf, type ReaderHost } from "./ui/ReaderView";
import { buildStudio } from "./app/run";
import type { ReadingPost } from "./studio/reading";
import { confirmWithModal } from "./ui/WritePreviewModal";
import { chooseImports } from "./ui/ImportModal";
import { chooseHoppers } from "./ui/HopperModal";
import { STUB_KEY, looksLikeAddress, stubLabel, stubProperty, type StubTarget } from "./studio/stub";
import { readStudioRecord } from "./studio/record";
import { HOPPERS_KEY, readHopperNames } from "./studio/hoppers";
import { readIgnored, updateIgnored } from "./app/importIgnore";
import { importStudioItems, scanStudioImport, type NoteFiles } from "./publish/studioImport";
import { importFolderChoices, importRoute } from "./studio/import";
import { extractFrontmatterBlock, isRecord } from "./core/frontmatter";
import { M } from "./publish/messages";

/** How often the panel looks at data.json's modified time while it is on screen: a stat call, no reading, no network. */
const DATA_LOOK_MS = 15_000;

export default class BlygPlugin extends Plugin {
  override settings: BlygSettings = defaultSettings();
  /** Set when data.json was written by a newer plugin version: we must not save over it. */
  private settingsLocked = false;
  private settingTab: BlygSettingTab | null = null;
  /** The newest commit this session made and what became of its deploy (not saved: it is about this session). */
  private lastCommit: { branch: string; sha: string; version?: number; path?: string } | null = null;
  /** What the panel shows about that commit's deploy (waiting, or the verdict). */
  private readonly deploys = createDeployMemory();
  /** What the Studio last said about each item (30 seconds; asked again every 15 s while the panel is on screen, and at once when the app comes back to the foreground), and about the Studio as a whole (token, release): the panel never waits for them. */
  private readonly studioFacts = createLiveCache({
    load: (id: string) => runStudioFacts(this.env(), id),
    now: () => Date.now(),
    ttlMs: (facts) => (facts.item === "unreachable" ? 15_000 : 30_000),
  });
  private readonly studioWarnings = createLiveCache({ load: () => runStudioWarnings(this.env()), now: () => Date.now(), ttlMs: () => 600_000 });
  /** A publish or withdraw is in progress (its window may be open): a second one, from the panel or the palette, must wait. */
  private writing = false;
  private publishedStore: PublishedStore | undefined;
  private pendingStore: PendingDrafts | undefined;
  private unloading = false;
  /** What this session has learnt about each Studio's API contract (the gate, studio/client.ts); "Check connection" asks again. */
  private readonly contractVerdicts = new Map<string, ContractVerdict>();

  override async onload(): Promise<void> {
    // The development build ("blyg-dev") may only talk to test Studios: switched on before anything reads an address (studio/devLock.ts).
    setDevStudioLock(isDevBuildId(this.manifest.id));
    // ... and it stays idle while the real plugin is enabled (the two cannot share the panel view): nothing is registered, nothing is read or written.
    const idle = devGuardProblem(this.manifest.id, isPluginEnabled(this.app, realPluginId(this.manifest.id)));
    if (idle) {
      new Notice(idle, 0);
      return;
    }
    // The old plugin (id obsidian-blyg) registers the same view type: with both enabled this one would fail half-way. Say so and stay idle.
    if (await this.adoptOldInstallData()) return;
    await this.loadSettings();
    void this.migrateOldFiles();
    this.settingTab = new BlygSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerView(BLYG_PANEL_VIEW, (leaf) => new BlygPanelView(leaf, this.panelHost()));
    this.addRibbonIcon("send", "Open panel", () => void this.openPanel());
    this.registerView(BLYG_READER_VIEW, (leaf) => new BlygReaderView(leaf, this.readerHost()));
    this.addCommand({ id: "open-reader-poc", name: "Open reader (proof of concept)", callback: () => void this.openReader() });
    this.registerPanelRefresh();

    this.addCommand({
      id: "insert-web-quote",
      // Set apart from the blyg operations on purpose (Florian, 2026-11-07). "(not a blyg item)" was the first wording; the lint rule that forbids
      // the plugin's name in a command name cannot be disabled in this repository, so the suffix says what the command writes instead.
      name: "Insert web quote (plain Markdown)",
      callback: () => this.insertWebQuote(),
    });
    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => void this.openPanel(),
    });
    this.addCommand({
      id: "publish-active-note",
      name: "Publish active note",
      callback: () => void this.publishActiveNote(),
    });
    this.addCommand({
      id: "repost-to-studio",
      name: "Studio: repost this note",
      checkCallback: (checking) => this.githubCommand(checking, () => void this.repostActiveNote()),
    });
    this.addCommand({
      id: "list-reposted-items",
      name: "Studio: list reposted items",
      checkCallback: (checking) => this.githubCommand(checking, () => this.listRepostedItems()),
    });
    this.addCommand({
      id: "pull-studio-copy",
      name: "Studio: pull the copy into this note",
      callback: () => void this.pullActiveNote(),
    });
    this.addCommand({
      id: "reply-to-item",
      name: "Reply to an item",
      callback: () => void this.replyToItem(),
    });
    this.addCommand({
      id: "make-thread-a-reply",
      name: "Make this thread a reply",
      callback: () => void this.makeActiveThreadAReply(),
    });
    this.addCommand({
      id: "choose-hoppers",
      name: "Studio: choose hoppers for this note",
      callback: () => void this.chooseHoppersForActiveNote(),
    });
    this.addCommand({
      id: "take-studio-hoppers",
      name: "Studio: use the online hoppers for this note",
      callback: () => void this.write(runTakeHoppers),
    });
    this.addCommand({
      id: "import-from-studio",
      name: "Studio: import new items",
      callback: () => void this.importFromStudio(),
    });
    this.addCommand({
      id: "delete-draft-of-active-note",
      name: "Studio: delete the draft of this note",
      callback: () => void this.deleteDraftOfActiveNote(),
    });
    this.addCommand({
      id: "withdraw-active-note",
      name: "Withdraw active note",
      callback: () => void this.withdrawActiveNote(),
    });
    this.addCommand({
      id: "new-thread",
      name: "New thread",
      callback: () => void this.newItem("thread"),
    });
    this.addCommand({
      id: "new-note",
      name: "New fragment",
      callback: () => void this.newItem("fragment"),
    });
    this.addCommand({
      id: "make-thread",
      name: "Make this note a thread",
      callback: () => void this.makeThread(),
    });
    this.addCommand({
      id: "insert-quote",
      name: "Insert quote",
      editorCallback: (editor) => void this.insertQuote(editor),
    });
    this.addCommand({
      id: "insert-item-link",
      name: "Insert link to item",
      editorCallback: (editor) => void this.insertItemLink(editor),
    });
    this.addCommand({
      id: "toggle-target",
      name: "Toggle production/preview",
      checkCallback: (checking) => this.githubCommand(checking, () => void this.toggleTarget()),
    });
    this.addCommand({
      id: "deploy-status",
      name: "Show deploy status",
      checkCallback: (checking) => this.githubCommand(checking, () => void this.showDeployStatus()),
    });
    this.addCommand({
      id: "check-studio-connection",
      name: "Studio: check connection",
      callback: () => {
        void this.runStudioConnectionCheck().then((report) => {
          obsidianNotifier.notice(formatReport(report), report.ok ? 6000 : 12000);
        });
      },
    });
    this.addCommand({
      id: "check-connection",
      name: "Check connection",
      checkCallback: (checking) =>
        this.githubCommand(checking, () => {
          void this.runConnectionCheck().then((report) => {
            obsidianNotifier.notice(formatReport(report), report.ok ? 6000 : 12000);
          });
        }),
    });
  }

  /** A command about GitHub-hosted sites (preview channel, deploy status, GitHub connection, repost): not offered to someone with no GitHub setup (studioOnly.ts). */
  private githubCommand(checking: boolean, run: () => void): boolean {
    if (isStudioOnly(this.settings)) return false;
    if (!checking) run();
    return true;
  }

  /** After the rename from "obsidian-blyg" to "blyg": take over the old install's data.json once (see app/adoptOldInstall.ts). */
  private async adoptOldInstallData(): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    const oldPath = normalizePath(`${this.app.vault.configDir}/plugins/${OLD_PLUGIN_ID}/data.json`);
    const result = await adoptOldInstall({
      ownId: this.manifest.id,
      oldPluginEnabled: () => isPluginEnabled(this.app, OLD_PLUGIN_ID),
      loadOwn: () => this.loadData() as Promise<unknown>,
      saveOwn: (data) => this.saveData(data),
      readOld: async () => ((await adapter.exists(oldPath)) ? adapter.read(oldPath) : null),
    });
    if (result === "old-plugin-enabled") {
      new Notice("Blyg: disable the old Blyg 0.7.0 plugin first (Settings → Community plugins), then reload Obsidian. Nothing was changed.", 0);
      return true;
    }
    if (result === "adopted") new Notice("Blyg: settings taken over from the previous install. You can remove the old plugin now.", 12000);
    if (result === "write-failed") new Notice("Blyg: the settings of the previous install could not be taken over (the file could not be written). Blyg starts with empty settings; the old plugin's data is untouched.", 15000);
    return false;
  }

  async loadSettings(): Promise<void> {
    const loaded = migrateSettings((await this.loadData()) as unknown, isDevStudioLock() ? "dev" : "release");
    this.settings = loaded.settings;
    this.settingsLocked = loaded.fromNewerVersion;
    if (this.settingsLocked) {
      new Notice(
        "Blyg: the settings were saved by a newer version of the plugin. Update the plugin on this device. Settings are read-only until then.",
        15000,
      );
    }
  }

  async saveSettings(): Promise<void> {
    if (this.settingsLocked) return;
    // Merged into what is on disk, so the other keys of data.json (the published records, which Obsidian Sync may have updated since
    // this device loaded) are kept.
    await this.updateData((data) => void Object.assign(data, this.settings));
    // The address or the token entry may have changed: what the Studio said before is about something else.
    this.studioFacts.invalidate();
    this.studioWarnings.invalidate();
    this.refreshPanels();
  }

  /** Every change to data.json goes through here (see app/dataUpdater.ts). */
  private readonly updateData = createDataUpdater(
    { load: () => this.loadData() as Promise<unknown>, save: (data) => this.saveData(data) },
    () => this.settingsLocked,
  );

  /** True while settings cannot be changed because a newer plugin version wrote them. */
  get isSettingsLocked(): boolean {
    return this.settingsLocked;
  }

  /**
   * What the plugin last published for essays and pages: the `published` key of data.json. Obsidian Sync carries data.json to the other
   * devices but not other files in the plugin folder (measured 2026-10-09), so the record lives there. Paths and fingerprints only.
   */
  /** Digests of images already read, shared by the publish and the panel (an unchanged image is not read again). */
  private readonly imageDigests: DigestCache = new Map();

  private published(): PublishedStore {
    // One instance: its queue is what keeps two quick publishes from dropping each other's record.
    this.publishedStore ??= createPublishedStore({
      // Read from disk every time: a record that Sync brought from another device shows without a restart.
      read: async () => {
        const disk = (await this.loadData()) as { published?: unknown } | null;
        return disk && typeof disk === "object" && disk.published !== undefined ? JSON.stringify(disk.published) : null;
      },
      write: (text) => this.updateData((data) => void (data.published = JSON.parse(text) as unknown)),
    });
    return this.publishedStore;
  }

  /**
   * Until 0.0.19 the record was a file of its own (published.json) next to data.json. Fold it into data.json once, then delete it,
   * and delete the probe files of the sync investigation (0.0.18). Best effort: on any problem the old files stay where they are.
   */
  private async migrateOldFiles(): Promise<void> {
    const dir = this.manifest.dir;
    if (!dir || this.settingsLocked) return;
    const adapter = this.app.vault.adapter;
    try {
      const file = `${dir}/published.json`;
      if (await adapter.exists(file)) {
        const text = await adapter.read(file);
        await this.updateData((data) => void (data.published = foldOldFile(data.published, text)));
        if (isOwnFormat(text)) await adapter.remove(file);
      }
      for (const name of ["sync-probe.json", "sync-probe.txt", "sync-probe.md"]) {
        if (await adapter.exists(`${dir}/${name}`)) await adapter.remove(`${dir}/${name}`);
      }
    } catch (err) {
      this.logger().warn(`migrating the old record file failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private logger() {
    return redactingLogger((line) => console.debug(line));
  }

  private http() {
    return createGithubHttp({ transport: obsidianTransport, timers: windowTimers, logger: this.logger() });
  }

  async runConnectionCheck(): Promise<ConnectionReport> {
    const { github } = this.settings;
    return checkConnection({ http: this.http(), keychain: obsidianKeychain(this.app) }, github);
  }

  async runStudioConnectionCheck(): Promise<ConnectionReport> {
    const address = studioAddress(this.settings.studio);
    return checkStudioConnection(
      { transport: obsidianTransport, timers: windowTimers, keychain: obsidianKeychain(this.app), clock: systemClock, logger: this.logger(), ...(address ? { gate: contractCacheFor(this.contractVerdicts, address.apiBase) } : {}) },
      this.settings.studio,
    );
  }

  /** Drafts created in a Studio for notes that are not stamped yet: the `studioDrafts` key of data.json (see studio/pending.ts). */
  private pendingDrafts(): PendingDrafts {
    this.pendingStore ??= createPendingDrafts({
      read: async () => ((await this.loadData()) as { studioDrafts?: unknown } | null)?.studioDrafts,
      change: (edit) => this.updateData(edit),
    });
    return this.pendingStore;
  }

  private env(): AppEnv {
    return {
      settings: this.settings,
      activeNote: () => {
        const file = this.app.workspace.getActiveFile();
        return file ? noteRefOf(file) : null;
      },
      flush: async () => {
        // Typing is saved to disk a moment later; publish what is on screen, not what was saved two seconds ago.
        // From the panel the sidebar is the active view, so fall back to the editor the user was in.
        const recent = this.app.workspace.getMostRecentLeaf()?.view;
        await (this.app.workspace.getActiveViewOfType(MarkdownView) ?? (recent instanceof MarkdownView ? recent : null))?.save();
      },
      keychain: obsidianKeychain(this.app),
      http: this.http(),
      vault: obsidianVault(this.app),
      images: obsidianBinaryVault(this.app),
      imageDigests: this.imageDigests,
      edit: obsidianNoteEdit(this.app),
      yaml: obsidianYaml,
      clock: systemClock,
      random: webRandom,
      site: createSiteReader({ transport: obsidianTransport, timers: windowTimers, logger: this.logger() }),
      logger: this.logger(),
      confirm: (preview) => confirmWithModal(this.app, preview),
      published: this.published(),
      studio: { transport: obsidianTransport, timers: windowTimers, pending: this.pendingDrafts(), contracts: this.contractVerdicts },
    };
  }

  private show(outcome: Outcome): void {
    // Longer for things that need reading: a failure, or several messages.
    const ms = outcome.status === "committed" || outcome.status === "published" ? 12000 : outcome.status === "noop" || outcome.status === "cancelled" ? 6000 : 15000;
    for (const notice of outcome.notices) obsidianNotifier.notice(notice, ms);
  }

  override onunload(): void {
    this.unloading = true;
  }

  private publishActiveNote(): Promise<void> {
    return this.write(runPublish);
  }

  private repostActiveNote(): Promise<void> {
    return this.write(runRepost);
  }

  private pullActiveNote(): Promise<void> {
    return this.write(runPull);
  }

  private withdrawActiveNote(): Promise<void> {
    return this.write(runWithdraw);
  }

  private deleteDraftOfActiveNote(): Promise<void> {
    return this.write(runDeleteDraft);
  }

  /**
   * "Studio: import new items" (roadmap S7): list the Studio's items that have no note, let the owner tick them, make the notes. Nothing is
   * sent to the Studio. `showHidden`: list the items the owner chose not to import as well.
   */
  private async importFromStudio(showHidden = false): Promise<void> {
    if (this.writing) {
      obsidianNotifier.notice("Another publish or withdraw is still in progress. Finish or cancel it first.", 6000);
      return;
    }
    const built = buildImportDeps(this.env(), { files: this.noteFiles(), templateProps: this.importTemplateProps() });
    if (!built.ok) return this.show(built.outcome);
    const ignored = readIgnored(await this.loadData());
    const scan = await scanStudioImport(built.deps, showHidden ? new Set() : ignored);
    if (!scan.ok) return this.show(scan.outcome);
    const { candidates, skipped } = scan.scan;
    const notes = [
      ...(skipped.withdrawn > 0 ? [`${skipped.withdrawn} withdrawn item${skipped.withdrawn === 1 ? " is" : "s are"} not offered.`] : []),
      ...(skipped.unreadable > 0 ? [`${skipped.unreadable} item${skipped.unreadable === 1 ? "" : "s"} could not be read and ${skipped.unreadable === 1 ? "is" : "are"} not offered.`] : []),
      ...(scan.complete ? [] : [M.studioImportIncomplete]),
    ];
    if (candidates.length === 0 && (skipped.ignored === 0 || showHidden)) {
      obsidianNotifier.notice([M.studioImportNone, ...notes].join(" "), 8000);
      return;
    }
    const folders = importFolderChoices(this.settings.routes, "");
    const answer = await chooseImports(this.app, { folder: scan.route.vaultPrefix, folders, candidates, notes, hidden: skipped.ignored, hiddenShown: showHidden });
    if (answer === "show-hidden") return this.importFromStudio(true);
    if (answer === null) {
      obsidianNotifier.notice(M.studioImportCancelled, 6000);
      return;
    }
    try {
      await this.updateData((data) => updateIgnored(data, { add: answer.ignore, remove: answer.chosen }));
    } catch (err) {
      this.logger().warn(`saving the import's ignore list failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (answer.chosen.length === 0) {
      obsidianNotifier.notice(answer.ignore.length > 0 ? `Nothing imported. ${answer.ignore.length} item${answer.ignore.length === 1 ? " is" : "s are"} not offered again.` : M.studioImportCancelled, 6000);
      return;
    }
    if (this.writing) return;
    this.writing = true;
    try {
      const chosen = new Set(answer.chosen);
      const target = importRoute(this.settings.routes, answer.folder);
      this.show(target.ok ? await importStudioItems(built.deps, candidates.filter((c) => chosen.has(c.id)), target.route) : { status: "refused", notices: [target.message] });
    } finally {
      this.writing = false;
    }
    this.refreshPanels();
  }

  /**
   * "Studio: choose hoppers for this note" (roadmap S13): a switch per hopper of the Studio, preset from `blyg_hoppers`; saving writes the
   * property only. The Studio changes when the note is sent.
   */
  private async chooseHoppersForActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md" || routeFor(this.settings.routes, file.path)?.mode !== "studio") {
      obsidianNotifier.notice("Open a note in a Studio folder first.", 6000);
      return;
    }
    const listed = await runStudioHoppers(this.env());
    if (!listed.ok) return this.show(listed.outcome);
    const note = noteRefOf(file);
    const vault = obsidianVault(this.app);
    const read = readHopperNames(vault.frontmatterValue(note, HOPPERS_KEY));
    const current = read.ok ? read.names : [];
    const known = (n: string): boolean => listed.hoppers.some((h) => h.name.toLowerCase() === n.toLowerCase() || (h.slug !== null && h.slug.toLowerCase() === n.toLowerCase()));
    const names = await chooseHoppers(this.app, listed.hoppers, current, current.filter((n) => !known(n)));
    if (names === null) return;
    try {
      await vault.updateFrontmatter(note, (fm) => {
        fm[HOPPERS_KEY] = names;
      });
      obsidianNotifier.notice(M.hoppersPicked(names), 8000);
    } catch (err) {
      this.logger().warn(`writing blyg_hoppers failed: ${err instanceof Error ? err.message : String(err)}`);
      obsidianNotifier.notice("The note's hoppers could not be written. Try again.", 8000);
    }
    this.refreshPanels();
  }

  /**
   * "Reply to an item" (roadmap S10): choose an item of yours or of a blyg you read, by words or by pasting its address, and start a thread
   * that is a reply to it (a stub, spec 0.4 §10.6). The new thread begins with a quote of the item when it can be quoted, and carries the
   * property `blyg_stub_of`; publishing sends the reply link with the text.
   */
  private async replyToItem(): Promise<void> {
    if (!studioAddress(this.settings.studio) || !this.settings.routes.some((r) => r.mode === "studio")) {
      new Notice(TM.replyNeedsStudio, 8000);
      return;
    }
    const picked = await this.chooseStudioItem(this.app.workspace.getActiveFile(), "Choose the item to reply to, or paste its address…");
    if (!picked) return;
    const target = await runStudioReplyTarget(this.env(), picked);
    if (!target.ok) {
      new Notice(target.message, 10000);
      return;
    }
    const quote = picked.quotable === false ? "" : `![[${writtenRef(picked, picked.path ? this.linkTextOf({ path: picked.path }, "") : "")}]]\n\n`;
    await this.createNote("thread", quote, target.target);
  }

  /** "Make this thread a reply": the open, unpublished thread names the item it answers. The text is not touched. */
  private async makeActiveThreadAReply(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    const address = studioAddress(this.settings.studio);
    if (!file || file.extension !== "md" || !address || routeFor(this.settings.routes, file.path)?.mode !== "studio") {
      new Notice(TM.replyNeedsStudio, 8000);
      return;
    }
    const note = noteRefOf(file);
    const vault = obsidianVault(this.app);
    if (vault.frontmatterValue(note, "blyg_kind") !== "thread") {
      new Notice(TM.replyNeedsThread, 8000);
      return;
    }
    const record = readStudioRecord(vault, note, address.origin);
    if (record.kind === "this" && (record.version ?? 0) > 0) {
      new Notice(TM.replyPublished, 10000);
      return;
    }
    const picked = await this.chooseStudioItem(file, "Choose the item this thread answers, or paste its address…");
    if (!picked) return;
    const target = await runStudioReplyTarget(this.env(), picked);
    if (!target.ok) {
      new Notice(target.message, 10000);
      return;
    }
    try {
      await vault.updateFrontmatter(note, (fm) => {
        fm[STUB_KEY] = stubProperty(target.target);
      });
      new Notice(TM.replyMarked(stubLabel(target.target)), 10000);
    } catch (err) {
      this.logger().warn(`writing blyg_stub_of failed: ${err instanceof Error ? err.message : String(err)}`);
      new Notice(TM.replyWriteFailed, 8000);
    }
    this.refreshPanels();
  }

  /** Creating notes for the import. Names compare ignoring case, as the iOS and macOS file systems do. */
  private noteFiles(): NoteFiles {
    const { vault } = this.app;
    return {
      exists: (path) => {
        if (vault.getAbstractFileByPath(path) !== null) return true;
        const low = path.toLowerCase();
        return vault.getFiles().some((f) => f.path.toLowerCase() === low);
      },
      ensureFolder: async (path) => {
        if (path !== "" && !vault.getFolderByPath(path)) await vault.createFolder(path);
      },
      create: async (path, text) => noteRefOf(await vault.create(path, text)),
    };
  }

  /** The properties of the author's template for imported notes (its text is not used: the note's text is the Studio's). Read once per kind and run. */
  private importTemplateProps(): (kind: ItemKind, title: string) => Promise<Record<string, unknown>> {
    const failed = new Set<ItemKind>();
    return async (kind, title) => {
      if (failed.has(kind)) return {};
      const template = await this.readTemplate(kind, title, new Date());
      if (template === null) failed.add(kind);
      const block = template?.text ? extractFrontmatterBlock(template.text) : null;
      if (block === null) return {};
      try {
        const parsed = obsidianYaml.parse(block);
        return isRecord(parsed) ? parsed : {};
      } catch {
        failed.add(kind);
        return {};
      }
    };
  }

  /** Run one write, show the outcome, and (when something was committed) start watching the site's checks in the background. */
  private async write(action: (env: AppEnv) => Promise<Outcome>): Promise<void> {
    if (this.writing) {
      obsidianNotifier.notice("Another publish or withdraw is still in progress. Finish or cancel it first.", 6000);
      return;
    }
    this.writing = true;
    let outcome: Outcome;
    try {
      outcome = await action(this.env());
    } finally {
      this.writing = false;
    }
    this.show(outcome);
    this.studioFacts.invalidate(); // a publish, withdraw or repost changed what the Studio holds
    this.refreshPanels();
    const sha = outcome.commit?.sha;
    if (outcome.status !== "committed" || !outcome.commit || !sha) return;
    this.lastCommit = {
      branch: outcome.commit.branch,
      sha,
      path: outcome.commit.path,
      ...(outcome.version !== undefined ? { version: outcome.version } : {}),
    };
    // Not awaited: the panel's buttons must not stay dead for the minutes a deploy takes.
    void this.watch(this.lastCommit);
  }

  private async watch(commit: { branch: string; sha: string; version?: number; path?: string }, opts: { firstDelayMs?: number } = {}): Promise<void> {
    if (this.settings.github.watchDeploy) {
      this.deploys.set(commit.path, {
        phase: "watching",
        branch: commit.branch,
        ...(commit.version !== undefined ? { version: commit.version } : {}),
        ...(commit.path !== undefined ? { path: commit.path } : {}),
      });
      this.refreshPanels();
    }
    const record = await watchCommit(
      {
        settings: this.settings,
        keychain: obsidianKeychain(this.app),
        http: this.http(),
        timers: windowTimers,
        clock: systemClock,
        logger: this.logger(),
        shouldStop: () => this.unloading,
      },
      commit,
      opts,
    );
    if (!record) {
      this.deploys.forget(commit.path);
      this.refreshPanels();
      return;
    }
    this.deploys.set(commit.path, {
      phase: "done",
      branch: record.branch,
      ...(record.version !== undefined ? { version: record.version } : {}),
      ...(record.path !== undefined ? { path: record.path } : {}),
      kind: record.report.result.kind,
      text: record.report.text,
      attention: record.report.attention,
      at: record.at,
    });
    this.refreshPanels();
    // A failure is always a notice (it needs attention). A success is one only when the panel is not on screen to say it:
    // my reading of "I want it in the panel" (Florian, 2026-10-07), to be confirmed.
    if (record.report.attention || !this.panelVisible()) obsidianNotifier.notice(record.report.text, record.report.attention ? 30000 : 10000);
  }

  // ---- the panel -------------------------------------------------------------------------------------------------

  private panelHost(): PanelHost {
    return {
      version: this.manifest.version,
      loadState: (): Promise<PanelState> => this.panelState(),
      deploy: (path) => this.deploys.get(path),
      publish: () => this.publishActiveNote(),
      withdraw: () => this.withdrawActiveNote(),
      deleteDraft: () => this.deleteDraftOfActiveNote(),
      repost: () => this.repostActiveNote(),
      pull: () => this.pullActiveNote(),
      openWeb: (url) => void window.open(url),
      setTarget: (channel) => this.setTarget(channel),
      canSwitchTarget: () => !this.settingsLocked && !this.writing,
      recheckDeploy: () => this.showDeployStatus(),
      newThread: () => this.newItem("thread"),
      newNote: () => this.newItem("fragment"),
      importFromStudio: () => this.importFromStudio(),
      chooseHoppers: () => this.chooseHoppersForActiveNote(),
      replyToItem: () => this.replyToItem(),
      makeReply: () => this.makeActiveThreadAReply(),
      takeHoppers: () => this.write(runTakeHoppers),
      quoteInNewThread: () => this.quoteInNewThread(),
      continueThread: () => Promise.resolve(this.continueThread()),
      makeThread: () => this.makeThread(),
      insertQuote: () => {
        const editor = this.activeEditor();
        return editor ? this.insertQuote(editor) : Promise.resolve(void new Notice(TM.openAThread, 6000));
      },
      insertLink: () => {
        const editor = this.activeEditor();
        return editor ? this.insertItemLink(editor) : Promise.resolve(void new Notice(TM.openANote, 6000));
      },
    };
  }

  private panelState(): Promise<PanelState> {
    const file = this.app.workspace.getActiveFile();
    return loadPanelState(
      {
        settings: this.settings,
        vault: obsidianVault(this.app),
        images: obsidianBinaryVault(this.app),
        imageDigests: this.imageDigests,
        published: this.published(),
        studioLive: (_note, id) => {
          if (id) this.studioFacts.request(id, () => this.refreshPanels());
          this.studioWarnings.request("studio", () => this.refreshPanels());
          const facts = id ? this.studioFacts.peek(id) : undefined;
          const notices = this.studioWarnings.peek("studio");
          return { ...(facts ? { facts } : {}), warnings: notices?.warnings ?? [], notes: notices?.notes ?? [] };
        },
      },
      file ? noteRefOf(file) : null,
    );
  }

  private panelViews(): BlygPanelView[] {
    return this.app.workspace
      .getLeavesOfType(BLYG_PANEL_VIEW)
      .map((leaf) => leaf.view)
      .filter((view): view is BlygPanelView => view instanceof BlygPanelView);
  }

  private panelVisible(): boolean {
    return this.panelViews().some((view) => view.containerEl.isShown());
  }

  private refreshPanels(): void {
    for (const view of this.panelViews()) void view.refresh();
  }

  /** The panel follows the active note: switching notes, and a note's metadata changing (a save, a stamp after a publish). */
  private registerPanelRefresh(): void {
    // Typing saves to disk every few seconds and each save re-reads the note: wait for a pause.
    const later = debounce(() => this.refreshPanels(), 600, true);
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshPanels()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        // Tapping into the sidebar itself changes nothing about the note.
        if (leaf?.view.getViewType() !== BLYG_PANEL_VIEW) this.refreshPanels();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path === this.app.workspace.getActiveFile()?.path) later();
      }),
    );
    const onFileChange = (file: TAbstractFile): void => {
      if (file.path === this.app.workspace.getActiveFile()?.path) later();
    };
    this.registerEvent(this.app.vault.on("rename", onFileChange));
    this.registerEvent(this.app.vault.on("delete", onFileChange));

    // Obsidian Sync can bring in a changed data.json (a publish recorded on the other device) while the panel is open: see app/dataWatch.ts.
    const dataPath = this.manifest.dir ? `${this.manifest.dir}/data.json` : null;
    if (dataPath) {
      const watch = createDataWatch({
        modified: async () => (await this.app.vault.adapter.stat(dataPath))?.mtime ?? null,
        panelVisible: () => this.panelVisible(),
        redraw: () => this.refreshPanels(),
      });
      this.registerInterval(
        window.setInterval(() => {
          void watch.look();
          // What the Studio said about the open note ages out: ask again while the panel is on screen, so a change made in the Studio shows up unprompted.
          if (this.panelVisible()) for (const id of this.studioFacts.expired()) this.studioFacts.request(id, () => this.refreshPanels());
        }, DATA_LOOK_MS),
      );
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        // Back from another app (the Studio's own editor, say): whatever it said before may be out of date.
        this.studioFacts.invalidate();
        watch.returned();
      });
    }
  }

  /** "Insert web quote" (roadmap S20): a plain quote-with-link in the open note. Not a blyg operation: no route, no Studio, no request. */
  private insertWebQuote(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "source") {
      new Notice("Open a note in editing view first. The quote is written into the open note.");
      return;
    }
    const editor = view.editor;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    openWebQuote(this.app, this.settings.webQuote, editor.getSelection(), (block) => {
      if (this.app.workspace.getActiveViewOfType(MarkdownView) !== view) {
        new Notice("The open note changed, so nothing was inserted. Your draft is kept.");
        return false;
      }
      const plan = planInsert(editor.getValue().split("\n"), from, to, block);
      editor.replaceRange(plan.text, plan.from, plan.to);
      editor.setCursor(endOf(plan.from, plan.text));
      return true;
    });
  }

  /** PROOF OF CONCEPT (S15): the reader pane opens in the main area; what it asks of the plugin is answered here, through the same Studio plumbing as publishing. */
  private async openReader(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(BLYG_READER_VIEW)[0];
    if (existing) return void (await workspace.revealLeaf(existing));
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: BLYG_READER_VIEW, active: true });
    await workspace.revealLeaf(leaf);
  }

  private readerHost(): ReaderHost {
    return {
      imageMode: () => this.settings.readerPane.images,
      load: async () => {
        const built = buildStudio(this.env());
        if (!built.ok) return { ok: false, message: built.message };
        try {
          const { client } = built.studio;
          const [reading, mentions] = await Promise.all([client.listReading(), client.listInboundMentions()]);
          if (reading.kind !== "ok") return { ok: false, message: "message" in reading ? reading.message : "The Studio could not list what you read." };
          const cut = !reading.value.complete || (mentions.kind === "ok" && !mentions.value.complete);
          const bad = reading.value.unreadable + (mentions.kind === "ok" ? mentions.value.unreadable : 0);
          const note = [cut ? "Showing the newest posts only." : "", bad > 0 ? `${bad} could not be read.` : "", mentions.kind === "ok" ? "" : "Mentions are not available."].filter(Boolean).join(" ");
          return { ok: true, data: { posts: reading.value.posts, mentions: mentions.kind === "ok" ? mentions.value.mentions : [], note, studioOrigin: built.studio.address.origin } };
        } catch (err) {
          this.logger().warn(`reader load failed: ${err instanceof Error ? err.message : String(err)}`);
          return { ok: false, message: "The Studio could not be reached." };
        }
      },
      openWeb: (url) => window.open(url, "_blank"),
      replyTo: async (post: ReadingPost) => {
        const pick: StudioPick = { source: "studio", id: post.remoteId, kind: post.kind, title: excerptOf(post.contentHtml, 60), detail: post.subscriptionTitle, subscriptionId: post.subscriptionId, label: post.subscriptionTitle, origin: post.origin, version: post.version, quotable: true };
        const target = await runStudioReplyTarget(this.env(), pick);
        if (!target.ok) return void new Notice(target.message, 10000);
        await this.createNote("thread", `![[${writtenRef(pick, "")}]]\n\n`, target.target);
      },
      markRead: async (post: ReadingPost) => {
        const built = buildStudio(this.env());
        if (!built.ok) return built.message;
        const done = await built.studio.client.markRead(post.subscriptionId, post.remoteId, post.version);
        if (done.kind === "ok") return "Marked read.";
        if (done.kind === "forbidden") return "Your token cannot mark posts read. It needs the permission “reading:state”: make a new token with every permission.";
        return "message" in done ? done.message : "Could not mark it read.";
      },
    };
  }

  private async openPanel(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(BLYG_PANEL_VIEW)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: BLYG_PANEL_VIEW, active: true });
    await workspace.revealLeaf(leaf);
  }

  private async showDeployStatus(): Promise<void> {
    const { github } = this.settings;
    if (!github.watchDeploy) {
      obsidianNotifier.notice(`Deploy watching is off in the settings. See ${actionsUrlOf(github.owner, github.repo)}`, 10000);
      return;
    }
    if (!this.lastCommit) {
      obsidianNotifier.notice("Nothing committed since Obsidian started. Publish something, or see GitHub Actions for older deploys.", 8000);
      return;
    }
    if (!this.panelVisible()) obsidianNotifier.notice(`Looking at the deploy of your last commit (${this.lastCommit.branch})…`, 4000);
    await this.watch(this.lastCommit, { firstDelayMs: 0 });
  }

  // ---- threads ---------------------------------------------------------------------------------------------------

  /**
   * The template note the settings name for this kind, with its placeholders filled in: `{ text: null }` when none is set, `null` when
   * one is set but cannot be used (the notice says why: a configured template is always applied, so a bad one stops the note rather
   * than being skipped).
   */
  private async readTemplate(kind: ItemKind, title: string, now: Date): Promise<{ text: string | null } | null> {
    const setting = this.settings.templates[kind];
    const path = templatePath(setting);
    if (path === null) return { text: null };
    const { vault, metadataCache } = this.app;
    const file = vault.getFileByPath(path) ?? metadataCache.getFirstLinkpathDest(path, "");
    if (!file || file.extension !== "md") {
      new Notice(TM.templateMissing(setting), 10000);
      return null;
    }
    try {
      const m = moment(now);
      const text = expandTemplate(await vault.read(file), {
        title,
        date: (fmt) => m.format(fmt ?? "YYYY-MM-DD"),
        time: (fmt) => m.format(fmt ?? "HH:mm"),
      });
      return { text };
    } catch (err) {
      this.logger().warn(`reading the template failed: ${err instanceof Error ? err.message : String(err)}`);
      new Notice(TM.templateUnreadable(setting), 10000);
      return null;
    }
  }

  private templateProblemNotice(kind: ItemKind, problem: TemplateProblem): string {
    const path = this.settings.templates[kind];
    if (problem.kind === "unclosed") return TM.templateUnclosed(path);
    if (problem.kind === "publish-property") return TM.templatePublishProperty(path, problem.key);
    return TM.templateWrongKind(path, problem.found, kind);
  }

  /**
   * Create a note in the active note's Blyg folder, else the first Studio folder, else the first Blyg folder (nothing else: no opening, no notices except a failure). Its text is the kind's template from
   * the settings, if one is set, then `body` (what the command adds: a quote, a moved selection); a thread also gets its property.
   */
  private async makeFile(kind: ItemKind, body: string): Promise<TFile | null> {
    const route = newItemRoute(this.settings.routes, this.app.workspace.getActiveFile()?.path ?? null);
    if (!route) {
      new Notice(TM.noBlygFolder, 8000);
      return null;
    }
    const { vault } = this.app;
    const folder = route.vaultPrefix.replace(/\/+$/, "");
    try {
      const now = new Date();
      const name = newItemName(kind === "thread" ? "Thread" : "Fragment", now, (n) => vault.getAbstractFileByPath(`${route.vaultPrefix}${n}.md`) !== null);
      const template = await this.readTemplate(kind, name, now);
      if (template === null) return null;
      const composed = newItemText({ kind, template: template.text, body });
      if (!composed.ok) {
        new Notice(this.templateProblemNotice(kind, composed.problem), 10000);
        return null;
      }
      if (folder !== "" && !vault.getFolderByPath(folder)) await vault.createFolder(folder);
      return await vault.create(`${route.vaultPrefix}${name}.md`, composed.text);
    } catch (err) {
      this.logger().warn(`creating a note failed: ${err instanceof Error ? err.message : String(err)}`);
      new Notice(TM.createFailed, 8000);
      return null;
    }
  }

  /**
   * A new note in that folder, opened with the cursor at its end: a fragment, or a thread (its property makes it one).
   * `body` is put after the properties (a thread that starts with a quote of the note it answers).
   */
  private async createNote(kind: "fragment" | "thread", body = "", reply?: StubTarget): Promise<void> {
    const file = await this.makeFile(kind, body);
    if (!file) return;
    if (reply) {
      try {
        await obsidianVault(this.app).updateFrontmatter(noteRefOf(file), (fm) => {
          fm[STUB_KEY] = stubProperty(reply);
        });
      } catch (err) {
        this.logger().warn(`writing blyg_stub_of failed: ${err instanceof Error ? err.message : String(err)}`);
        new Notice(TM.replyNotWritten, 10000);
      }
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      editor.setCursor({ line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length });
      editor.focus();
    }
    new Notice(reply ? (body === "" ? TM.replyStartedNoQuote(stubLabel(reply)) : TM.replyStarted(stubLabel(reply))) : kind === "thread" ? TM.created : TM.createdNote, reply ? 10000 : 6000);
  }

  /**
   * "New fragment" / "New thread". With text selected in the editor you were in, the selection is moved into the new item and an embed of it
   * stands in its place (Florian, 2026-10-16); without a selection it is just a new item. Refused for essays, pages and fragments (they
   * cannot hold the embed). The new item is created first and the selection replaced only afterwards, so a failure never loses text; you stay
   * where you are, with the embed.
   */
  private async newItem(kind: "fragment" | "thread"): Promise<void> {
    const view = this.activeMarkdownView();
    const selection = view?.editor.getSelection() ?? "";
    if (!view || !view.file || selection.trim() === "") {
      await this.createNote(kind);
      return;
    }
    const note = noteRefOf(view.file);
    const vault = obsidianVault(this.app);
    const declared = localKind(vault.frontmatterValue(note, "blyg_kind"));
    const verdict = extractionVerdict({
      routeMode: routeFor(this.settings.routes, note.path)?.mode ?? null,
      kind: "kind" in declared ? declared.kind : "fragment",
      hasId: isBlygId(vault.blygId(note)),
    });
    if (!verdict.ok) {
      new Notice(verdict.reason === "plain-route" ? TM.extractPlain : verdict.reason === "fragment" ? TM.extractFragment : TM.extractPublishedFragment, 10000);
      return;
    }
    const editor = view.editor;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const created = await this.makeFile(kind, extractedItemBody(selection));
    if (!created) return;
    editor.replaceSelection(
      embedReplacement({ before: editor.getLine(from.line).slice(0, from.ch), after: editor.getLine(to.line).slice(to.ch) }, this.linkTextOf(created, view.file.path)),
    );
    const cap = this.settings.blyg.fragmentCharCap;
    const notices = [TM.extractDone(created.basename, selection.trim().length)];
    if (kind === "fragment" && selection.trim().length > cap) notices.push(TM.extractTooLong(selection.trim().length, cap));
    const fromMode = routeFor(this.settings.routes, note.path)?.mode;
    if (fromMode === "blyg" || fromMode === "studio") notices.push(TM.extractPublishFirst);
    new Notice(notices.join(" "), 14000);
  }

  /** What Obsidian links to this note by: its name, or its path when the name is ambiguous. */
  private linkTextOf(file: { path: string }, from: string): string {
    const f = this.app.vault.getFileByPath(file.path);
    return f ? this.app.metadataCache.fileToLinktext(f, from, true) : file.path.replace(/\.md$/, "");
  }

  /** "Quote in thread": a new thread that starts with a quote of the open Blyg note, ready to write. */
  private async quoteInNewThread(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    const mode = file ? routeFor(this.settings.routes, file.path)?.mode : undefined;
    if (!file || file.extension !== "md" || (mode !== "blyg" && mode !== "studio")) {
      new Notice(TM.quotesNeedBlygFolder, 6000);
      return;
    }
    await this.createNote("thread", `![[${this.linkTextOf(file, file.path)}]]\n\n`);
  }

  /**
   * "Continue thread": the open thread, cursor at its end after a blank line, to keep writing. Publishing it again makes a new version
   * of the same thread: that is how the protocol continues a thread (one item that grows, spec §5.2).
   */
  private continueThread(): void {
    const editor = this.activeEditor();
    const file = this.app.workspace.getActiveFile();
    const kind = file ? obsidianVault(this.app).frontmatterValue(noteRefOf(file), "blyg_kind") : undefined;
    if (!editor || kind !== "thread") {
      new Notice(TM.openAThread, 6000);
      return;
    }
    const last = editor.lastLine();
    if (editor.getLine(last).trim() !== "") editor.replaceRange("\n\n", { line: last, ch: editor.getLine(last).length });
    else if (last > 0 && editor.getLine(last - 1).trim() !== "") editor.replaceRange("\n", { line: last, ch: 0 });
    const end = editor.lastLine();
    editor.setCursor({ line: end, ch: editor.getLine(end).length });
    editor.focus();
  }

  /** The editor view the user was in: from the side panel the sidebar is the active view, so fall back to the most recent editor. */
  private activeMarkdownView(): MarkdownView | null {
    const recent = this.app.workspace.getMostRecentLeaf()?.view;
    return this.app.workspace.getActiveViewOfType(MarkdownView) ?? (recent instanceof MarkdownView ? recent : null);
  }

  private activeEditor(): Editor | null {
    return this.activeMarkdownView()?.editor ?? null;
  }

  /** Turn an unpublished note in a Blyg folder into a thread (the kind never changes after the first publish). */
  private async makeThread(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice(TM.openNoteFirst, 4000);
      return;
    }
    const note = noteRefOf(file);
    const vault = obsidianVault(this.app);
    const verdict = threadConversion({
      inBlygRoute: note.extension === "md" && ["blyg", "studio"].includes(routeFor(this.settings.routes, note.path)?.mode ?? ""),
      id: vault.blygId(note),
      kind: vault.frontmatterValue(note, "blyg_kind"),
    });
    if (!verdict.ok) {
      new Notice(verdict.message, 8000);
      return;
    }
    await vault.updateFrontmatter(note, (fm) => void (fm.blyg_kind = "thread"));
    // An automatic "Fragment …" name becomes "Thread …"; renameFile keeps the embeds and links elsewhere in the vault pointing at it.
    const folder = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const renamed = renamedForThread(file.basename, (n) => this.app.vault.getAbstractFileByPath(`${folder}${n}.${file.extension}`) !== null);
    if (renamed !== null) {
      try {
        await this.app.fileManager.renameFile(file, `${folder}${renamed}.${file.extension}`);
      } catch {
        // the note is a thread either way; only the name stays as it was
      }
    }
    this.refreshPanels();
    new Notice(TM.nowThread, 6000);
  }

  /** The author's published notes the picker may offer (from the vault: no network), newest first. */
  private async pickerCandidates(activePath: string) {
    const entries: PickerEntry[] = (
      await Promise.all(
        this.app.vault.getMarkdownFiles().map(async (f): Promise<PickerEntry | null> => {
          if (routeFor(this.settings.routes, f.path)?.mode !== "blyg") return null;
          const frontmatter = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
          return { path: f.path, name: f.basename, frontmatter, text: await this.app.vault.cachedRead(f) };
        }),
      )
    ).filter((e): e is PickerEntry => e !== null);
    return pickerCandidates(entries, { activePath, channel: activeChannel(this.settings) });
  }

  /** A plain link `[[id]]` to one of your published notes, at the cursor. The publish checks it and freezes its label. */
  private async insertItemLink(editor: Editor): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const note = noteRefOf(file);
    const mode = routeFor(this.settings.routes, note.path)?.mode;
    if (note.extension !== "md" || (mode !== "blyg" && mode !== "studio")) {
      new Notice(TM.linksNeedBlygFolder, 6000);
      return;
    }
    if (mode === "studio") {
      await this.insertStudioLink(editor, file);
      return;
    }
    const candidates = await this.pickerCandidates(file.path);
    if (candidates.length === 0) {
      new Notice(TM.nothingToQuote, 8000);
      return;
    }
    const picked = await promptForItem(this.app, candidates, "Choose a published item to link to…");
    if (!picked) return;
    editor.replaceSelection(`[[${this.linkTextOf(picked, file.path)}]]`);
    new Notice(TM.linkInserted, 5000);
  }

  /** Choose a published note, then all of it or a passage of what readers see, and put the quote in the thread at the cursor. */
  private async insertQuote(editor: Editor): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const note = noteRefOf(file);
    const vault = obsidianVault(this.app);
    const mode = routeFor(this.settings.routes, note.path)?.mode;
    if (note.extension !== "md" || (mode !== "blyg" && mode !== "studio")) {
      new Notice(TM.quotesNeedBlygFolder, 6000);
      return;
    }
    const declared = localKind(vault.frontmatterValue(note, "blyg_kind"));
    if (!("kind" in declared) || declared.kind !== "thread") {
      new Notice(TM.notAThread, 8000);
      return;
    }
    if (mode === "studio") {
      await this.insertStudioQuote(editor, file);
      return;
    }

    const candidates = await this.pickerCandidates(file.path);
    if (candidates.length === 0) {
      new Notice(TM.nothingToQuote, 8000);
      return;
    }

    const picked = await promptForItem(this.app, candidates);
    if (!picked) return;
    new Notice(TM.reading, 3000);
    const quotable = await runFetchQuotable(this.env(), picked.id);
    if (!quotable.ok) {
      this.show(quotable.outcome);
      return;
    }
    const choice = await promptForQuote(this.app, quotable);
    if (!choice) return;
    const block = quoteBlock(this.linkTextOf(picked, file.path), choice);
    if (!block.ok) {
      new Notice(block.reason === "cannot" ? TM.cannotQuote : TM.selectFirst, 8000);
      return;
    }
    this.putBlock(editor, block.text, choice);
  }

  /** The quote's lines at the cursor, standing on their own lines. */
  private putBlock(editor: Editor, block: string, choice: QuoteChoice): void {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const text = blockToInsert({ before: line.slice(0, cursor.ch), after: line.slice(cursor.ch), previousLine: cursor.line > 0 ? editor.getLine(cursor.line - 1) : undefined }, block);
    editor.replaceRange(text, cursor);
    new Notice(choice.kind === "whole" ? TM.quoteInserted : TM.passageInserted, 5000);
  }

  // ---- Studio folders: the picker lists the vault's notes of this Studio and what the Studio's search finds ------------

  /** Which old item became which new one (the notes' `blyg_previous`), in a window to copy: what the site's redirect rules need (roadmap S3.1). */
  private listRepostedItems(): void {
    const address = studioAddress(this.settings.studio);
    if (!address) {
      new Notice(TM.noStudioSetUp, 8000);
      return;
    }
    const notes = this.app.vault
      .getMarkdownFiles()
      .filter((f) => routeFor(this.settings.routes, f.path)?.mode === "studio")
      .map((f) => ({ name: f.basename, frontmatter: this.app.metadataCache.getFileCache(f)?.frontmatter ?? {} }));
    const lines = repostMap(notes, address, this.settings.blyg.origin);
    if (lines.length === 0) {
      new Notice(TM.noRepostedNotes, 10000);
      return;
    }
    const noOld = lines.filter((l) => l.oldPage === null).length;
    new TextModal(
      this.app,
      "Reposted items",
      `${lines.length} note${lines.length === 1 ? "" : "s"} in Studio folders ${lines.length === 1 ? "was" : "were"} reposted${noOld > 0 ? `; ${noOld} without an old address (shown as -)` : ""}. Copy the text and send it where the redirect rules are written.`,
      repostMapText(lines, address.origin),
      (ok) => new Notice(ok ? "Copied." : "Could not copy: the text is selected, copy it by hand.", 5000),
    ).open();
  }

  /** The notes of this Studio that are in the vault: written by name, so Obsidian resolves them and follows renames. */
  private async studioVaultPicks(activePath: string): Promise<StudioPick[]> {
    const address = studioAddress(this.settings.studio);
    if (!address) return [];
    const notes: StudioVaultNote[] = (
      await Promise.all(
        this.app.vault.getMarkdownFiles().map(async (f): Promise<StudioVaultNote | null> => {
          if (routeFor(this.settings.routes, f.path)?.mode !== "studio") return null;
          const frontmatter = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
          return { path: f.path, name: f.basename, frontmatter, text: await this.app.vault.cachedRead(f) };
        }),
      )
    ).filter((n): n is StudioVaultNote => n !== null);
    return vaultPicks(notes, { activePath, origin: address.origin });
  }

  /** `file`: the note being written, left out of the list (a note cannot quote itself); null when no note is open (starting a reply). */
  private async chooseStudioItem(file: TFile | null, placeholder: string): Promise<StudioPick | null> {
    const own = await this.studioVaultPicks(file?.path ?? "");
    const selfId = file ? (this.app.metadataCache.getFileCache(file)?.frontmatter?.blyg_id as unknown) : undefined;
    const env = this.env();
    return promptForStudioItem(
      this.app,
      {
        own,
        search: async (query) => {
          const found = await runStudioSearch(env, query);
          if (!found.ok) return { ok: false, error: found.outcome.notices.join(" ") };
          return { ok: true, picks: found.picks.filter((p) => p.id !== selfId) };
        },
        isAddress: looksLikeAddress,
        // A pasted address (S9): the Studio finds the item. An item of yours that has a note here is offered as that note (written by name).
        lookup: async (query) => {
          const found = await runStudioLookup(env, query);
          if (found === null || !found.ok) return found;
          if (found.pick.id === selfId) return { ok: false, error: "That is the note you are writing." };
          return { ok: true, pick: own.find((p) => p.id === found.pick.id) ?? found.pick };
        },
      },
      placeholder,
    );
  }

  /** "Insert link" in a Studio folder: `[[Name]]` for a note of the vault, `[[id | label]]` for any other item the Studio knows. */
  private async insertStudioLink(editor: Editor, file: TFile): Promise<void> {
    const picked = await this.chooseStudioItem(file, "Choose an item to link to, or paste its address…");
    if (!picked) return;
    if (picked.quotable === false) {
      new Notice(M.stubCannotQuote, 10000);
      return;
    }
    editor.replaceSelection(`[[${writtenRef(picked, picked.path ? this.linkTextOf({ path: picked.path }, file.path) : "")}]]`);
    new Notice(TM.studioLinkInserted, 5000);
  }

  /** "Insert quote" in a Studio folder: the whole item or a passage of what readers see, from your own items or a blyg you read. */
  private async insertStudioQuote(editor: Editor, file: TFile): Promise<void> {
    const picked = await this.chooseStudioItem(file, "Choose an item to quote, or paste its address…");
    if (!picked) return;
    if (picked.quotable === false) {
      new Notice(M.stubCannotQuote, 10000);
      return;
    }
    new Notice(TM.reading, 3000);
    const quotable = await runStudioQuotable(this.env(), picked);
    if (!quotable.ok) {
      this.show(quotable.outcome);
      return;
    }
    const choice = await promptForQuote(this.app, quotable);
    if (!choice) return;
    const block = quoteBlockOf(writtenRef(picked, picked.path ? this.linkTextOf({ path: picked.path }, file.path) : ""), choice);
    if (!block.ok) {
      new Notice(block.reason === "cannot" ? TM.cannotQuote : TM.selectFirst, 8000);
      return;
    }
    this.putBlock(editor, block.text, choice);
  }

  private async toggleTarget(): Promise<void> {
    await this.setTarget(activeChannel(this.settings) === "preview" ? "production" : "preview");
  }

  /** Point publishing at a branch: a setting change only, nothing is written to GitHub. */
  private async setTarget(channel: "production" | "preview"): Promise<void> {
    if (this.settingsLocked) {
      obsidianNotifier.notice("The settings are read-only on this device until the plugin is updated.");
      return;
    }
    if (this.writing) {
      obsidianNotifier.notice("A publish or withdraw is in progress. Switch the target after it.", 6000);
      return;
    }
    this.settings.github.useBranch = channel;
    await this.saveSettings(); // also redraws the panel
    this.settingTab?.update();
    obsidianNotifier.notice(`Publishing now goes to: ${describeTarget(this.settings)}. Branch: ${activeBranch(this.settings)}.`, 8000);
  }
}
