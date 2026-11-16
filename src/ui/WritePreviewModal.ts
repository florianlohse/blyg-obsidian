// The window shown before every write that changes something (R2, decided): where it goes, what changes, and a clear
// choice. Built only with createEl/text: nothing from a note is ever inserted as HTML.
import { Modal, sanitizeHTMLToDom, Setting, type App, type ButtonComponent } from "obsidian";
import { diffText, type DiffBlock } from "../core/diff";
import type { Confirmation, WritePreview } from "../publish/types";

const MAX_DIFF_CHARS = 20_000;
const plural = (n: number): string => `${n} word${n === 1 ? "" : "s"}`;
const CONTEXT_LINES = 2;

const TITLES: Record<WritePreview["action"], string> = {
  create: "Commit a new item",
  update: "Commit a new version",
  withdraw: "Withdraw this item",
  "plain-create": "Commit a new page",
  "plain-update": "Commit an update",
  "studio-conflict": "The Studio’s copy was changed there",
  "studio-pull": "Replace this note with the online text",
  draft: "Send a draft to your Studio",
  "delete-draft": "Delete this draft",
};

/** The window's question: what is about to happen, in the plugin's words (a Studio write names the kind; the older GitHub mode keeps its commit titles). */
function titleOf(p: WritePreview): string {
  if (!p.studio) return p.action === "create" ? `Commit a new ${p.label}` : TITLES[p.action];
  if (p.studio.repost) return "Repost to your Studio";
  switch (p.action) {
    case "studio-conflict":
      return "Compare copies";
    case "studio-pull":
      return "Replace vault note?";
    case "draft":
      return "Send private draft?";
    case "delete-draft":
      return "Delete Studio draft?";
    case "withdraw":
      return "Withdraw item?";
    case "create":
      return `Publish ${p.label === "thread" ? "thread" : "fragment"}?`;
    default:
      return "Publish update?";
  }
}

/** The button that does it: the verb and its object, never just "Publish" (the question above names the same thing). */
function confirmLabel(p: WritePreview): string {
  if (!p.studio) return p.action === "withdraw" ? "Withdraw" : `Commit to ${p.branch}`;
  if (p.studio.repost) return "Publish";
  switch (p.action) {
    case "withdraw":
      return "Withdraw item";
    case "draft":
      return "Send draft";
    case "create":
      return `Publish ${p.label === "thread" ? "thread" : "fragment"}`;
    default:
      return "Publish update";
  }
}

function renderBlock(parent: HTMLElement, block: DiffBlock): void {
  if (block.kind === "same") {
    const lines = block.text.split("\n");
    const quiet = parent.createDiv({ cls: "blyg-diff-same" });
    if (lines.length > CONTEXT_LINES * 2 + 2) {
      quiet.setText(`${lines.slice(0, CONTEXT_LINES).join("\n")}\n…\n${lines.slice(-CONTEXT_LINES - 1).join("\n")}`);
    } else {
      quiet.setText(block.text);
    }
    return;
  }
  const change = parent.createDiv({ cls: "blyg-diff-change" });
  for (const op of block.ops) {
    change.createSpan({ cls: op.type === "add" ? "blyg-diff-add" : op.type === "del" ? "blyg-diff-del" : undefined, text: op.text });
  }
}

export class WritePreviewModal extends Modal {
  private decided = false;
  private note = "";
  private appendIds = true;
  /** The harmless button of a window that asks about something that cannot be undone: it holds the keyboard focus, so a stray Enter or tap declines. */
  private safe: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly preview: WritePreview,
    private readonly resolve: (answer: Confirmation) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    const p = this.preview;
    this.note = p.studio?.noteDefault ?? "";
    contentEl.addClass("blyg-preview");
    this.setTitle(titleOf(p));
    // Layout (styles.css): the target bar stays at the top and the buttons at the bottom; only the middle ("blyg-scroll")
    // scrolls. A long link list once pushed the diff out of reach on the iPad (0.0.10).

    // Class names changed from "blyg-target*" in 0.0.5: a stale stylesheet on the device (found on the iPad) painted the
    // old bar as an empty orange block. New names mean an old stylesheet cannot touch this element.
    contentEl.createDiv({
      // Red only where something goes public; a private draft, a deleted draft and a local overwrite are not "live" and get a neutral edge.
      cls: p.studio ? `blyg-where ${p.action === "draft" || p.action === "delete-draft" || p.action === "studio-pull" || p.action === "studio-conflict" ? "blyg-where-private" : "blyg-where-studio"}` : `blyg-where blyg-where-${p.channel}`,
      text: p.studio
        ? p.action === "draft"
          ? `Studio — ${p.studio.host} · draft only, nothing goes live`
          : p.action === "delete-draft"
            ? `Studio — ${p.studio.host} · deletes a draft that was never published`
            : p.action === "studio-pull"
              ? `Studio — ${p.studio.host} · nothing is sent, only this note changes`
              : p.action === "studio-conflict"
                ? `Studio — ${p.studio.host} · nothing has been changed yet`
                : p.action === "withdraw"
                  ? `Studio — ${p.studio.host} · public: the address will say “Withdrawn”`
                  : `Studio — ${p.studio.host} · goes live at once`
        : p.channel === "preview"
          ? `Preview — test channel · branch “${p.branch}”`
          : `Production — your real site · branch “${p.branch}”`,
    });

