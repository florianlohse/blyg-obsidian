// S15: the reply preview. A reply note starts with `![[id | label]]`, the directive that quotes the item it answers; in the editor and in Reading view
// that is a bare id. This draws what it points at, VIEW-ONLY: nothing is written into the note or the vault, and the text of someone else's item is
// drawn through the reader's own filter (ui/defang.ts), with its images behind a tap.
import { sanitizeHTMLToDom } from "obsidian";
import type { PreviewResult } from "../studio/previewResolver";
import { renderForeign, type ImageMode } from "./defang";

export interface PreviewDeps {
  /** Look the item up (the host caches it). */
  resolve(id: string, hintOrigin: string | null): Promise<PreviewResult>;
  imageMode(): ImageMode;
  studioOrigin(): string | null;
}

/** Draw the preview of one item into `host` (empty it first): "Loading…", then the text, or why there is none. `onEdit`: show the line's source. */
export function drawPreview(host: HTMLElement, deps: PreviewDeps, id: string, label: string, hintOrigin: string | null, onEdit?: () => void): void {
  host.empty();
  host.addClass("blyg-reply-preview");
  const head = host.createDiv({ cls: "blyg-reply-preview-head" });
  const who = head.createSpan({ cls: "blyg-reply-preview-who", text: label !== "" ? label : "A quoted item" });
  const body = host.createDiv({ cls: "blyg-reply-preview-body is-clamped", text: "Loading…" });
  if (onEdit) {
    const edit = head.createEl("button", { cls: "blyg-reply-preview-edit", text: "Edit line", attr: { type: "button", title: "Show the line's source to edit it" } });
    edit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onEdit();
    });
  }
  void deps.resolve(id, hintOrigin).then((got) => {
    if (!host.isConnected) return;
    body.empty();
    if (got.kind === "missing") {
      body.setText("This item could not be found.");
      body.removeClass("is-clamped");
      return;
    }
    if (got.kind === "unavailable") {
      body.setText(got.message);
      body.removeClass("is-clamped");
      return;
    }
    const { item } = got;
    who.setText([item.who, label !== "" && item.who !== label ? label : ""].filter((x) => x !== "").join(" · ") || "A quoted item");
    if (item.withdrawn) {
      body.setText("This item was withdrawn.");
      body.removeClass("is-clamped");
      return;
    }
    const drawn = renderForeign(item.html, { trustedOrigin: deps.studioOrigin(), mode: deps.imageMode(), baseUrl: null }, sanitizeHTMLToDom);
    body.appendChild(drawn.fragment);
    if (drawn.blocked > 0) {
      const all = body.createEl("button", { cls: "blyg-reply-preview-more", text: `Load images (${drawn.blocked})`, attr: { type: "button" } });
      all.addEventListener("click", (e) => {
        e.stopPropagation();
        drawn.loadAll();
      });
    }
    // Long items are clamped; a button shows the rest.
    window.requestAnimationFrame(() => {
      if (body.scrollHeight <= body.clientHeight + 2) {
        body.removeClass("is-clamped");
        return;
      }
      const more = host.createEl("button", { cls: "blyg-reply-preview-more", text: "Show more", attr: { type: "button" } });
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        const clamped = body.hasClass("is-clamped");
        body.toggleClass("is-clamped", !clamped);
        more.setText(clamped ? "Show less" : "Show more");
      });
    });
  });
}
