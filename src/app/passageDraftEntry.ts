// "Draft selection as Blyg fragment / thread" (feature `passages`, P2): the editor-menu entries, the mobile-toolbar commands and "Back to the note". The selection is
// COPIED into a new independent draft (the note it came from is not changed; "New fragment" and "New thread" keep moving a selection as they always did). The draft is
// opened for editing and nothing is published. A selection with a captured quote becomes a thread with the quote intact; a fragment cannot hold one, and a quote that
// the selection cuts is never half taken: the writer is asked first (planSelection/decideDraft). Where the draft came from is kept in the plugin's storage, never in the
// draft, so no private path or position can reach a published item.
import { MarkdownView, moment, normalizePath, Notice, type App, type Editor, type Plugin, type TFile } from "obsidian";
import { newItemRoute } from "../core/routes";
import type { BlygSettings } from "../settings/schema";
import { askBeforeDrafting, type AskOption } from "../ui/PassageAskModal";
import { expandTemplate, newItemText, templatePath, type ItemKind } from "./itemTemplate";
import { decideDraft, planSelection, readOrigins, withOrigin, wordsHash, type DraftOption, type DraftOrigin } from "./passageDraft";
import { PM } from "./passageMessages";
import { newItemName } from "./threadCommands";

export interface DraftDeps {
  settings: () => BlygSettings;
}

const OPTION_TEXT: Record<DraftOption["id"], { label: string; hint: string; primary?: boolean }> = {
  "thread-with-quote": { label: PM.optThreadWithQuote, hint: PM.optThreadWithQuoteHint, primary: true },
  "include-quote": { label: PM.optIncludeQuote, hint: PM.optIncludeQuoteHint, primary: true },
  "leave-quote-out-fragment": { label: PM.optLeaveOutFragment, hint: PM.optLeaveOutHint },
  "leave-quote-out-thread": { label: PM.optLeaveOutThread, hint: PM.optLeaveOutHint },
  "words-only-fragment": { label: PM.optLeaveOutFragment, hint: PM.optLeaveOutHint },
  "words-only-thread": { label: PM.optLeaveOutThread, hint: PM.optLeaveOutHint },
};

