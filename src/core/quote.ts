// The text of an attached quote (docs/CONTRACT.md §3.3, "The selection of a partial quotation").
//
// `selector.exact` is the attached blockquote's Markdown rendered by CommonMark and then flattened by the one normaliser.
// The site renders it with a real parser (remark); the plugin has none and adding one is a runtime dependency (CLAUDE.md §5).
// So this module renders only the SUBSET where the answer is certain: paragraphs of plain text, with backslash escapes. Anything
// else (emphasis, links, code, lists, headings, nested quotes, raw HTML, entities, tables, hard line breaks) is refused with a
// reason, never guessed. The quote picker writes exactly this subset: `quoteFromSelection` escapes whatever in the selected text
// Markdown would read as syntax, so what the author selected always comes back as the same text.
//
// Verified against the site's own `selectionFromQuote` (remark) on generated quotes, and tests/fixtures/site/threads/selection.json:
// where this module accepts a quote it gives the site's answer; where the site's answer needs Markdown it refuses.
import { selectionText } from "./textContent";

export type QuoteRender = { ok: true; selection: string } | { ok: false; reason: string };

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY_LIKE = /^&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** First characters that start a block (heading, quote, list, rule, fence, HTML, table) when nothing escapes them. */
const BLOCK_START = /^[#>\-+=~|<*_`]/;

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * A word (run of non-space characters) that GitHub-flavoured Markdown may turn into an automatic link: a web address, `www.`, an
 * e-mail address. The link swallows what follows up to the next space, backslashes included, so a backslash inside such a word is
 * not an escape. Found on 2026-10-10 by running generated quotes through the site's own parser. Deliberately a superset.
 */
const AUTOLINK_WORD = /:\/\/|www\.|@[^@]*\.|^(?:mailto|xmpp):/i;

/** For every character of `text`: is it inside a word that may become an automatic link? */
function autolinkMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(/\S+/g)) {
    if (!AUTOLINK_WORD.test(m[0])) continue;
    const start = m.index ?? 0;
    for (let i = start; i < start + m[0].length; i++) mask[i] = true;
  }
  return mask;
}

/** Is a run of `*` or `_` plain text? Only when no emphasis could start or end there (spaces both sides; for `_` also inside a word). */
function literalDelimiterRun(ch: string, before: string | undefined, after: string | undefined): boolean {
  if (isSpace(before) && isSpace(after)) return true;
  return ch === "_" && before !== undefined && after !== undefined && LETTER_OR_DIGIT.test(before) && LETTER_OR_DIGIT.test(after);
}

/** Is `<` plain text? A tag or an autolink needs a letter, `/`, `!` or `?` after it. Be stricter than that. */
const literalLessThan = (after: string | undefined): boolean => isSpace(after) || after === "=";

function paragraphProblem(lines: string[]): string | null {
  for (const [i, line] of lines.entries()) {
    const trimmed = line.replace(/^ {0,3}/, "");
    if (/^[ \t]/.test(trimmed) || /^\t/.test(line)) return "a line is indented by 4 or more spaces, which Markdown reads as code";
    if (BLOCK_START.test(trimmed)) return `a line starts with “${trimmed.slice(0, 1)}”, which Markdown reads as a heading, list, quote or rule`;
    if (/^:-/.test(trimmed)) return "a line looks like the header row of a table";
    if (/^\d{1,9}[.)](?:\s|$)/.test(trimmed)) return "a line starts like a numbered list";
    if (i < lines.length - 1 && / {2,}$/.test(line)) return "a line ends with two spaces, which Markdown reads as a hard line break";
  }
  return null;
}

