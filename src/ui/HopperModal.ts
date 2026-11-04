// "Studio: choose hoppers for this note" (roadmap S13): the Studio's hoppers with a switch each, preset from the note's `blyg_hoppers`.
// Choosing only writes the property; the Studio changes when the note is sent. Plain text only.
import { Modal, Setting, type App } from "obsidian";
import type { StudioHopper } from "../studio/types";

class HopperModal extends Modal {
  private decided = false;
  private readonly on: Set<string>;

  constructor(
    app: App,
    private readonly hoppers: StudioHopper[],
    current: string[],
    /** Names in the note that match no hopper: kept off, and said so. */
    private readonly unknown: string[],
    private readonly resolve: (names: string[] | null) => void,
  ) {
    super(app);
    const lower = current.map((n) => n.toLowerCase());
    this.on = new Set(hoppers.filter((h) => lower.includes(h.name.toLowerCase()) || (h.slug !== null && lower.includes(h.slug.toLowerCase()))).map((h) => h.id));
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Hoppers for this note");
    contentEl.createDiv({ cls: "blyg-note", text: "Switch on the hoppers this item belongs in. The Studio changes when you publish or send the note; until then only the note's property changes." });
    if (this.hoppers.length === 0) contentEl.createDiv({ cls: "blyg-note", text: "The Studio has no hoppers yet. Make one in the Studio first." });
    for (const h of this.hoppers) {
      new Setting(contentEl)
        .setName(h.name)
        .setDesc(h.public ? "Public" : "Private")
        .addToggle((t) =>
          t.setValue(this.on.has(h.id)).onChange((v) => {
            if (v) this.on.add(h.id);
            else this.on.delete(h.id);
          }),
        );
    }
    if (this.unknown.length > 0) {
      contentEl.createDiv({ cls: "blyg-note", text: `Not in the Studio, so left out when you save: ${this.unknown.map((n) => `“${n}”`).join(", ")}.` });
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.finish(this.hoppers.filter((h) => this.on.has(h.id)).map((h) => h.name))))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)));
  }

  private finish(answer: string[] | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(answer);
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

export function chooseHoppers(app: App, hoppers: StudioHopper[], current: string[], unknown: string[]): Promise<string[] | null> {
  return new Promise((resolve) => new HopperModal(app, hoppers, current, unknown, resolve).open());
}
