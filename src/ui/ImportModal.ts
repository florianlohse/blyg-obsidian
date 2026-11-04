// The checklist of "Studio: import new items" (roadmap S7): one row per Studio item without a note, a toggle each, ticked unless the item
// has something the plugin cannot take over (images). Plain text only: item text is never inserted as HTML.
import { Modal, Setting, type App } from "obsidian";
import type { ImportCandidate } from "../studio/import";

export interface ImportChoice {
  /** The ids to import. */
  chosen: string[];
  /** Unticked ids the owner asked not to be offered again. */
  ignore: string[];
  /** The folder chosen in the window (a Studio route's folder). */
  folder: string;
}

export interface ImportListInfo {
  /** Preselected: the Import folder of the settings (or its default). */
  folder: string;
  /** Every Studio folder, for the window's own choice. */
  folders: Array<{ value: string; label: string }>;
  candidates: ImportCandidate[];
  /** Lines under the list: what was not listed and why. */
  notes: string[];
  /** Ids on the "don't offer again" list that are shown again in this list (after "Show hidden items"). */
  hiddenShown: boolean;
  /** How many items the "don't offer again" list hides; with a button to show them. */
  hidden: number;
}

const TITLE_MAX = 90;

class ImportModal extends Modal {
  private decided = false;
  private readonly ticked: Set<string>;
  private ignoreRest = false;
  private folder: string;

  constructor(
    app: App,
    private readonly info: ImportListInfo,
    private readonly resolve: (answer: ImportChoice | "show-hidden" | null) => void,
  ) {
    super(app);
    this.ticked = new Set(info.candidates.filter((c) => c.preselected).map((c) => c.id));
    this.folder = info.folder;
  }

  override onOpen(): void {
    const { contentEl } = this;
    const { candidates } = this.info;
    this.setTitle("Import new items");
    contentEl.addClass("blyg-import");
    contentEl.createDiv({
      cls: "blyg-note",
      text: `${candidates.length} item${candidates.length === 1 ? "" : "s"} in the Studio ${candidates.length === 1 ? "has" : "have"} no note. The ticked ones become notes in the folder below. Nothing is sent to the Studio.`,
    });
    new Setting(contentEl)
      .setName("Into folder")
      .setDesc("For this import only; the default comes from the plugin settings.")
      .addDropdown((d) => {
        for (const f of this.info.folders) d.addOption(f.value, f.label);
        d.setValue(this.folder).onChange((value) => (this.folder = value));
      });
    const list = contentEl.createDiv({ cls: "blyg-import-list" });
    for (const c of candidates) {
      const title = c.title === "" ? "(no text)" : c.title.length > TITLE_MAX ? `${c.title.slice(0, TITLE_MAX - 1)}…` : c.title;
      const meta = [c.kind, c.status === "draft" ? "draft" : c.dirty ? `v${c.version}, with unpublished changes` : `v${c.version}`, c.created.slice(0, 10), ...(c.stubOf ? ["reply"] : [])].filter((s) => s !== "").join(" · ");
      const row = new Setting(list).setName(title).setDesc(meta);
      if (c.caution) row.descEl.createDiv({ cls: "blyg-import-caution", text: c.caution });
      row.addToggle((t) =>
        t.setValue(this.ticked.has(c.id)).onChange((on) => {
          if (on) this.ticked.add(c.id);
          else this.ticked.delete(c.id);
          this.refreshButton();
        }),
      );
    }
    for (const line of this.info.notes) contentEl.createDiv({ cls: "blyg-note", text: line });
    if (this.info.hidden > 0 && !this.info.hiddenShown) {
      new Setting(contentEl)
        .setName(`${this.info.hidden} item${this.info.hidden === 1 ? " is" : "s are"} hidden (you chose not to import ${this.info.hidden === 1 ? "it" : "them"})`)
        .addButton((b) => b.setButtonText("Show").onClick(() => this.finish("show-hidden")));
    }
    new Setting(contentEl)
      .setName("Don't offer the unticked ones again")
      .setDesc("For notes you deleted on purpose. Ticking an item later brings it back.")
      .addToggle((t) => t.setValue(false).onChange((on) => (this.ignoreRest = on)));
    new Setting(contentEl)
      .addButton((b) => {
        this.button = b.buttonEl;
        b.setCta().onClick(() => this.finish({ chosen: candidates.filter((c) => this.ticked.has(c.id)).map((c) => c.id), ignore: this.ignoreRest ? candidates.filter((c) => !this.ticked.has(c.id)).map((c) => c.id) : [], folder: this.folder }));
      })
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)));
    this.refreshButton();
  }

  private button: HTMLButtonElement | null = null;

  private refreshButton(): void {
    if (!this.button) return;
    const n = this.ticked.size;
    this.button.setText(n === 0 ? "Import none" : `Import ${n}`);
  }

  private finish(answer: ImportChoice | "show-hidden" | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(answer);
    this.close();
  }

  override onClose(): void {
    // Closing the window any other way (back swipe, Escape) means "no".
    if (!this.decided) {
      this.decided = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}

export function chooseImports(app: App, info: ImportListInfo): Promise<ImportChoice | "show-hidden" | null> {
  return new Promise((resolve) => new ImportModal(app, info, resolve).open());
}