export function registerPassageDraft(plugin: Plugin, deps: DraftDeps): void {
  const { app } = plugin;
  const originsPath = normalizePath(`${plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`}/passage-origins.json`);
  const loadOrigins = async (): Promise<Record<string, DraftOrigin>> => {
    try {
      return (await app.vault.adapter.exists(originsPath)) ? readOrigins(JSON.parse(await app.vault.adapter.read(originsPath)) as unknown) : {};
    } catch {
      return {};
    }
  };

  const draft = async (editor: Editor, sourcePath: string, wanted: ItemKind): Promise<void> => {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const plan = planSelection(editor.getValue(), from, to);
    if (plan.kind === "empty") return void new Notice(PM.draftNoSelection, 6000);
    const decision = decideDraft(plan, wanted, deps.settings().blyg.fragmentCharCap);
    let kind: ItemKind;
    let body: string;
    if (!decision.ask) {
      if ("refuse" in decision) return void new Notice(decision.refuse === "empty" ? PM.draftNoSelection : PM.draftTooLong(decision.length ?? 0, decision.cap ?? 0), 10000);
      kind = decision.kind;
      body = decision.body;
    } else {
      const opts: AskOption[] = decision.options.map((o) => OPTION_TEXT[o.id]);
      const quotes = decision.why === "quotes";
      const chosen = await askBeforeDrafting(app, quotes ? PM.askQuotesTitle : PM.askCutsTitle, quotes ? PM.askQuotesBody : PM.askCutsBody, opts);
      const option = chosen === null ? undefined : decision.options[chosen];
      if (!option) return;
      kind = option.kind;
      body = option.body;
    }
    // The origin is the selection the writer made, whichever text the draft took.
    const origin: DraftOrigin = { path: sourcePath, from, to, hash: wordsHash(editor.getRange(from, to)) };
    const file = await createDraft(app, deps.settings(), sourcePath, kind, body);
    if (!file) return;
    await plugin.app.vault.adapter.write(originsPath, JSON.stringify(withOrigin(await loadOrigins(), file.path, origin))).catch(() => {});
    await openDraft(app, file, origin, () => void goBack(file.path));
  };

  const goBack = async (draftPath: string): Promise<void> => {
    const origin = (await loadOrigins())[draftPath];
    if (!origin) return void new Notice(PM.backNone, 6000);
    const source = app.vault.getFileByPath(origin.path);
    if (!source) return void new Notice(PM.backGone, 6000);
    const open = app.workspace.getLeavesOfType("markdown").find((l) => l.view instanceof MarkdownView && l.view.file?.path === origin.path);
    const leaf = open ?? app.workspace.getLeaf("tab");
    if (!open) await leaf.openFile(source, { state: { mode: "source" } });
    else await app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const editor = view.editor;
    // The words are selected again where they were, when they are still there; otherwise the cursor goes to the line they were on.
    const same = origin.to.line <= editor.lastLine() && wordsHash(editor.getRange(origin.from, origin.to)) === origin.hash;
    if (same) editor.setSelection(origin.from, origin.to);
    else editor.setCursor({ line: Math.min(origin.from.line, editor.lastLine()), ch: 0 });
    editor.scrollIntoView({ from: origin.from, to: origin.to }, true);
    editor.focus();
  };

  plugin.addCommand({ id: "draft-selection-as-fragment", name: "Draft selection as fragment", editorCallback: (editor, ctx) => void draft(editor, ctx.file?.path ?? "", "fragment") });
  plugin.addCommand({ id: "draft-selection-as-thread", name: "Draft selection as thread", editorCallback: (editor, ctx) => void draft(editor, ctx.file?.path ?? "", "thread") });
  plugin.addCommand({
    id: "back-to-drafted-from-note",
    name: "Back to the note this draft came from",
    checkCallback: (checking) => {
      const path = app.workspace.getActiveFile()?.path;
      if (!path) return false;
      if (!checking) void goBack(path);
      return true;
    },
  });
  // The editor menu (long press in a note on a phone, right click on a desktop): only with text selected. A selection that holds a quote is offered as a thread only.
  plugin.registerEvent(
    app.workspace.on("editor-menu", (menu, editor, view) => {
      if (editor.getSelection().trim() === "" || !view.file) return;
      const path = view.file.path;
      const plan = planSelection(editor.getValue(), editor.getCursor("from"), editor.getCursor("to"));
      if (plan.kind === "empty") return;
      const fragment = plan.kind === "words";
      menu.addSeparator();
      if (fragment) menu.addItem((i) => i.setTitle(PM.menuFragment).setIcon("file-pen-line").onClick(() => void draft(editor, path, "fragment")));
      menu.addItem((i) => i.setTitle(PM.menuThread).setIcon("messages-square").onClick(() => void draft(editor, path, "thread")));
    }),
  );
}

const refuse = (message: string): null => {
  new Notice(message, 10000);
  return null;
};

/** A new note in the Blyg folder (the active note's own, else the first Studio folder), from the kind's template and the body. Nothing else is touched. */
async function createDraft(app: App, settings: BlygSettings, sourcePath: string, kind: ItemKind, body: string): Promise<TFile | null> {
  const route = newItemRoute(settings.routes, sourcePath === "" ? null : sourcePath);
  if (!route) return refuse(PM.draftNoFolder);
  const { vault } = app;
  try {
    const now = new Date();
    const name = newItemName(kind === "thread" ? "Thread" : "Fragment", now, (n) => vault.getAbstractFileByPath(`${route.vaultPrefix}${n}.md`) !== null);
    let template: string | null = null;
    const setting = settings.templates[kind];
    const tpath = templatePath(setting);
    if (tpath !== null) {
      const file = vault.getFileByPath(tpath) ?? app.metadataCache.getFirstLinkpathDest(tpath, "");
      if (!file || file.extension !== "md") return refuse(PM.draftTemplateMissing(setting));
      const m = moment(now);
      template = expandTemplate(await vault.read(file), { title: name, date: (f) => m.format(f ?? "YYYY-MM-DD"), time: (f) => m.format(f ?? "HH:mm") });
    }
    const composed = newItemText({ kind, template, body });
    if (!composed.ok) return refuse(PM.draftTemplateProblem);
    const folder = route.vaultPrefix.replace(/\/+$/, "");
    if (folder !== "" && !vault.getFolderByPath(folder)) await vault.createFolder(folder);
    return await vault.create(`${route.vaultPrefix}${name}.md`, composed.text);
  } catch {
    new Notice(PM.draftFailed, 8000);
    return null;
  }
}

/** Open the draft in a tab of its own with the cursor at its end, and say so with one tap back to the note. Never publishes. */
async function openDraft(app: App, file: TFile, origin: DraftOrigin, back: () => void): Promise<void> {
  const leaf = app.workspace.getLeaf("tab");
  await leaf.openFile(file, { state: { mode: "source" } });
  const view = leaf.view;
  if (view instanceof MarkdownView) {
    view.editor.setCursor({ line: view.editor.lastLine(), ch: view.editor.getLine(view.editor.lastLine()).length });
    view.editor.focus();
  }
  const frag = createFragment();
  frag.createSpan({ text: `${PM.draftMade(file.basename)} ` });
  const button = frag.createEl("button", { cls: "blyg-passage-toast-open", text: PM.backToNote });
  const notice = new Notice(frag, 12000);
  button.addEventListener("click", () => {
    notice.hide();
    back();
  });
  void origin;
}
