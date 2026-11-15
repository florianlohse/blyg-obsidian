// S15: the reply preview in the editor (Live Preview): the line `![[id | label]]` is replaced, while the cursor is elsewhere, by the text of the item it
// quotes. View-only: a decoration, so the note's text never changes and the vault never holds it. Source mode and the line under the cursor show the line itself.
// The editor's own libraries: Obsidian provides them at run time (esbuild.config.mjs lists them as external) and `obsidian` brings their types, so they are not
// dependencies of this package.
// eslint-disable-next-line import/no-extraneous-dependencies -- provided by Obsidian at run time, typed through the obsidian package
import { Prec, RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
// eslint-disable-next-line import/no-extraneous-dependencies -- provided by Obsidian at run time, typed through the obsidian package
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { findDirectives } from "../core/previewDirectives";
import { drawPreview, type PreviewDeps } from "../ui/replyPreview";

class ReplyPreviewWidget extends WidgetType {
  constructor(private readonly id: string, private readonly label: string, private readonly hint: string | null, private readonly deps: PreviewDeps) {
    super();
  }
  override eq(other: ReplyPreviewWidget): boolean {
    return other.id === this.id && other.label === this.label && other.hint === this.hint;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = createDiv({ cls: "blyg-reply-preview-widget" });
    drawPreview(el, this.deps, this.id, this.label, this.hint, () => {
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true; // the card handles its own taps; the editor leaves them alone
  }
}

/** The origin of the blyg a note answers (its `blyg_stub_of`), when the directive's id is the item it names: where to look an unknown item up. */
export type HintFor = (path: string | null, id: string) => string | null;

export function replyPreviewExtension(deps: PreviewDeps, hintFor: HintFor): Extension {
  const build = (state: EditorState): DecorationSet => {
    if (!state.field(editorLivePreviewField, false)) return Decoration.none;
    const text = state.doc.toString();
    const found = findDirectives(text);
    if (found.length === 0) return Decoration.none;
    const path = state.field(editorInfoField, false)?.file?.path ?? null;
    const { from: selFrom, to: selTo } = state.selection.main;
    const builder = new RangeSetBuilder<Decoration>();
    for (const d of found) {
      if (selFrom <= d.to && selTo >= d.from) continue; // the cursor is on the line: show it as written
      builder.add(d.from, d.to, Decoration.replace({ widget: new ReplyPreviewWidget(d.id, d.label, hintFor(path, d.id), deps), block: true }));
    }
    return builder.finish();
  };
  // Obsidian draws its own widget for an embed that points at no note ("… is not created yet"); on the same line ours must win, so it is highest.
  return Prec.highest(
    StateField.define<DecorationSet>({
      create: build,
      update(value, tr) {
        const modeChanged = tr.state.field(editorLivePreviewField, false) !== tr.startState.field(editorLivePreviewField, false);
        return tr.docChanged || tr.selection || modeChanged ? build(tr.state) : value;
      },
      provide: (f) => EditorView.decorations.from(f),
    }),
  );
}
