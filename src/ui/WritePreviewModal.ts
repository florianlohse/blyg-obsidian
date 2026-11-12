// The window shown before every write that changes something (R2, decided): where it goes, what changes, and a clear
// choice. Built only with createEl/text: nothing from a note is ever inserted as HTML.
import { Modal, sanitizeHTMLToDom, Setting, type App } from "obsidian";
import { showLocalImages } from "./localImages";
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
    this.setTitle(
      p.action === "studio-conflict" || p.action === "studio-pull" || p.action === "draft" || p.action === "delete-draft"
        ? TITLES[p.action]
        : p.studio
          ? p.studio.repost
            ? "Repost to your Studio"
            : p.action === "withdraw"
            ? "Withdraw this item from your Studio"
            : p.action === "create"
            ? `Publish a new ${p.label} to your Studio`
            : "Publish a new version to your Studio"
          : p.action === "create"
            ? `Commit a new ${p.label}`
            : TITLES[p.action],
    );
    // Layout (styles.css): the target bar stays at the top and the buttons at the bottom; only the middle ("blyg-scroll")
    // scrolls. A long link list once pushed the diff out of reach on the iPad (0.0.10).

    // Class names changed from "blyg-target*" in 0.0.5: a stale stylesheet on the device (found on the iPad) painted the
    // old bar as an empty orange block. New names mean an old stylesheet cannot touch this element.
    contentEl.createDiv({
      cls: p.studio ? "blyg-where blyg-where-studio" : `blyg-where blyg-where-${p.channel}`,
      text: p.studio
        ? p.action === "draft"
          ? `Studio — ${p.studio.host} · draft only, nothing goes live`
          : p.action === "delete-draft"
            ? `Studio — ${p.studio.host} · deletes a draft that was never published`
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
        text: "The working copy of this item was edited in the Studio since this note last sent it, and it differs from this note. Two ways out: “Replace the online copy with this note” sends this note’s text to the Studio and overwrites the online copy; “Replace this note with the online text” overwrites this note (on this device) with the online copy and sends nothing. Below: the online copy (before) and this note (after).",
      });
      this.renderDiff(body);
      const footer = contentEl.createDiv({ cls: "blyg-footer" });
      new Setting(footer)
        .addButton((b) => b.setButtonText("Cancel").setCta().onClick(() => this.finish(false)))
        .addButton((b) => b.setButtonText("Replace this note with the online text").onClick(() => this.finish({ note: "", pull: true })))
        .addButton((b) => b.setButtonText("Replace the online copy with this note").setDestructive().onClick(() => this.finish(true)));
      return;
    }

    if (p.action === "studio-pull") {
      body.createDiv({
        cls: "blyg-warning",
        text: "This replaces the text of this note (on this device) with the online working copy of the item. Nothing is sent to the Studio, and the note’s properties stay. Below: this note as it is (before) and the online copy (after).",
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
        .addButton((b) => b.setButtonText("Cancel").setCta().onClick(() => this.finish(false)))
        .addButton((b) =>
          b.setButtonText("Replace this note with the online text").setDestructive().onClick(() => this.finish(ids.length > 0 ? { note: "", appendIds: this.appendIds } : true)),
        );
      return;
    }

    if (p.action === "delete-draft") {
      body.createDiv({
        cls: "blyg-warning",
        text: "This deletes the draft from the Studio for good. It was never published, so nothing public changes. The note keeps its text. Below: the draft’s text (before).",
      });
      this.renderDiff(body);
      const footer = contentEl.createDiv({ cls: "blyg-footer" });
      new Setting(footer)
        .addButton((b) => b.setButtonText("Cancel").setCta().onClick(() => this.finish(false)))
        .addButton((b) => b.setButtonText("Delete draft").setDestructive().onClick(() => this.finish(true)));
      return;
    }

    if (p.action === "draft") {
      body.createDiv({
        cls: "blyg-warning",
        text: "Nothing goes live. This sends the note’s text to the Studio as a draft (or as the working copy of an item); only you can see it there. Publish it in the Studio, or move the note to a normal Studio folder and tap Publish.",
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
    this.renderStudioRendering(body);

    if (p.action === "withdraw") {
      body.createDiv({
        cls: "blyg-warning",
        text: "A withdrawal cannot be deleted: the id stays on the web forever as “withdrawn”. You can publish the note again later, which creates a new version.",
      });
    } else {
      this.renderDiff(body);
    }

    const footer = contentEl.createDiv({ cls: "blyg-footer" });
    new Setting(footer)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
      .addButton((b) => {
        b.setButtonText(p.action === "withdraw" ? "Withdraw" : p.action === "draft" ? "Send draft" : p.studio ? "Publish" : `Commit to ${p.branch}`).setCta().onClick(() => this.finish(true));
        if (p.action === "withdraw") b.setDestructive();
      });
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
  private renderStudioRendering(parent: HTMLElement): void {
    const studio = this.preview.studio;
    if (!studio || studio.html.trim() === "") return;
    parent.createDiv({ cls: "blyg-diff-heading", text: "As readers will see it" });
    const rendered = sanitizeHTMLToDom(studio.html);
    // After the sanitiser: the pictures the note embeds are shown from the vault, in place of the stand-in addresses the Studio cannot serve yet.
    if (studio.localImages && studio.localImages.length > 0) {
      showLocalImages(rendered, studio.localImages, (path) => {
        const file = this.app.vault.getFileByPath(path);
        return file ? this.app.vault.getResourcePath(file) : null;
      });
    }
    parent.createDiv({ cls: "blyg-studio-render" }).appendChild(rendered);
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
