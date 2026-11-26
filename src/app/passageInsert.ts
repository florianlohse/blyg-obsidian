// Where a captured passage goes in a note and what the note's text becomes: at the end of the section of the heading the writer picked (the section
// runs to the next heading of the same or a higher level, so sub-sections are inside it), or at the end of the note. The directive line and the attached
// blockquote stay together (spec 0.4 §10.1: a blank line detaches the quote), and a blank line follows them so the writer's reaction on the next line is
// never read as part of the quotation (lazy continuation). Pure: `process` in the plugin runs this on the note's text as it is at the moment of writing.
import { scanNote } from "./noteHeadings";

export type PassageTarget = { kind: "end" } | { kind: "heading"; level: number; text: string; nth: number };

export type PassageInsert =
  | { ok: true; text: string; /** 0-based line of the directive. */ quoteLine: number; /** 0-based empty line where the reaction starts. */ cursorLine: number }
  | { ok: false; reason: "heading-gone" | "open-fence" };

/** `block`: the directive line, then the attached quote lines (no blank line between), as `quoteBlockOf` writes them. */
export function insertPassage(text: string, target: PassageTarget, block: string): PassageInsert {
  const scan = scanNote(text);
  const { lines } = scan;
  let from = 0;
  let until = lines.length;
  if (target.kind === "heading") {
    const h = scan.headings.find((x) => x.level === target.level && x.text === target.text && x.nth === target.nth);
    if (!h) return { ok: false, reason: "heading-gone" };
    from = h.line;
    until = scan.headings.find((x) => x.line > h.line && x.level <= h.level)?.line ?? lines.length;
  }
  // The new lines go after the last line with something on it in [from, until); the heading line itself counts.
  let last = -1;
  for (let i = until - 1; i >= from; i--) {
    if ((lines[i] ?? "").trim() !== "") {
      last = i;
      break;
    }
  }
  // A code block that is never closed would swallow the new lines.
  if (scan.openFenceAt >= from && scan.openFenceAt < until) return { ok: false, reason: "open-fence" };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const head = last < 0 ? "" : lines.slice(0, last + 1).join("\n").replace(/\r$/, "");
  const restLines = lines.slice(last + 1);
  while (restLines.length > 0 && (restLines[0] ?? "").trim() === "") restLines.shift();
  const rest = restLines.join("\n");
  const lead = head === "" ? "" : `${eol}${eol}`;
  const quoted = block.split("\n").join(eol);
  const before = `${head}${lead}${quoted}${eol}${eol}`;
  const out = rest === "" ? before : `${before}${eol}${eol}${rest}`;
  const quoteLine = head === "" ? 0 : head.split("\n").length + 1;
  return { ok: true, text: out, quoteLine, cursorLine: quoteLine + block.split("\n").length + 1 };
}

/** The text a new thread starts with when a passage is sent to "a new thread": the quote pair, a blank line, and the empty line for the reaction (the cursor goes to the end). */
export const newThreadBody = (block: string): string => `${block}\n\n`;
