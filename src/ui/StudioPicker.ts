// "Insert quote" / "Insert link" in a Studio folder: one list for the notes of this Studio that are in the vault and for what the Studio's
// search finds (its other items, and the items of the blygs you read). The vault part answers at once; the search is asked a moment after
// typing stops. Drawing only; what gets written is decided by src/app/threadCommands.ts and src/studio/picker.ts. Plain text only: an
// excerpt of somebody else's item is never inserted as HTML.
import { Notice, SuggestModal, type App } from "obsidian";
import { filterVault, mergePicks, type StudioPick } from "../studio/picker";

const DEBOUNCE_MS = 250;
const DEFAULT_EMPTY = "No matches.";
const LOOKING_UP = "Looking up…";

export interface StudioPickerSource {
  /** The notes of this Studio in the vault (already without the open note). */
  own: StudioPick[];
  /** The Studio's search; `error` is a sentence for the user, and the vault part still shows. */
  search(query: string): Promise<{ ok: true; picks: StudioPick[] } | { ok: false; error: string }>;
  /**
   * The text typed is a web address (roadmap S9): the one item it names, or a sentence saying why it can't be used. Null: the text is not an
   * address, so the words are searched for.
   */
  lookup?(query: string): Promise<{ ok: true; pick: StudioPick } | { ok: false; error: string } | null>;
  /** Is the text an address? Then a line says "Looking up…" until the lookup answers; the list stays where it is. */
  isAddress?(query: string): boolean;
}

/** Pick one item; resolves null when the window is closed without a choice. */
export function promptForStudioItem(app: App, source: StudioPickerSource, placeholder: string): Promise<StudioPick | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: StudioPick | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    class StudioItemPicker extends SuggestModal<StudioPick> {
      private latest = 0;
      private warned = false;
      private statusEl: HTMLElement | null = null;

      /** The "Looking up…" line above the list (nothing when `text` is null). The list itself is left alone, so the picks do not jump. */
      private setStatus(text: string | null): void {
        if (text === null) {
          this.statusEl?.remove();
          this.statusEl = null;
          return;
        }
        if (!this.statusEl) {
          this.statusEl = createDiv({ cls: "blyg-pick-status" });
          this.resultContainerEl.before(this.statusEl);
        }
        this.statusEl.setText(text);
      }

      override async getSuggestions(query: string): Promise<StudioPick[]> {
        const ticket = ++this.latest;
        this.setStatus(null);
        const own = filterVault(source.own, query);
        await new Promise<void>((done) => window.setTimeout(done, DEBOUNCE_MS));
        // Typing went on: a newer call will answer; this one only keeps the list from flickering.
        if (ticket !== this.latest) return own;
        if (source.lookup && source.isAddress?.(query)) this.setStatus(LOOKING_UP);
        let byAddress: Awaited<ReturnType<NonNullable<StudioPickerSource["lookup"]>>> = null;
        try {
          byAddress = source.lookup ? await source.lookup(query) : null;
        } finally {
          // A newer call owns the line from here on: it clears or sets it itself.
          if (ticket === this.latest) this.setStatus(null);
        }
        if (ticket !== this.latest) return own;
        if (byAddress) {
          // A pasted address: it names one item, found by the Studio. A failure is said in the empty list, where the eye is.
          this.emptyStateText = byAddress.ok ? DEFAULT_EMPTY : byAddress.error;
          return byAddress.ok ? [byAddress.pick] : [];
        }
        this.emptyStateText = DEFAULT_EMPTY;
        const found = await source.search(query);
        if (ticket !== this.latest) return own;
        if (!found.ok) {
          if (!this.warned) new Notice(found.error, 8000);
          this.warned = true;
          return own;
        }
        return mergePicks(own, found.picks);
      }

      override renderSuggestion(pick: StudioPick, el: HTMLElement): void {
        if (pick.quotable === false) el.addClass("blyg-pick-unquotable");
        el.createDiv({ text: pick.title.length > 120 ? `${pick.title.slice(0, 119)}…` : pick.title });
        el.createEl("small", { text: pick.detail });
      }

      override onChooseSuggestion(pick: StudioPick): void {
        settle(pick);
      }

      override onClose(): void {
        super.onClose();
        // The choice may arrive just after the window closes: give it a moment before calling this "no choice".
        window.setTimeout(() => settle(null), 100);
      }
    }
    const picker = new StudioItemPicker(app);
    picker.setPlaceholder(placeholder);
    picker.setInstructions([{ command: "type or paste", purpose: "words to search for, or the address of an item" }]);
    picker.open();
  });
}
