// HK3 Marginalia: the "Reception" section at the end of a published note in Reading view. A post processor runs once per rendered block of the note, so the section is
// put under the LAST block only (the section info says where a block ends), and a render child redraws it when a lookup finishes. View-only: the note is not changed.
import { MarkdownRenderChild, type Plugin } from "obsidian";
import { drawReceptionSection } from "../ui/receptionBottom";
import type { ReceptionPanel } from "./wire";

export interface ReadingSectionDeps {
  /** The section for the note at `path` with its text; null when the note is not a published item of this Studio. Asks for the lookup the first time. */
  receptionFor(path: string | null, text: string): ReceptionPanel | null;
  enabled(): boolean;
  subscribe(fn: () => void): () => void;
}

/** Is the block that ends at `lineEnd` the last one with any text in `text`? */
export function endsNote(text: string, lineEnd: number): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let last = lines.length - 1;
  while (last > 0 && (lines[last] ?? "").trim() === "") last--;
  return lineEnd >= last;
}

export function registerReadingSection(plugin: Plugin, deps: ReadingSectionDeps): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    if (!deps.enabled()) return;
    const info = ctx.getSectionInfo(el);
    if (!info || !endsNote(info.text, info.lineEnd)) return;
    const host = el.createDiv({ cls: "blyg-reception-widget blyg-reception-reading" });
    const draw = (): void => {
      host.empty();
      const rec = deps.enabled() ? deps.receptionFor(ctx.sourcePath, info.text) : null;
      if (rec) drawReceptionSection(host, rec, Date.now());
    };
    const child = new MarkdownRenderChild(host);
    child.onload = (): void => {
      draw();
      child.register(deps.subscribe(draw));
    };
    ctx.addChild(child);
  });
}
