// Obsidian comments: `%%…%%` (inline or spanning lines). They are private notes-to-self and must never be published
// (docs/SECURITY.md §4). Code is literal: nothing inside a fenced block or an inline code span counts.

/** A block id taken off a paragraph, with the start of that paragraph's line so a record of it can say where it was. */
export interface RemovedBlockId {
  id: string;
  excerpt: string;
}

export type StripResult = { ok: true; text: string; removed: number; blockIds: RemovedBlockId[] } | { ok: false; reason: "unclosed"; line: number };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Obsidian's block id: `^id` at the very end of a line, after a space (or alone on its line, after a table or quote).
const BLOCK_ID_END = /(^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;
const EXCERPT_CHARS = 40;

const excerptOf = (line: string): string => {
  const t = line.replace(/\s+/g, " ").trim();
  return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS - 1)}…` : t;
};

/**
 * Take the block id (`^ab12cd`) off the end of every line outside code. It is an anchor for links inside the vault, never content: online it
 * would be literal text. A line that is only an id disappears. Obsidian reads `a ^2` at the end of a line as an id too, so this does the same.
 */
export function stripBlockIds(text: string): { text: string; ids: RemovedBlockId[] } {
  const ids: RemovedBlockId[] = [];
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const raw of lines) {
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1]?.[0] === fence.char && (m[1]?.length ?? 0) >= fence.length && line.trim() === m[1]) fence = null;
      out.push(raw);
      continue;
    }
    if (m) {
      fence = { char: m[1]?.[0] ?? "`", length: m[1]?.length ?? 3 };
      out.push(raw);
      continue;
    }
    const id = BLOCK_ID_END.exec(line);
    if (!id) {
      out.push(raw);
      continue;
    }
    const rest = line.slice(0, id.index).replace(/[ \t]+$/, "");
    if (rest === "") {
      // The id stands alone: it belonged to the block above.
      const above = [...out].reverse().find((l) => l.trim() !== "") ?? "";
      ids.push({ id: id[2] as string, excerpt: excerptOf(above) });
      continue;
    }
    ids.push({ id: id[2] as string, excerpt: excerptOf(rest) });
    out.push(rest + cr);
  }
  return { text: out.join("\n"), ids };
}

/**
 * Remove every `%%…%%` comment. A comment that fills a whole line takes the line with it; one in the middle of a
 * line leaves the rest of the line as it was. An opening `%%` that never closes is **not guessed at**: the caller must
 * refuse to publish (the rest of the note might be private).
 */
export function stripObsidianComments(text: string): StripResult {
  let out = "";
  let removed = 0;
  let i = 0;
  let fence: { char: string; length: number } | null = null;

  const lineNumber = (index: number): number => text.slice(0, index).split("\n").length;

  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === "\n";

    if (atLineStart) {
      const lineEnd = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
      const line = text.slice(i, lineEnd);
      const m = FENCE.exec(line);
      if (fence) {
        // A closing fence: same character, at least as long, nothing else on the line.
        if (m && m[1]?.[0] === fence.char && (m[1]?.length ?? 0) >= fence.length && line.trim() === m[1]) fence = null;
        out += line + (lineEnd < text.length ? "\n" : "");
        i = lineEnd + 1;
        continue;
      }
      if (m) {
        fence = { char: m[1]?.[0] ?? "`", length: m[1]?.length ?? 3 };
        out += line + (lineEnd < text.length ? "\n" : "");
        i = lineEnd + 1;
        continue;
      }
    }

    const ch = text[i];

    if (ch === "`") {
      // Inline code: a run of N backticks closes at the next run of exactly N on the same line; otherwise literal.
      let n = 0;
      while (text[i + n] === "`") n++;
      const lineEnd = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
      let j = i + n;
      let close = -1;
      while (j < lineEnd) {
        if (text[j] === "`") {
          let m = 0;
          while (text[j + m] === "`") m++;
          if (m === n) {
            close = j;
            break;
          }
          j += m;
        } else j++;
      }
      if (close !== -1) {
        out += text.slice(i, close + n);
        i = close + n;
      } else {
        out += text.slice(i, i + n);
        i += n;
      }
      continue;
    }

    if (ch === "%" && text[i + 1] === "%") {
      const end = text.indexOf("%%", i + 2);
      if (end === -1) return { ok: false, reason: "unclosed", line: lineNumber(i) };
      removed++;
      let next = end + 2;
      // A comment alone on its line: drop the whole line (leading blanks, the comment, the line break).
      const lineStartInOut = out.lastIndexOf("\n") + 1;
      const restOfLineEnd = text.indexOf("\n", next) === -1 ? text.length : text.indexOf("\n", next);
      if (/^[ \t]*$/.test(out.slice(lineStartInOut)) && /^[ \t]*$/.test(text.slice(next, restOfLineEnd))) {
        out = out.slice(0, lineStartInOut);
        next = restOfLineEnd < text.length ? restOfLineEnd + 1 : restOfLineEnd;
      }
      i = next;
      continue;
    }

    out += ch;
    i++;
  }

  const noIds = stripBlockIds(out);
  return { ok: true, text: noIds.text, removed, blockIds: noIds.ids };
}
