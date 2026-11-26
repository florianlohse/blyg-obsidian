// The headings of a note, for "Send passage to note": the writer picks the heading the quote goes under. Pure text scanning, no Obsidian.
// ATX headings only (`# Title`), outside the properties block and outside fenced code. A heading is named by (level, text, nth), where `nth` counts the
// headings with the same level and text above it, so the same heading can be found again in the note's text at the moment of writing.

export interface NoteHeading {
  level: number;
  text: string;
  /** 0-based line of the heading. */
  line: number;
  nth: number;
}

export interface NoteScan {
  lines: string[];
  headings: NoteHeading[];
  /** For each line: it is inside a fenced code block (the fences themselves included) or in the properties block. */
  protectedLine: boolean[];
  /** 0-based line where a fenced code block starts that is never closed, or -1. */
  openFenceAt: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

export function scanNote(text: string): NoteScan {
  const lines = text.split("\n");
  const protectedLine: boolean[] = new Array<boolean>(lines.length).fill(false);
  let start = 0;
  if ((lines[0] ?? "").trimEnd() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
    if (close > 0) {
      for (let i = 0; i <= close; i++) protectedLine[i] = true;
      start = close + 1;
    }
  }
  const headings: NoteHeading[] = [];
  const seen = new Map<string, number>();
  let fence: { char: string; length: number; at: number } | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    const f = FENCE.exec(line);
    if (fence) {
      protectedLine[i] = true;
      if (f && f[1]!.startsWith(fence.char) && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = { char: f[1]!.charAt(0), length: f[1]!.length, at: i };
      protectedLine[i] = true;
      continue;
    }
    const m = ATX.exec(line);
    if (!m) continue;
    const level = m[1]!.length;
    const text = (m[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim();
    if (text === "") continue;
    const key = `${level}\n${text}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    headings.push({ level, text, line: i, nth });
  }
  return { lines, headings, protectedLine, openFenceAt: fence ? fence.at : -1 };
}

/** The headings of a note, in order. */
export function noteHeadings(text: string): NoteHeading[] {
  return scanNote(text).headings;
}
