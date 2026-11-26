// V1-C: the Studio's tangling syntax, read the way the Studio (0.63) reads it. Pure: no Obsidian, no network.
//
//   ![[+ passage]]   a SPAN: opens with `![[+` at the start of a line, then a space, tab or line break; closes with `]]` at the end of a line; it may run
//                    over several lines. `[[id]]` and `![[id]]` links and directives inside are stepped over when looking for the closer.
//   [[+ idea]]       a PLACEHOLDER: inline, one line, not preceded by `!`, non-empty text.
//
// Both are inert in code, in `/* … */` comments and in Obsidian's `%% … %%` comments (the plugin strips those before it sends). One publish makes at
// most `TANGLE_MAX` of them together. Where the Studio refuses a span, this refuses it too, before any request. Not checked here (the Studio's own
// refusal then stands): a `TK` scope inside a span.
import { maskCode } from "../core/links";

/** The Studio's limit: new items one publish may make, spans and placeholders together. */
export const TANGLE_MAX = 10;

export interface TangleSpan {
  kind: "span";
  /** Offsets into the scanned text: from the `!` of `![[+` to just after the closing `]]`. */
  start: number;
  end: number;
  /** 1-based lines of the opener and the closer. */
  line: number;
  endLine: number;
  /** The words between the opener and the closer, trimmed. */
  text: string;
}
export interface TanglePlaceholder {
  kind: "placeholder";
  start: number;
  end: number;
  line: number;
  endLine: number;
  /** The anchor text, trimmed. */
  text: string;
}
export type TanglePart = TangleSpan | TanglePlaceholder;

export type TangleIssueCode =
  | "opener-not-at-line-start"
  | "no-space-after-opener"
  | "no-closer"
  | "closer-not-at-line-end"
  | "empty-span"
  | "span-in-span"
  | "placeholder-in-span"
  | "image-in-span"
  | "empty-placeholder";

export interface TangleIssue {
  code: TangleIssueCode;
  /** 1-based line the problem starts on. */
  line: number;
}

export interface TangleScan {
  /** Spans and placeholders in source order. */
  parts: TanglePart[];
  issues: TangleIssue[];
  /** `parts.length`: the one count the confirmation shows. */
  count: number;
  /** More than one publish may make. */
  overCap: boolean;
}

/** Same length as `text`; `/* … *\/` and `%% … %%` blocks become spaces (line breaks kept), after code was masked. */
function maskComments(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/%%[\s\S]*?%%/g, blank);
}

/** The text with everything inert blanked out: what the scanner reads. */
export function maskInert(text: string): string {
  return maskComments(maskCode(text));
}

const lineOf = (starts: number[], offset: number): number => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