/** The text of one paragraph with escapes resolved, or why this plugin cannot be sure what Markdown makes of it. */
function paragraphText(paragraph: string): { ok: true; text: string } | { ok: false; reason: string } {
  let out = "";
  const autolink = autolinkMask(paragraph);
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i] ?? "";
    const next = paragraph[i + 1];
    switch (ch) {
      case "\\":
        if (autolink[i]) return { ok: false, reason: "a backslash sits inside a web or e-mail address, which Markdown reads differently" };
        if (next === undefined || next === "\n") return { ok: false, reason: "a backslash at the end of a line is a hard line break in Markdown" };
        if (ASCII_PUNCTUATION.test(next)) {
          out += next;
          i++;
        } else out += ch;
        break;
      case "`":
        return { ok: false, reason: "it contains a backtick (code)" };
      case "[":
      case "]":
        return { ok: false, reason: "it contains square brackets (a link)" };
      case "~":
        return { ok: false, reason: "it contains a tilde (strikethrough or a code fence)" };
      case "|":
        return { ok: false, reason: "it contains a vertical bar (a table)" };
      case "<":
        if (!literalLessThan(next)) return { ok: false, reason: "it contains a “<” that Markdown may read as a tag or a link" };
        out += ch;
        break;
      case "&":
        if (ENTITY_LIKE.test(paragraph.slice(i))) return { ok: false, reason: "it contains something that looks like an HTML entity (like &amp;)" };
        out += ch;
        break;
      case "*":
      case "_": {
        let end = i;
        while (paragraph[end + 1] === ch) end++;
        if (!literalDelimiterRun(ch, paragraph[i - 1], paragraph[end + 1])) {
          return { ok: false, reason: `it contains “${ch}” that Markdown may read as emphasis` };
        }
        out += ch.repeat(end - i + 1);
        i = end;
        break;
      }
      case "\u0000":
        return { ok: false, reason: "it contains a null character" };
      default:
        out += ch;
    }
  }
  return { ok: true, text: out };
}

const textToHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The selection an attached quote denotes (`quoteMd`: the quote's lines with their `>` markers removed). `ok: false` when the
 * quote uses Markdown this module does not cover; the reason says what to change. An empty result is `ok` with "".
 */
export function renderQuoteSelection(quoteMd: string): QuoteRender {
  const paragraphs: string[][] = [[]];
  for (const line of quoteMd.split("\n")) {
    if (line.trim() === "") paragraphs.push([]);
    else paragraphs[paragraphs.length - 1]?.push(line);
  }
  const html: string[] = [];
  for (const lines of paragraphs) {
    if (lines.length === 0) continue;
    const problem = paragraphProblem(lines);
    if (problem) return { ok: false, reason: problem };
    const text = paragraphText(lines.join("\n"));
    if (!text.ok) return text;
    html.push(`<p>${textToHtml(text.text)}</p>`);
  }
  return { ok: true, selection: selectionText(html.join("\n")) };
}

/**
 * One line of selected text as quote Markdown: whatever Markdown would read as syntax gets a backslash. `null` when that cannot be
 * done safely: the text needs an escape inside a word that may become an automatic link (a web address), where escapes do not work.
 */
function escapeQuoteLine(line: string): string | null {
  let out = "";
  let escapedAtStart = false;
  let impossible = false;
  const autolink = autolinkMask(line);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    const next = line[i + 1];
    const escape = (): void => {
      if (autolink[i]) impossible = true;
      if (out === "") escapedAtStart = true;
      out += `\\${ch}`;
    };
    switch (ch) {
      case "\\":
      case "`":
      case "[":
      case "]":
      case "~":
      case "|":
        escape();
        break;
      case "<":
        if (literalLessThan(next)) out += ch;
        else escape();
        break;
      case "&":
        if (ENTITY_LIKE.test(line.slice(i))) escape();
        else out += ch;
        break;
      case "*":
      case "_": {
        let end = i;
        while (line[end + 1] === ch) end++;
        const run = ch.repeat(end - i + 1);
        // At the start of a line even a plain run is escaped: `* x`, `___` and `- x` would be a list or a rule.
        if (out !== "" && literalDelimiterRun(ch, line[i - 1], line[end + 1])) out += run;
        else {
          if (out === "") escapedAtStart = true;
          if (autolink[i]) impossible = true;
          out += run.split("").map((c) => `\\${c}`).join("");
        }
        i = end;
        break;
      }
      case "\u0000":
        break;
      default:
        out += ch;
    }
  }
  if (!escapedAtStart) {
    if (BLOCK_START.test(out) || /^:-/.test(out)) {
      if (autolink[0]) impossible = true;
      out = `\\${out}`;
    } else out = out.replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
  }
  return impossible ? null : out;
}

/**
 * A normalised selection (`normalizeSelection`) as the lines of an attached blockquote: `> ` on every line, a bare `>` between
 * blocks, Markdown syntax escaped so that `renderQuoteSelection` gives the selection back. `null` when the text cannot be quoted
 * exactly (see `escapeQuoteLine`): the caller says so and the author selects something else.
 */
export function quoteFromSelection(selection: string): string | null {
  const lines: string[] = [];
  for (const line of selection.split("\n")) {
    const escaped = escapeQuoteLine(line);
    if (escaped === null) return null;
    lines.push(`> ${escaped}`);
  }
  return lines.join("\n>\n");
}
