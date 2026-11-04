// The two windows of "Insert quote…": choose one of your published items, then quote all of it or a passage of what a reader
// sees. Drawing only; what the quote becomes is decided by src/app/threadCommands.ts. Built with createEl/text: the item's text
// is put in a read-only text box as plain text, never as HTML.
import { FuzzySuggestModal, Modal, Notice, type App } from "obsidian";
import { quoteBoxRows, type PickerCandidate, type QuoteChoice } from "../app/threadCommands";
import { TM } from "../app/threadMessages";
import type { Quotable } from "../publish/items";

/** Pick one of the candidates; resolves null when the window is closed without a choice. */
export function promptForItem(app: App, items: PickerCandidate[], placeholder = "Choose a published item to quote…"): Promise<PickerCandidate | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: PickerCandidate | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    class ItemPicker extends FuzzySuggestModal<PickerCandidate> {
      override getItems(): PickerCandidate[] {
        return items;
      }
      override getItemText(item: PickerCandidate): string {
        return `${item.excerpt === "" ? item.name : item.excerpt} · ${item.name}`;
      }
      override onChooseItem(item: PickerCandidate): void {
        settle(item);
      }
      override onClose(): void {
        super.onClose();
        // The choice may arrive just after the window closes: give it a moment before calling this "no choice".
        window.setTimeout(() => settle(null), 100);
      }
    }
    const picker = new ItemPicker(app);
    picker.setPlaceholder(placeholder);
    picker.open();
  });
}

/**
 * Show the item's text as a reader sees it. Selecting a passage in the text box and tapping “Quote the selection” returns that
 * passage; “Quote the whole item” returns the whole. Closing the window returns null.
 */
export function promptForQuote(app: App, item: Extract<Quotable, { ok: true }>): Promise<QuoteChoice | null> {
  return new Promise((resolve) => new QuoteModal(app, item, resolve).open());
}

class QuoteModal extends Modal {
  private decided = false;
  /** The last non-empty selection: tapping a button may clear the box's selection on some devices before the click arrives. */
  private lastSelection = "";
  private status: HTMLElement | null = null;
  private box: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    private readonly item: Extract<Quotable, { ok: true }>,
    private readonly resolve: (choice: QuoteChoice | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("blyg-quote");
    this.setTitle("Quote from this item");
    contentEl.createDiv({
      cls: "blyg-quote-help",
      text: `A ${this.item.kind}, version ${this.item.version}, as readers see it. To quote a passage: press and hold in the text, drag the handles over the passage, then tap “Quote the selection”. Or quote all of it.`,
    });
    const box = contentEl.createEl("textarea", { cls: "blyg-quote-text" });
    box.value = this.item.text;
    box.readOnly = true;
    // Sized to the text (a one-sentence note should not get a screen-high box), but never taller than the window can show.
    box.rows = quoteBoxRows(this.item.text);
    this.box = box;
    this.status = contentEl.createDiv({ cls: "blyg-quote-status", text: "Nothing selected yet." });
    for (const type of ["select", "keyup", "mouseup", "touchend", "pointerup"]) box.addEventListener(type, () => this.readSelection());

    // Our own button row, not a Setting: a Setting's row never wraps, and three buttons pushed Cancel off the left edge of a phone.
    const row = contentEl.createDiv({ cls: "blyg-quote-buttons" });
    const button = (text: string, onClick: () => void, cls?: string): void => {
      const el = row.createEl("button", { text, ...(cls ? { cls } : {}) });
      el.addEventListener("click", onClick);
    };
    button("Quote the selection", () => {
      const selected = this.readSelection();
      if (selected.trim() === "") {
        new Notice(TM.selectInBox, 6000);
        return;
      }
      this.finish({ kind: "passage", selected });
    }, "mod-cta");
    button("Quote the whole item", () => this.finish({ kind: "whole" }));
    button("Cancel", () => this.finish(null));
  }

  private readSelection(): string {
    const box = this.box;
    if (!box) return "";
    const now = box.value.slice(box.selectionStart, box.selectionEnd);
    if (now.trim() !== "") this.lastSelection = now;
    const shown = now.trim() !== "" ? now : this.lastSelection;
    this.status?.setText(shown.trim() === "" ? "Nothing selected yet." : `${shown.length} characters selected.`);
    return shown;
  }

  private finish(choice: QuoteChoice | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(choice);
    this.close();
  }

  override onClose(): void {
    if (!this.decided) {
      this.decided = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}