/** Scan a note's text (frontmatter already removed). */
export function scanTangle(text: string): TangleScan {
  const masked = maskInert(text);
  const starts = [0];
  for (let i = 0; i < masked.length; i++) if (masked[i] === "\n") starts.push(i + 1);
  const issues: TangleIssue[] = [];
  const parts: TanglePart[] = [];
  /** Spans' ranges, blanked before placeholders are looked for. */
  let rest = masked;
  const blankRange = (from: number, to: number): void => {
    rest = rest.slice(0, from) + masked.slice(from, to).replace(/[^\n]/g, " ") + rest.slice(to);
  };

  let i = 0;
  while (i < masked.length) {
    const at = masked.indexOf("![[+", i);
    if (at < 0) break;
    const line = lineOf(starts, at);
    if (at !== (starts[line - 1] ?? 0)) {
      issues.push({ code: "opener-not-at-line-start", line });
      i = at + 4;
      continue;
    }
    const after = masked[at + 4];
    if (after !== " " && after !== "\t" && after !== "\n") {
      issues.push({ code: "no-space-after-opener", line });
      i = at + 4;
      continue;
    }
    // Look for the closer, stepping over links and directives.
    let p = at + 4;
    let closer = -1;
    let nested: TangleIssueCode | null = null;
    while (p < masked.length) {
      if (masked.startsWith("![[+", p)) nested ??= "span-in-span";
      else if (masked.startsWith("[[+", p)) nested ??= "placeholder-in-span";
      if (masked.startsWith("![[", p) || masked.startsWith("[[", p)) {
        const open = masked[p] === "!" ? p + 3 : p + 2;
        const end = masked.indexOf("]]", open);
        const nl = masked.indexOf("\n", open);
        if (end >= 0 && (nl < 0 || end < nl)) {
          p = end + 2;
          continue;
        }
        p = open;
        continue;
      }
      if (masked.startsWith("]]", p)) {
        closer = p;
        break;
      }
      p++;
    }
    if (closer < 0) {
      issues.push({ code: "no-closer", line });
      break; // nothing after an unclosed opener can be told apart from its text
    }
    const end = closer + 2;
    const eol = masked.indexOf("\n", end);
    const tail = masked.slice(end, eol < 0 ? masked.length : eol);
    if (tail.trim() !== "") issues.push({ code: "closer-not-at-line-end", line: lineOf(starts, closer) });
    if (nested) issues.push({ code: nested, line });
    const words = text.slice(at + 4, closer).trim();
    if (words === "") issues.push({ code: "empty-span", line });
    if (/\]\(blyg-media:/.test(text.slice(at, end))) issues.push({ code: "image-in-span", line });
    parts.push({ kind: "span", start: at, end, line, endLine: lineOf(starts, closer), text: words });
    blankRange(at, end);
    i = end;
  }

  // Placeholders: `[[+` then blank, text, `]]`, one line, not after `!`. No look-behind (older iOS has none).
  const re = /\[\[\+([ \t][^\n]*?)?\]\]/g;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    const at = m.index;
    if (at > 0 && rest[at - 1] === "!") continue;
    const inner = (m[1] ?? "").trim();
    const line = lineOf(starts, at);
    if (m[1] === undefined) continue; // `[[+]]` and `[[+x]]` are ordinary links to a note of that name, not placeholders
    if (inner === "") {
      issues.push({ code: "empty-placeholder", line });
      continue;
    }
    parts.push({ kind: "placeholder", start: at, end: at + m[0].length, line, endLine: line, text: text.slice(at + 3, at + m[0].length - 2).trim() });
  }
  parts.sort((a, b) => a.start - b.start);
  issues.sort((a, b) => a.line - b.line);
  return { parts, issues, count: parts.length, overCap: parts.length > TANGLE_MAX };
}

/** The label of a span's directive: the first 8 words, `…` when cut, directive lines left out, and cleaned for `![[id | label]]`. Empty: no label. */
export function spanLabel(span: string, words = 8): string {
  const kept = span
    .split("\n")
    .filter((l) => !/^\s*!\[\[[^\]\n]*\]\]\s*$/.test(l))
    .join(" ")
    .replace(/[|[\]]/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "");
  return kept.length > words ? `${kept.slice(0, words).join(" ")}…` : kept.join(" ");
}

export type RewriteResult = { ok: true; text: string } | { ok: false; problem: string };

/**
 * What the Studio does to its working copy after the publish, done to the note's text: a span becomes the directive `![[id | label]]` on its own line
 * followed by a blank line (so a quote written after it is never read as a partial selection); a placeholder becomes `[[id | anchor]]`.
 * `ids` are the Studio's `parts` in source order. Nothing is rewritten unless the text still holds exactly as many parts as ids, with no issue.
 */
export function rewriteTangled(text: string, ids: string[]): RewriteResult {
  const scan = scanTangle(text);
  if (scan.issues.length > 0) return { ok: false, problem: "the text has a tangle problem again, so it was not rewritten" };
  if (scan.parts.length !== ids.length) return { ok: false, problem: `the text holds ${scan.parts.length} spans or placeholders, the Studio made ${ids.length}` };
  let out = "";
  let at = 0;
  scan.parts.forEach((part, n) => {
    const id = ids[n] as string;
    out += text.slice(at, part.start);
    at = part.end;
    if (part.kind === "placeholder") {
      out += `[[${id} | ${spanLabel(part.text, Number.MAX_SAFE_INTEGER) || part.text}]]`;
      return;
    }
    const label = spanLabel(part.text);
    out += label === "" ? `![[${id}]]` : `![[${id} | ${label}]]`;
    // A blank line must follow the directive line.
    const rest = text.slice(part.end);
    const m = /^[ \t]*(\n[ \t]*)?(\n[ \t]*)?/.exec(rest);
    const breaks = (m?.[1] !== undefined ? 1 : 0) + (m?.[2] !== undefined ? 1 : 0);
    if (rest.length > 0 && breaks < 2 && !/^\s*$/.test(rest)) out += "\n".repeat(2 - breaks);
  });
  return { ok: true, text: out + text.slice(at) };
}
