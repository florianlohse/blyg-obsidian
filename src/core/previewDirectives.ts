// S15: which lines of a note are quote directives for the reply preview (pure; see ui/replyPreview.ts for the drawing).
/** The id alphabet (Crockford base32 minus i, l, o, u): exactly what an item id is made of (core/thread.ts). */
const ID = "[0-9a-hjkmnp-tv-z]{26}";
const LINE = new RegExp(`^ {0,3}!\\[\\[(${ID})(?:[ \\t]*\\|([^\\]\\n]*))?\\]\\][ \\t]*$`);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface FoundDirective {
  /** The start and end of the line the directive is on (a block replacement covers whole lines). */
  from: number;
  to: number;
  id: string;
  label: string;
}

/** The directives of a note's text: a line that is only `![[id]]` or `![[id | label]]`, outside fenced code. */
export function findDirectives(text: string): FoundDirective[] {
  const out: FoundDirective[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (f) {
      const mark = (f[1] ?? "")[0] ?? "";
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
    } else if (fence === null) {
      const m = LINE.exec(line);
      if (m) out.push({ from: at, to: at + line.length, id: m[1] ?? "", label: (m[2] ?? "").trim() });
    }
    at += line.length + 1;
  }
  return out;
}
