// "Send passage to note" (feature `passages`): the dock under the open post in the reader, and the command "Send selected passage to a note". The passage becomes a
// native quote (`![[id | label]]` with the attached blockquote, the shape the quote picker writes) in a note of the folders the writer chose, at the end of the section
// of the heading they pick. The quote is captured on the one tap that confirms the destination; nothing is written before. Strangers' text goes only into the
// note the writer chose, never anywhere else (not into the vault's other notes, not into the plugin's storage). This module registers the command (the registry
// lists it); main.ts and ReaderView.ts only hold the two hooks they already had.
import { MarkdownView, normalizePath, Notice, TFile, type App, type Plugin } from "obsidian";
import { localKind } from "../core/blyg";
import { isBlygId } from "../core/ids";
import { routeFor } from "../core/routes";
import { obsidianVault, noteRefOf } from "../platform/obsidianVault";
import type { BlygSettings } from "../settings/schema";
import { readQuotable } from "../studio/passage";
import type { ReadingPost } from "../studio/reading";
import { cleanLabel } from "../studio/text";
import { BLYG_READER_VIEW, BlygReaderView, excerptOf } from "../ui/ReaderView";
import { choosePassageDestination, type PassageChoice } from "../ui/PassageSendModal";
import { PassageDock } from "../ui/passageDock";
import { replyPlan } from "./replyToPost";
import { noteHeadings } from "./noteHeadings";
import { insertPassage, newThreadBody } from "./passageInsert";
import { createDraft, openForEditing } from "./passageDraftEntry";
import { PM } from "./passageMessages";
import { destinationVerdict, parseFolders, passageBlocked, readRecent, withRecent, type DestinationNote, type RecentDestination } from "./passageScope";
import { passageFromSelection, quoteBlockOf, renamedForThread, threadConversion } from "./threadCommands";
import type { buildStudio } from "./run";

export interface PassageDeps {
  settings: () => BlygSettings;
  build: () => ReturnType<typeof buildStudio>;
}

/** How long a selection the reader has seen can still be sent by the command (opening the palette on a phone takes a while and clears the selection). */
const COMMAND_HOLD_MS = 45_000;

export function registerPassages(plugin: Plugin, deps: PassageDeps): void {
  const { app } = plugin;
  let seen: { post: ReadingPost; text: string; at: number } | null = null;
  const docks = new WeakMap<BlygReaderView, PassageDock>();
  const docs = new WeakSet<Document>();

  const send = (post: ReadingPost, selection: string): void => void sendPassage(app, plugin, deps, post, selection);

  const ensure = (): void => {
    for (const leaf of app.workspace.getLeavesOfType(BLYG_READER_VIEW)) {
      const view = leaf.view;
      if (!(view instanceof BlygReaderView)) continue;
      if (!docks.has(view)) docks.set(view, new PassageDock(view.contentEl, { post: () => view.currentPost(), blocked: passageBlocked, send, seen: (post, text) => void (seen = { post, text, at: Date.now() }) }));
      const doc = view.contentEl.ownerDocument;
      if (!docs.has(doc)) {
        docs.add(doc);
        plugin.registerDomEvent(doc, "selectionchange", () => {
          for (const l of app.workspace.getLeavesOfType(BLYG_READER_VIEW)) if (l.view instanceof BlygReaderView && l.view.contentEl.ownerDocument === doc) docks.get(l.view)?.update();
        });
      }
    }
  };
  plugin.registerEvent(app.workspace.on("layout-change", ensure));
  plugin.registerEvent(app.workspace.on("active-leaf-change", ensure));
  app.workspace.onLayoutReady(ensure);

  plugin.addCommand({
    id: "send-passage-to-note",
    name: "Send selected passage to a note",
    callback: () => {
      if (seen && Date.now() - seen.at < COMMAND_HOLD_MS) return send(seen.post, seen.text);
      new Notice(PM.noSelection, 6000);
    },
  });
}

