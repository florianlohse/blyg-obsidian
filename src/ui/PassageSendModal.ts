// "Send passage to note": the window with two steps. Step 1 lists the notes of the folders chosen in the settings (recent destinations first, folder chips that can
// only narrow); step 2 lists that note's headings plus "End of note". Nothing is written here: the window gives back the choice and src/app/passageEntry.ts writes.
// On a phone Obsidian draws a Modal from the bottom edge, which is the sheet of the design. Text only (textContent), the passage shown is a stranger's.
import { Modal, type App } from "obsidian";
import type { NoteHeading } from "../app/noteHeadings";
import { PM } from "../app/passageMessages";
import { destinationList, type DestinationNote, type DestinationVerdict, type RecentDestination } from "../app/passageScope";
import type { PassageTarget } from "../app/passageInsert";

export interface PassagePickerPort {
  /** The text to be sent, shown above the list so the writer sees what goes. */
  passage: string;
  folders: string[];
  notes(): DestinationNote[];
  recent: RecentDestination[];
  headingsOf(path: string): Promise<NoteHeading[] | null>;
  verdictOf(path: string): DestinationVerdict;
}

export interface PassageChoice {
  path: string;
  name: string;
  target: PassageTarget;
  /** The heading's text for the confirmation sentence; null for the end of the note. */
  headingText: string | null;
  /** The note is an unpublished fragment and the writer chose to make it a thread. */
  convert: boolean;
}

const PREVIEW_CHARS = 180;

export function choosePassageDestination(app: App, port: PassagePickerPort): Promise<PassageChoice | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: PassageChoice | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    new PassageModal(app, port, done).open();
  });
}

class PassageModal extends Modal {
  private narrowed: string[] = [];
  private query = "";
  private listEl: HTMLElement | null = null;

