// HK5 (prototype): writes a resolved style onto the reading surface element ONLY, through the CSS variable API (no style strings, nothing on document.body or other panes).
// styles.css reads the variables under `.blyg-reader-surface.is-authored`.
import { STYLE_VARS, type ResolvedStyle } from "./resolve";

export interface StyleTarget {
  classList: { add(c: string): void; remove(c: string): void };
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string | void };
}
export const AUTHORED_CLASS = "is-authored";

export function clearStyle(el: StyleTarget): void {
  el.classList.remove(AUTHORED_CLASS);
  for (const v of STYLE_VARS) el.style.removeProperty(v);
}

/** Apply at once; the previous look is cleared first, so a switch never leaves a variable behind. */
export function applyStyle(el: StyleTarget, r: ResolvedStyle): void {
  clearStyle(el);
  if (!r.authored) return;
  for (const v of STYLE_VARS) {
    const value = r.vars[v];
    if (value !== undefined) el.style.setProperty(v, value);
  }
  el.classList.add(AUTHORED_CLASS);
}
