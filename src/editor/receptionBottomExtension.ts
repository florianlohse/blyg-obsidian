// HK3 Marginalia: the "Reception" section at the end of a published note, in the editor (Live Preview and Source mode). View-only: one block widget after the last line, so the
// note's text never changes and the vault never holds it. A block decoration has to come from a state field (a view plugin may not draw one); a small view plugin only listens
// for the lookup to finish and asks for a redraw.
// eslint-disable-next-line import/no-extraneous-dependencies -- provided by Obsidian at run time, typed through the obsidian package
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
// eslint-disable-next-line import/no-extraneous-dependencies -- provided by Obsidian at run time, typed through the obsidian package
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { ReceptionPanel } from "../marginalia/wire";
import { drawReceptionSection, receptionSignature } from "../ui/receptionBottom";

export interface ReceptionBottomDeps {
  /** The section for the note at `path` as it reads now; null when the note is not a published item of this Studio (nothing is drawn). Asks for the lookup the first time. */
  receptionFor(path: string | null, text: string): ReceptionPanel | null;
  /** The settings switch, read each time the section is built. */
  enabled(): boolean;
  /** Called when a lookup finishes: redraw. Returns how to stop listening. */
  subscribe(fn: () => void): () => void;
}

const refresh = StateEffect.define<null>();

class ReceptionWidget extends WidgetType {
  constructor(private readonly rec: ReceptionPanel) {
    super();
  }
  override eq(other: ReceptionWidget): boolean {
    return receptionSignature(other.rec) === receptionSignature(this.rec);
  }
  override toDOM(): HTMLElement {
    const wrap = createDiv({ cls: "blyg-reception-widget" });
    drawReceptionSection(wrap, this.rec, Date.now());
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true; // the section's own buttons handle their taps
  }
}

export function receptionBottomExtension(deps: ReceptionBottomDeps): Extension {
  const build = (state: EditorState): DecorationSet => {
    if (!deps.enabled()) return Decoration.none;
    const path = state.field(editorInfoField, false)?.file?.path ?? null;
    const rec = deps.receptionFor(path, state.doc.toString());
    if (rec === null) return Decoration.none;
    return Decoration.set([Decoration.widget({ widget: new ReceptionWidget(rec), block: true, side: 1 }).range(state.doc.length)]);
  };
  const field = StateField.define<DecorationSet>({
    create: build,
    update: (value, tr) => (tr.docChanged || tr.reconfigured || tr.effects.some((e) => e.is(refresh)) ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  const listen = ViewPlugin.fromClass(
    class {
      private readonly stop: () => void;
      constructor(view: EditorView) {
        this.stop = deps.subscribe(() => view.dispatch({ effects: refresh.of(null) }));
      }
      destroy(): void {
        this.stop();
      }
    },
  );
  return [field, listen];
}
