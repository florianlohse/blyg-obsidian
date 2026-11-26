// A small question with buttons, asked BEFORE anything is written ("this selection quotes another post: draft as a thread?"). Resolves the chosen index, or null when
// the window is closed. Text only (textContent); no input.
import { Modal, type App } from "obsidian";
import { PM } from "../app/passageMessages";

export interface AskOption {
  label: string;
  hint?: string;
  primary?: boolean;
}

export function askBeforeDrafting(app: App, title: string, body: string, options: AskOption[]): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    class Ask extends Modal {
      override onOpen(): void {
        this.modalEl.addClass("blyg-passage-modal");
        this.contentEl.createDiv({ cls: "blyg-passage-title", text: title });
        this.contentEl.createDiv({ cls: "blyg-passage-sub", text: body });
        const box = this.contentEl.createDiv({ cls: "blyg-passage-actions" });
        options.forEach((o, i) => {
          const b = box.createEl("button", { cls: o.primary ? "mod-cta" : "", text: o.label });
          if (o.hint) b.createSpan({ cls: "blyg-passage-hint", text: ` ${o.hint}` });
          b.addEventListener("click", () => {
            done(i);
            this.close();
          });
        });
        box.createEl("button", { text: PM.cancel }).addEventListener("click", () => this.close());
      }
      override onClose(): void {
        this.contentEl.empty();
        done(null);
      }
    }
    new Ask(app).open();
  });
}