    const body = contentEl.createDiv({ cls: "blyg-scroll" });

    const facts = body.createEl("dl", { cls: "blyg-facts" });
    const fact = (label: string, value: string): void => {
      facts.createEl("dt", { text: label });
      facts.createEl("dd", { text: value });
    };
    fact("Note", p.noteName);
    if (p.studio) {
      fact("Item", p.path);
    } else {
      fact("Writes to", p.path);
      fact("Commit message", p.commitMessage);
    }

    if (p.studio?.askNote) {
      // Optional (decision 3): what changed, in a few words, for the item's changelog. Empty means no note. It stands at the TOP of the window:
      // at the bottom the phone's keyboard covered it (S2 device test, 2026-10-23, test 3).
      new Setting(body)
        .setName("Change note (optional)")
        .setDesc("Shown in the item’s changelog.")
        .addText((t) => {
          t.setPlaceholder("What changed?").onChange((v) => (this.note = v));
          // A repost starts with where the item came from; the user may change or empty it.
          if (p.studio?.noteDefault) t.setValue(p.studio.noteDefault);
          t.inputEl.addEventListener("focus", () => window.setTimeout(() => t.inputEl.scrollIntoView({ block: "start", behavior: "smooth" }), 300));
        });
    }

    if (p.changes.length > 0) {
      const list = body.createEl("ul", { cls: "blyg-changes" });
      for (const change of p.changes) list.createEl("li", { text: change });
    }

    if (p.action === "studio-conflict") {
      body.createDiv({
        cls: "blyg-warning",
        text: "The Studio working copy of this item was edited in the Studio since this note last sent it, and it differs from this vault note. Nothing has been changed yet. Below: the Studio working copy (before) and this vault note (after).",
      });
      this.renderDiff(body);
      // What each choice does next, said before the buttons (verified in the publish flow: the second one is followed by the normal publish window, it does not publish by itself).
      const choices = body.createEl("ul", { cls: "blyg-choices" });
      choices.createEl("li", { text: "Replace note from Studio: this vault note’s text becomes the Studio working copy. Nothing is sent to the Studio." });
      choices.createEl("li", { text: "Replace Studio copy from note: the Studio working copy is overwritten with this vault note’s text. The publish window follows, and nothing goes public until you confirm there." });
      const footer = contentEl.createDiv({ cls: "blyg-footer" });
      new Setting(footer)
        .addButton((b) => ((this.safe = b), b.setButtonText("Cancel").onClick(() => this.finish(false))))
        .addButton((b) => b.setButtonText("Replace note from Studio").setDestructive().onClick(() => this.finish({ note: "", pull: true })))
        .addButton((b) => b.setButtonText("Replace Studio copy from note").setDestructive().onClick(() => this.finish(true)));
      this.focusSafe();
      return;
    }

    if (p.action === "studio-pull") {
      body.createDiv({
        cls: "blyg-warning",
        text: "The Studio working copy will replace this note’s text (on this device). Nothing is sent to the Studio, and the note’s properties stay. Below: this vault note as it is (before) and the Studio working copy (after).",
      });
      this.renderDiff(body);
      const ids = p.blockIds ?? [];
      if (ids.length > 0) {
        body.createDiv({
          cls: "blyg-warning",
          text: `The note has ${ids.length} block id${ids.length === 1 ? "" : "s"} (^…), which the online text does not have: links like ![[note#^id]] and Resurface’s marks that point to ${ids.length === 1 ? "it" : "them"} stop working. Ids: ${ids.map((i) => "^" + i.id).join(", ")}.`,
        });
        new Setting(body)
          .setName("Write the ids to the end of the note")
          .setDesc("In a private %% comment, so they are never published and you can still see which paragraph each one belonged to.")
          .addToggle((t) => t.setValue(this.appendIds).onChange((v) => (this.appendIds = v)));
      }
      const footer = contentEl.createDiv({ cls: "blyg-footer" });
      new Setting(footer)
        .addButton((b) => ((this.safe = b), b.setButtonText("Cancel").onClick(() => this.finish(false))))
        .addButton((b) =>
          b.setButtonText("Replace vault note").setDestructive().onClick(() => this.finish(ids.length > 0 ? { note: "", appendIds: this.appendIds } : true)),
        );
      this.focusSafe();
      return;
    }

