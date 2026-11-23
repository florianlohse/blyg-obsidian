// Cut generated text without breaking a word: at the last sentence end that fits, else at the last word boundary with an ellipsis. Pure; counts graphemes
// (not UTF-16 units) so multi-byte text is never split inside a character.
import { graphemePrefix } from "../core/textContent";

const SENTENCE_END = /[.!?…](?=\s|$)/g;

/** `text` itself when it fits in `max`; else its longest whole-sentence prefix (at least a third of `max`), else whole words plus "…". */
export function cutAtBoundary(text: string, max: number): string {
  const t = text.trim();
  const window = graphemePrefix(t, max);
  if (window.length === t.length) return t;
  let end = -1;
  for (const m of window.matchAll(SENTENCE_END)) end = m.index + 1;
  if (end >= window.length / 3 && end > 0) return window.slice(0, end).trim();
  // the window ends on a word boundary when the next character is a space; otherwise the last word is cut and is dropped
  const next = t.charAt(window.length);
  const words = /\s/.test(next) ? window : window.slice(0, Math.max(0, window.search(/\s\S*$/)));
  const body = (words === "" ? window : words).replace(/[\s,;:.\-–—]+$/, "");
  return `${body}…`;
}
