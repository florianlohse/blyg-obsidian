// "Insert web quote" (docs/plans/S20-web-quote.md): a form for a passage from a web page and its address. NOT a blyg operation: it writes ordinary
// Markdown into the open note and nothing else. The text typed is kept on this device as a draft (device-local storage, not the settings file),
// because on an iPhone the app can be ended while you are in the browser copying the address (measured 2026-11-07, plan §2).
import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import { buildWebQuote, DRAFT_KEY, draftIsEmpty, formState, parseDraft, type WebQuoteInput, type WebQuoteOptions } from "../core/webQuote";

class WebQuoteModal extends Modal {
  private input: WebQuoteInput;
  private restored: boolean;
  private done = false;
  private quoteBox: HTMLTextAreaElement | null = null;
  private linkBox: HTMLInputElement | null = null;
  private aliasBox: HTMLInputElement | null = null;
  private insertButton: ButtonComponent | null = null;
  private problemEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly options: WebQuoteOptions,
    selection: string,
    /** Puts the block into the note; false when it could not (the draft is then kept). */
    private readonly insert: (block: string) => boolean,
  ) {
    super(app);
    const draft = parseDraft(app.loadLocalStorage(DRAFT_KEY));
    // The text selected in the note is the quote; the rest of an earlier draft (address, alias) still applies.
    this.input = { quote: selection.trim() !== "" ? selection : draft.quote, link: draft.link, alias: draft.alias };
    this.restored = draft.link.trim() !== "" || draft.alias.trim() !== "" || (selection.trim() === "" && draft.quote.trim() !== "");
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Insert web quote");
    contentEl.addClass("blyg-webquote");
    contentEl.createDiv({
      cls: "blyg-note",
      text: "A quote from a web page, written as ordinary Markdown in this note. It is not a blyg item: nothing is checked, fetched or sent.",
    });

    new Setting(contentEl)
      .setName("Quote")
      .setClass("blyg-webquote-field")
      .addTextArea((t) => {
        t.setPlaceholder("The passage, pasted").setValue(this.input.quote).onChange((v) => this.typed({ quote: v }));
        t.inputEl.rows = 5;
        this.quoteBox = t.inputEl;
        this.scrollOnFocus(t.inputEl);
      });

    new Setting(contentEl)
      .setName("Link")
      .setClass("blyg-webquote-field")
      .addText((t) => {
        t.setPlaceholder("Web address of the page").setValue(this.input.link).onChange((v) => this.typed({ link: v }));
        t.inputEl.inputMode = "url";
        this.linkBox = t.inputEl;
        this.scrollOnFocus(t.inputEl);
      })
      .addButton((b) => b.setButtonText("Paste").onClick(() => void this.pasteLink()));
    this.problemEl = contentEl.createDiv({ cls: "blyg-issue blyg-webquote-problem" });

    new Setting(contentEl)
      .setName("Alias (optional)")
      .setDesc("The visible text of the link. Empty: the address, shortened.")
      .setClass("blyg-webquote-field")
      .addText((t) => {
        t.setPlaceholder("Title of the post").setValue(this.input.alias).onChange((v) => this.typed({ alias: v }));
        this.aliasBox = t.inputEl;
        this.scrollOnFocus(t.inputEl);
      });

    contentEl.createDiv({ cls: "blyg-webquote-label", text: "Will be written as" });
    this.previewEl = contentEl.createDiv({ cls: "blyg-webquote-preview" });
    this.noteEl = contentEl.createDiv({ cls: "blyg-note" });

    new Setting(contentEl)
      .addButton((b) => {
        this.insertButton = b;
        b.setButtonText("Insert").setCta().onClick(() => this.finish());
      })
      .addButton((b) => b.setButtonText("Clear").onClick(() => this.clear()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

    if (this.restored) new Notice("Draft restored");
    this.refresh();
  }

  /** On a phone the keyboard covers the lower fields: bring the one being typed in into view (the pattern of the change-note field). */
  private scrollOnFocus(el: HTMLElement): void {
    el.addEventListener("focus", () => window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 300));
  }

  private typed(part: Partial<WebQuoteInput>): void {
    this.input = { ...this.input, ...part };
    this.app.saveLocalStorage(DRAFT_KEY, draftIsEmpty(this.input) ? null : JSON.stringify(this.input));
    this.refresh();
  }

  private refresh(): void {
    const state = formState(this.input, this.options);
    this.insertButton?.setDisabled(!state.canInsert);
    this.problemEl?.setText(state.linkProblem);
    this.previewEl?.setText(state.preview);
    this.noteEl?.setText(state.formatFellBack ? "The format in Settings → Web quote is not usable, so the default format is used." : "");
  }

  private async pasteLink(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      // A shared page often brings a title with the address: take the address.
      const address = /https?:\/\/\S+/.exec(text)?.[0] ?? text.trim();
      if (this.linkBox) this.linkBox.value = address;
      this.typed({ link: address });
    } catch {
      new Notice("The clipboard could not be read. Paste into the link field by hand.");
    }
  }

  private clear(): void {
    this.input = { quote: "", link: "", alias: "" };
    if (this.quoteBox) this.quoteBox.value = "";
    if (this.linkBox) this.linkBox.value = "";
    if (this.aliasBox) this.aliasBox.value = "";
    this.app.saveLocalStorage(DRAFT_KEY, null);
    this.refresh();
  }

  private finish(): void {
    if (this.done) return;
    const built = buildWebQuote(this.input, this.options);
    if (!built.ok) {
      new Notice(built.reason);
      return;
    }
    if (!this.insert(built.text)) return; // the note could not take it: the window and the draft stay
    this.done = true;
    this.app.saveLocalStorage(DRAFT_KEY, null);
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export function openWebQuote(app: App, options: WebQuoteOptions, selection: string, insert: (block: string) => boolean): void {
  new WebQuoteModal(app, options, selection, insert).open();
}