    if (p.action === "delete-draft") {
      body.createDiv({
        cls: "blyg-warning",
        text: `The private draft will be removed from ${p.studio?.host ?? "the Studio"} for good. It was never published, so nothing public changes. Your vault note keeps its text. Below: the draft’s text (before).`,
      });
      this.renderDiff(body);
      const footer = contentEl.createDiv({ cls: "blyg-footer" });
      new Setting(footer)
        .addButton((b) => ((this.safe = b), b.setButtonText("Cancel").onClick(() => this.finish(false))))
        .addButton((b) => b.setButtonText("Delete draft").setDestructive().onClick(() => this.finish(true)));
      this.focusSafe();
      return;
    }

    if (p.action === "draft") {
      body.createDiv({
        cls: "blyg-warning",
        text: "Nothing goes live. This sends the note’s text to the Studio as a draft (or as the working copy of an item); only you can see it there. Publish it in the Studio, or move the note to a normal Studio folder and tap Publish….",
      });
    }

    if (p.studio?.repost) {
      const old = p.studio.repost;
      body.createDiv({
        cls: "blyg-warning",
        text: `This publishes the note’s text as a new item, with a new address and today’s date. The old item (${old.id}${old.version !== null ? `, version ${old.version}` : ""}${old.origin ? ` at ${old.origin}` : ""}) stays where it is, untouched; the note remembers it as blyg_previous.`,
      });
    }
    this.renderThread(body);
    this.renderStudioQuotes(body);
    this.renderLinks(body);
    // A new version: what changed comes first and the Studio's rendering of the whole text waits behind a tap. A first send: the rendering is the one
    // preview (the same words again as "New text" in all-green is dropped, unless the Studio gave no rendering).
    const update = p.studio !== undefined && p.action === "update";
    const firstSend = p.studio !== undefined && p.before === null && (p.action === "create" || p.action === "draft") && p.studio.html.trim() !== "";
    if (update) this.renderDiff(body);
    this.renderStudioRendering(body, update);

    if (p.action === "withdraw") {
      body.createDiv({
        cls: "blyg-warning",
        text: "A withdrawal cannot be deleted: the address stays public and will say “Withdrawn”. Your vault note keeps its text. You can publish the note again later, which creates a new version.",
      });
    } else if (!update && !firstSend) {
      this.renderDiff(body);
    }