  constructor(app: App, private readonly port: PassagePickerPort, private readonly done: (v: PassageChoice | null) => void) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("blyg-passage-modal");
    this.step1();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(null);
  }

  private head(sub: string): void {
    this.contentEl.empty();
    const h = this.contentEl.createDiv({ cls: "blyg-passage-head" });
    h.createDiv({ cls: "blyg-passage-title", text: PM.sheetTitle });
    h.createDiv({ cls: "blyg-passage-sub", text: sub });
    const p = this.port.passage.replace(/\s+/g, " ").trim();
    this.contentEl.createDiv({ cls: "blyg-passage-preview", text: p.length > PREVIEW_CHARS ? `${p.slice(0, PREVIEW_CHARS).trimEnd()}…` : p });
  }

  private step1(): void {
    this.head(PM.step1);
    const search = this.contentEl.createEl("input", { cls: "blyg-passage-search", type: "text", attr: { placeholder: PM.searchPlaceholder, "aria-label": PM.searchPlaceholder, enterkeyhint: "search" } });
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.drawList();
    });
    if (this.port.folders.length > 1) {
      const chips = this.contentEl.createDiv({ cls: "blyg-passage-chips" });
      for (const f of this.port.folders) {
        const on = this.narrowed.includes(f);
        const chip = chips.createEl("button", { cls: `blyg-passage-chip${on ? " is-on" : ""}`, text: f, attr: { "aria-pressed": String(on) } });
        chip.addEventListener("click", () => {
          this.narrowed = on ? this.narrowed.filter((x) => x !== f) : [...this.narrowed, f];
          this.step1();
        });
      }
    }
    this.listEl = this.contentEl.createDiv({ cls: "blyg-passage-list" });
    this.drawList();
  }

  private drawList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const all = destinationList(this.port.notes(), { folders: this.port.folders, narrowed: this.narrowed, recent: this.port.recent, query: this.query });
    if (all.recent.length + all.others.length === 0) {
      list.createDiv({ cls: "blyg-passage-empty", text: this.query.trim() === "" ? PM.noneAtAll : PM.none });
      return;
    }
    const group = (title: string, notes: DestinationNote[]): void => {
      if (notes.length === 0) return;
      if (this.query.trim() === "") list.createDiv({ cls: "blyg-passage-group", text: title });
      for (const n of notes) {
        const row = list.createEl("button", { cls: "blyg-passage-row" });
        row.createDiv({ cls: "blyg-passage-name", text: n.name });
        row.createDiv({ cls: "blyg-passage-where", text: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "" });
        row.addEventListener("click", () => void this.pickNote(n));
      }
    };
    group(PM.recent, all.recent);
    group(PM.others, all.others);
  }

  private async pickNote(n: DestinationNote): Promise<void> {
    const verdict = this.port.verdictOf(n.path);
    if (!verdict.ok) return this.refusal(n, verdict.reason);
    await this.step2(n, false);
  }

  /** A note that cannot hold a quote: said before anything is written. */
  private refusal(n: DestinationNote, reason: "plain-route" | "fragment" | "published-fragment"): void {
    this.head(reason === "plain-route" ? PM.sheetTitle : PM.fragmentTitle(n.name));
    const box = this.contentEl.createDiv({ cls: "blyg-passage-actions" });
    if (reason === "plain-route") {
      this.contentEl.createDiv({ cls: "blyg-passage-sub", text: PM.plainRoute(n.name) });
    } else {
      this.contentEl.createDiv({ cls: "blyg-passage-sub", text: reason === "fragment" ? PM.fragmentBody : `${PM.fragmentBody} ${PM.publishedFragment}` });
      if (reason === "fragment") {
        const convert = box.createEl("button", { cls: "mod-cta", text: PM.convert });
        convert.createSpan({ cls: "blyg-passage-hint", text: ` ${PM.convertHint}` });
        convert.addEventListener("click", () => void this.step2(n, true));
      }
    }
    box.createEl("button", { text: PM.pickAnother }).addEventListener("click", () => this.step1());
  }

  private async step2(n: DestinationNote, convert: boolean): Promise<void> {
    const headings = await this.port.headingsOf(n.path);
    if (headings === null) return this.fail(PM.noteGone);
    this.head(`${n.name} · ${PM.step2}`);
    this.contentEl.createEl("button", { cls: "blyg-passage-back", text: PM.back }).addEventListener("click", () => this.step1());
    let chosen: { target: PassageTarget; text: string | null; key: string } | null = headings.length === 0 ? { target: { kind: "end" }, text: null, key: "end" } : null;
    const list = this.contentEl.createDiv({ cls: "blyg-passage-list" });
    const confirm = this.contentEl.createDiv({ cls: "blyg-passage-actions" }).createEl("button", { cls: "mod-cta blyg-passage-confirm", text: PM.pickHeading });
    const refresh = (): void => {
      confirm.disabled = chosen === null;
      confirm.setText(chosen === null ? PM.pickHeading : PM.send(chosen.text));
      for (const el of Array.from(list.children)) el.toggleClass("is-selected", chosen !== null && el.getAttr("data-key") === chosen.key);
    };
    if (headings.length === 0) list.createDiv({ cls: "blyg-passage-sub", text: PM.noHeadings });
    const minLevel = Math.min(...headings.map((h) => h.level), 6);
    for (const h of headings) {
      const key = `${h.level}:${h.nth}:${h.text}`;
      const row = list.createEl("button", { cls: "blyg-passage-row blyg-passage-heading", attr: { "data-key": key } });
      row.style.setProperty("--blyg-indent", String(Math.min(3, h.level - minLevel)));
      row.createDiv({ cls: "blyg-passage-name", text: h.text });
      row.addEventListener("click", () => {
        chosen = { target: { kind: "heading", level: h.level, text: h.text, nth: h.nth }, text: h.text, key };
        refresh();
      });
    }
    const end = list.createEl("button", { cls: "blyg-passage-row blyg-passage-end", attr: { "data-key": "end" } });
    end.createDiv({ cls: "blyg-passage-name", text: PM.endOfNote });
    end.createDiv({ cls: "blyg-passage-where", text: PM.endOfNoteHint });
    end.addEventListener("click", () => {
      chosen = { target: { kind: "end" }, text: null, key: "end" };
      refresh();
    });
    confirm.addEventListener("click", () => {
      if (!chosen) return;
      const pick: PassageChoice = { path: n.path, name: n.name, target: chosen.target, headingText: chosen.text, convert };
      this.done(pick);
      this.close();
    });
    refresh();
  }

  private fail(message: string): void {
    this.head(PM.sheetTitle);
    this.contentEl.createDiv({ cls: "blyg-passage-sub", text: message });
    this.contentEl.createDiv({ cls: "blyg-passage-actions" }).createEl("button", { text: PM.pickAnother }).addEventListener("click", () => this.step1());
  }
}
