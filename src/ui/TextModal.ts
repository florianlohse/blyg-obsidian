// A window that shows a block of plain text to read and copy (the repost map). Plain text only: nothing is inserted as HTML.
import { Modal, Setting, type App } from "obsidian";

export class TextModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly intro: string,
    private readonly text: string,
    private readonly copyDone: (ok: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.heading);
    contentEl.createDiv({ text: this.intro });
    const area = contentEl.createEl("textarea", { cls: "blyg-textmodal-area" });
    area.value = this.text;
    area.readOnly = true;
    area.rows = Math.min(14, this.text.split("\n").length + 1);
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Copy")
          .setCta()
          .onClick(() => {
            navigator.clipboard.writeText(this.text).then(
              () => this.copyDone(true),
              () => {
                area.select(); // the clipboard is blocked: the text is selected, to copy by hand
                this.copyDone(false);
              },
            );
          }),
      )
      .addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
  }
}
