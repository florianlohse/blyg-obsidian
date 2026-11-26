// HK3 Marginalia (Live Preview): a small marker at the end of a paragraph of a published note that others quoted; a tap opens the card of who. View-only: a
// widget decoration, so the note's text never changes and the vault never holds it. Reading view and source mode are not drawn on.
// eslint-disable-next-line import/no-extraneous-dependencies -- provided by Obsidian at run time, typed through the obsidian package
import { StateEffect, type Extension, type Range } from "@codemirror/state";
// eslint-disable-next-line import/no-extraneous-dependencies -- provided by Obsidian at run time, typed through the obsidian package
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { leadOf, type ReceptionRow } from "../marginalia/reception";
import { relativeTime } from "../ui/readerFeed";

export interface MarginaliaMarker {
  /** Where the paragraph ends in the note's text. */
  pos: number;
  rows: ReceptionRow[];
}

export interface MarginaliaEditorDeps {
  /** The markers of the note at `path` as it reads now (empty while nothing is known); asks for the lookup the first time. */
  markersFor(path: string | null, text: string): MarginaliaMarker[];
  /** Called when a lookup finishes: redraw. Returns how to stop listening. */
  subscribe(fn: () => void): () => void;
  open(anchor: HTMLElement, rows: ReceptionRow[]): void;
}

const refresh = StateEffect.define<null>();

class MarkerWidget extends WidgetType {
  constructor(private readonly rows: ReceptionRow[], private readonly open: MarginaliaEditorDeps["open"]) {
    super();
  }
  private key(): string {
    return this.rows.map((r) => `${r.mention.id}:${r.excerpt?.length ?? 0}`).join("|");
  }
  override eq(other: MarkerWidget): boolean {
    return other.key() === this.key();
  }
  override toDOM(): HTMLElement {
    const first = this.rows[0];
    const rest = this.rows.length - 1;
    const label = first ? `${leadOf(first.mention)}, ${relativeTime(first.mention.firstSeen || null, Date.now())}${rest > 0 ? ` (and ${rest} more)` : ""}` : "";
    const el = createSpan({ cls: "blyg-marginalia-marker", text: this.rows.length > 1 ? `“${this.rows.length}` : "“", attr: { role: "button", tabindex: "0", "aria-label": label, title: label } });
    const go = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      this.open(el, this.rows);
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(e); });
    return el;
  }
  override ignoreEvent(): boolean {
    return true; // the marker handles its own taps
  }
}

export function marginaliaExtension(deps: MarginaliaEditorDeps): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private readonly stop: () => void;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
        this.stop = deps.subscribe(() => view.dispatch({ effects: refresh.of(null) }));
      }
      update(u: ViewUpdate): void {
        const modeChanged = u.state.field(editorLivePreviewField, false) !== u.startState.field(editorLivePreviewField, false);
        if (u.docChanged || modeChanged || u.transactions.some((t) => t.reconfigured || t.effects.some((e) => e.is(refresh)))) this.decorations = this.build(u.view);
      }
      destroy(): void {
        this.stop();
      }
      private build(view: EditorView): DecorationSet {
        if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
        const path = view.state.field(editorInfoField, false)?.file?.path ?? null;
        const marks = deps.markersFor(path, view.state.doc.toString());
        const ranges: Range<Decoration>[] = marks
          .filter((m) => m.pos >= 0 && m.pos <= view.state.doc.length)
          .map((m) => Decoration.widget({ widget: new MarkerWidget(m.rows, (a, r) => deps.open(a, r)), side: 1 }).range(m.pos));
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