    const footer = contentEl.createDiv({ cls: "blyg-footer" });
    new Setting(footer)
      .addButton((b) => ((this.safe = b), b.setButtonText("Cancel").onClick(() => this.finish(false))))
      .addButton((b) => {
        b.setButtonText(confirmLabel(p));
        // Taking something public back is the one choice here with a red button; everything else is the plain primary action.
        if (p.action === "withdraw") b.setDestructive();
        else b.setCta();
        b.onClick(() => this.finish(true));
      });
    if (p.action === "withdraw") this.focusSafe();
  }

  /** Hand the keyboard focus to the harmless button (after the window is drawn). */
  private focusSafe(): void {
    const el: HTMLElement | undefined = this.safe?.buttonEl;
    window.setTimeout(() => el?.focus(), 50);
  }

  /** Studio only, threads: what the Studio resolved each quote to. Plain text, never HTML. */
  private renderStudioQuotes(parent: HTMLElement): void {
    const quotes = this.preview.studio?.quotes;
    if (!quotes || quotes.length === 0) return;
    parent.createDiv({ cls: "blyg-diff-heading", text: `Quotes in this ${this.preview.label === "thread" ? "thread" : "fragment"}` });
    const list = parent.createEl("ul", { cls: "blyg-quotes" });
    for (const q of quotes) {
      const what = q.passage === null ? "whole" : "passage";
      const from = q.remote ? "another blyg" : "your Studio";
      const name = q.label ?? `${q.id.slice(0, 8)}…`;
      list.createEl("li", { text: `${what} · ${name} v${q.version} · ${from}${q.passage === null ? "" : ` — “${q.passage}”`}` });
    }
  }

  /**
   * Threads: what the thread quotes (taken from the site as it is now, frozen into the file) and which items it links to. The
   * passage or the source's first words are shown as plain text, never as HTML.
   */
  private renderThread(parent: HTMLElement): void {
    const t = this.preview.thread;
    if (!t || (t.quotes.length === 0 && t.itemLinks.length === 0)) return;
    if (t.quotes.length > 0) {
      parent.createDiv({ cls: "blyg-diff-heading", text: `Quotes in this ${this.preview.label === "thread" ? "thread" : "fragment"}` });
      const list = parent.createEl("ul", { cls: "blyg-quotes" });
      for (const q of t.quotes) {
        const state =
          q.change === "new" ? "new" : q.change === "moved" ? `moved from v${q.fromVersion ?? "?"} to v${q.version}` : `unchanged (v${q.version})`;
        const what = q.passage === null ? "whole" : "passage";
        list.createEl("li", { cls: q.change === "moved" ? "blyg-quote-moved" : undefined, text: `${what} · ${q.kind} ${q.id.slice(0, 8)}… v${q.version} · ${state} — “${q.passage ?? q.excerpt}”` });
      }
    }
    if (t.itemLinks.length > 0) {
      parent.createDiv({ cls: "blyg-diff-heading", text: "Links to other items" });
      const list = parent.createEl("ul", { cls: "blyg-quotes" });
      for (const l of t.itemLinks) list.createEl("li", { text: `${l.id.slice(0, 8)}… — shown as ${l.label === "" ? "“a fragment”" : l.label}${l.isNew ? "" : " (kept as published)"}` });
    }
  }

  /**
   * Studio only: how the Studio renders the text, as readers will see it. The HTML is the Studio's, built from the note and, in
   * threads, from other blygs' items: foreign, so it goes through the sanitiser and never in as raw HTML (docs/SECURITY.md §2).
   */
  private renderStudioRendering(parent: HTMLElement, collapsed = false): void {
    const studio = this.preview.studio;
    if (!studio || studio.html.trim() === "") return;
    if (collapsed) {
      const more = parent.createEl("details", { cls: "blyg-studio-more" });
      more.createEl("summary", { text: "As readers will see it" });
      more.createDiv({ cls: "blyg-studio-render" }).appendChild(sanitizeHTMLToDom(studio.html));
      return;
    }
    parent.createDiv({ cls: "blyg-diff-heading", text: "As readers will see it" });
    parent.createDiv({ cls: "blyg-studio-render" }).appendChild(sanitizeHTMLToDom(studio.html));
  }

  /** Every wikilink in the text and how it was judged, so the verdict is never a black box. */
  private renderLinks(parent: HTMLElement): void {
    const p = this.preview;
    if (p.links.length === 0) return;
    parent.createDiv({ cls: "blyg-diff-heading", text: "Links in this text" });
    const list = parent.createEl("ul", { cls: "blyg-links" });
    for (const link of p.links) {
      const name = `${link.embed ? "!" : ""}[[${link.target}]]`;
      const verdict =
        link.kind === "published"
          ? `${link.path ?? ""} — in a publish folder`
          : link.kind === "outside"
            ? `${link.path ?? ""} — NOT in a publish folder`
            : link.kind === "file"
              ? `${link.path ?? ""} — a file, not a note`
              : "no such note in your vault";
      const folderNote = link.folder && !link.embed ? " — written with a folder path: the site looks the note up by its name only, and other blygs receive the path as typed" : "";
      list.createEl("li", { cls: link.kind === "outside" ? "blyg-link-outside" : undefined, text: `${name} → ${verdict}${folderNote}` });
    }
    if (p.blygNote && p.links.some((l) => !l.embed)) {
      parent.createDiv({
        cls: "blyg-diff-same",
        text: "On the site's pages [[wikilinks]] become links to essays, found by name; a link to anything else is dead, and the site then refuses to deploy. In the feed that other blygs read they stay as typed.",
      });
    }
  }

  private renderDiff(parent: HTMLElement): void {
    const p = this.preview;
    const before = p.before ?? "";
    const diff = diffText(before, p.after);
    const heading = parent.createDiv({ cls: "blyg-diff-heading" });
    if (p.before === null) heading.setText("New text");
    else heading.setText(`Changes: +${plural(diff.addedWords)}, −${plural(diff.removedWords)}`);

    const box = parent.createDiv({ cls: "blyg-diff" });
    if (p.before === null) {
      box.createDiv({ cls: "blyg-diff-change" }).createSpan({ cls: "blyg-diff-add", text: p.after });
    } else if (before.length + p.after.length > MAX_DIFF_CHARS) {
      box.createDiv({ cls: "blyg-diff-same", text: "The text is long, so the word-by-word view is skipped. The commit replaces the file with your note's current text." });
    } else {
      for (const block of diff.blocks) renderBlock(box, block);
    }
  }

  private finish(answer: boolean | { note: string; pull?: boolean; appendIds?: boolean }): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(typeof answer === "object" ? answer : answer && this.preview.studio?.askNote ? { note: this.note } : answer);
    this.close();
  }

  override onClose(): void {
    // Closing the window any other way (back swipe, Escape) means "no".
    if (!this.decided) {
      this.decided = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}

export function confirmWithModal(app: App, preview: WritePreview): Promise<Confirmation> {
  return new Promise((resolve) => new WritePreviewModal(app, preview, resolve).open());
}