/** The whole flow for one passage. Never throws: every failure is a notice, and nothing is written before the destination is confirmed. */
async function sendPassage(app: App, plugin: Plugin, deps: PassageDeps, post: ReadingPost, selection: string): Promise<void> {
  const settings = deps.settings();
  const folders = parseFolders(settings.passages.folders);
  if (folders.length === 0) return void new Notice(PM.noFolders, 8000);
  const blocked = passageBlocked(post);
  if (blocked !== null) return void new Notice(blocked, 8000);
  const built = deps.build();
  if (!built.ok) return void new Notice(built.message, 8000);

  // Resolve the quotation first: a post that cannot be quoted is said so before the writer goes looking for a note.
  const { pick } = replyPlan(post, selection, excerptOf(post.contentHtml, 60));
  new Notice(PM.reading, 3000);
  let block: string;
  let passage: string;
  try {
    const quotable = await readQuotable(built.studio.client, pick);
    if (!quotable.ok) return void new Notice(quotable.outcome.notices.join(" "), 10000);
    const found = passageFromSelection(quotable.text, selection);
    if (found === null) return void new Notice(PM.notFound, 10000);
    const label = cleanLabel(pick.label);
    const made = quoteBlockOf(label === "" ? pick.id : `${pick.id} | ${label}`, { kind: "passage", selected: found });
    if (!made.ok) return void new Notice(PM.cannotQuote, 8000);
    block = made.text;
    passage = found;
  } catch {
    return void new Notice(PM.writeFailed, 8000);
  }

  const recentPath = normalizePath(`${plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`}/passages-recent.json`);
  const loadRecent = async (): Promise<RecentDestination[]> => {
    try {
      return (await app.vault.adapter.exists(recentPath)) ? readRecent(JSON.parse(await app.vault.adapter.read(recentPath)) as unknown) : [];
    } catch {
      return [];
    }
  };
  const vault = obsidianVault(app);
  const choice = await choosePassageDestination(app, {
    passage,
    folders,
    notes: () => app.vault.getMarkdownFiles().map((f): DestinationNote => ({ path: f.path, name: f.basename, mtime: f.stat.mtime })),
    recent: await loadRecent(),
    headingsOf: async (path) => {
      const f = app.vault.getFileByPath(path);
      return f ? noteHeadings(await app.vault.cachedRead(f)) : null;
    },
    verdictOf: (path) => {
      const f = app.vault.getFileByPath(path);
      if (!f) return { ok: false, reason: "plain-route" };
      const note = noteRefOf(f);
      const declared = localKind(vault.frontmatterValue(note, "blyg_kind"));
      return destinationVerdict({ routeMode: routeFor(settings.routes, path)?.mode ?? null, kind: "kind" in declared ? declared.kind : "fragment", hasId: isBlygId(vault.blygId(note)) });
    },
  });
  if (choice === null) return;
  await writePassage(app, plugin, settings, choice, block, recentPath, loadRecent);
}

async function writePassage(app: App, plugin: Plugin, settings: BlygSettings, choice: PassageChoice, block: string, recentPath: string, loadRecent: () => Promise<RecentDestination[]>): Promise<void> {
  if (choice.newThread === true) {
    // A new thread of its own: nothing is written to the note that cannot hold a quote. It opens with the cursor on the empty line under the quote.
    const made = await createDraft(app, settings, "", "thread", newThreadBody(block));
    if (!made) return;
    await openForEditing(app, made);
    new Notice(PM.newThreadMade(made.basename), 10000);
    return;
  }
  const file = app.vault.getFileByPath(choice.path);
  if (!file) return void new Notice(PM.noteGone, 8000);
  if (choice.convert && !(await makeThread(app, settings, file))) return void new Notice(PM.convertFailed, 8000);
  let result: ReturnType<typeof insertPassage> | null = null;
  try {
    // `process` reads and writes in one step, so the note is changed from its text as it is now, never from the text the heading list was made from.
    await app.vault.process(file, (data) => {
      result = insertPassage(data, choice.target, block);
      return result.ok ? result.text : data;
    });
  } catch {
    return void new Notice(PM.writeFailed, 8000);
  }
  const done = result as ReturnType<typeof insertPassage> | null;
  if (done === null || !done.ok) return void new Notice(done?.reason === "open-fence" ? PM.openFence : done?.reason === "heading-gone" ? PM.headingGone : PM.writeFailed, 10000);
  try {
    await app.vault.adapter.write(recentPath, JSON.stringify(withRecent(await loadRecent(), file.path, Date.now())));
  } catch {
    // The recent list is a convenience; the passage is in the note.
  }
  const where = choice.headingText;
  const frag = createFragment();
  frag.createSpan({ text: `${PM.sent(choice.name, where)} ` });
  const open = frag.createEl("button", { cls: "blyg-passage-toast-open", text: PM.openNote });
  const notice = new Notice(frag, 10000);
  open.addEventListener("click", () => {
    notice.hide();
    void openAtQuote(app, file, done.quoteLine, done.cursorLine);
  });
}

/** Open the note in a tab of its own (the reader stays where it was, underneath), on the empty line under the quote, ready for the reaction. */
async function openAtQuote(app: App, file: TFile, quoteLine: number, cursorLine: number): Promise<void> {
  const leaf = app.workspace.getLeaf("tab");
  await leaf.openFile(file, { state: { mode: "source" } });
  const view = leaf.view;
  if (!(view instanceof MarkdownView)) return;
  const editor = view.editor;
  const line = Math.min(cursorLine, editor.lastLine());
  editor.setCursor({ line, ch: 0 });
  editor.scrollIntoView({ from: { line: Math.min(quoteLine, line), ch: 0 }, to: { line, ch: 0 } }, true);
  editor.focus();
}

/** An unpublished fragment in a Blyg folder becomes a thread (the kind of a published item never changes). Same rule and same rename as "Make this note a thread". */
async function makeThread(app: App, settings: BlygSettings, file: TFile): Promise<boolean> {
  try {
    const note = noteRefOf(file);
    const vault = obsidianVault(app);
    const verdict = threadConversion({ inBlygRoute: ["blyg", "studio"].includes(routeFor(settings.routes, note.path)?.mode ?? ""), id: vault.blygId(note), kind: vault.frontmatterValue(note, "blyg_kind") });
    if (!verdict.ok) return false;
    await vault.updateFrontmatter(note, (fm) => void (fm.blyg_kind = "thread"));
    const folder = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const renamed = renamedForThread(file.basename, (n) => app.vault.getAbstractFileByPath(`${folder}${n}.${file.extension}`) !== null);
    if (renamed !== null) await app.fileManager.renameFile(file, `${folder}${renamed}.${file.extension}`);
    return true;
  } catch {
    return false;
  }
}
