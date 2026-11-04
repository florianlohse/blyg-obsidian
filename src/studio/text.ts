// What a note's text becomes on its way to a Studio, and what stops it, decided locally before any request (docs/plans/S2-studio-client.md
// §4.5). Pure: the publish service and the panel both call `prepareStudioText`, so the two cannot disagree.
//
// Names in the vault, ids on the wire (as in the GitHub flow): `![[Note name]]` of a note published in THIS Studio becomes `![[<id>]]`, and
// `[[Note name]]` / `[[Note name|text]]` becomes `[[<id>]]` / `[[<id> | text]]`. Ids and `id | label` forms (what the quote picker writes for items
// of other blygs) pass through untouched. The Studio's own checks (quoted passage not found, item withdrawn, …) come back from its preview; what is
// checked here is what the preview cannot see: a name is not an id (the preview leaves it as literal brackets), a stray embed, a fragment that quotes.
import { checkFragmentBody } from "../core/blyg";
import { BLYG_ID_PATTERN } from "../core/ids";
import { extractWikilinks, maskCode } from "../core/links";
import { routeFor } from "../core/routes";
import { leftoverEmbeds, type Directive } from "../core/thread";
import type { NoteEditPort, NoteRef, VaultPort } from "../platform/ports";
import { M } from "../publish/messages";
import type { Route } from "../settings/schema";
import { readStudioRecord } from "./record";
import type { StudioItemKind } from "./types";

const ID = "[0-9a-hjkmnp-tv-z]{26}";
/** An id, optionally with a label after a bar: already written for the wire. */
const ID_WITH_LABEL = new RegExp(`^(${ID})(?:\\s*\\|.*)?$`);
const ID_VERSION = new RegExp(`^${ID}@v\\d+`);
const EMBED_LINE = /^\s*!\[\[([^[\]\n]+)\]\]\s*$/;
const INLINE_LINK = /\[\[([^[\]|#^\n]+)(?:\|([^[\]\n]*))?\]\]/g;
// A label is everything after the pipe up to the first `]]` (spec 0.4 §10.1): it may hold a single `]`, a pipe, a `[`, but never `]]`.
const LABEL = "(?:(?!\\]\\])[^\\n])*";
const DIRECTIVE_LINE = new RegExp(`^\\s*!\\[\\[(${ID})(?:[ \\t]*\\|[ \\t]*(${LABEL}?))?[ \\t]*\\]\\]\\s*$`);
const ID_LINK = new RegExp(`\\[\\[(${ID})(?:[ \\t]*\\|${LABEL})?\\]\\]`, "g");
const QUOTE_LINE = /^\s*>/;
/** `[[id]]` or `[[id | text]]` with the text captured. */
const ID_LINK_CAPTURE = new RegExp(`\\[\\[(${ID})(?:[ \\t]*\\|[ \\t]*(${LABEL}))?\\]\\]`, "g");

/** One quote of a thread as written: a directive line (`![[id]]` or `![[id | label]]`) and the `>` lines attached to it. */
export interface StudioQuote extends Directive {
  /** The text after the bar, or null (an own item written by name has none). A label means the item is somebody else's, or not in the vault. */
  label: string | null;
}

export type DraftProblem =
  /** Names that cannot become ids (not published in this Studio, withdrawn, an essay …): each message says which. */
  | { kind: "names"; messages: string[] }
  | { kind: "empty" }
  | { kind: "too-long"; length: number; cap: number }
  | { kind: "fragment-quote"; line: number }
  /** An embed left in the text that is not a quote: it would reach readers as literal brackets. */
  | { kind: "embeds"; list: string[] }
  /** `[[Name]]` that is not an item: the Studio shows literal brackets. */
  | { kind: "links"; names: string[] }
  /** A line directly under a partial quote with no `>` and no blank line before it: Studio 0.50+ reads it as part of the quote (E9). */
  | { kind: "lazy-quote"; lines: number[] };

export interface StudioDraft {
  /** The text to send: names turned into ids. When a name could not be turned, the text as written. */
  contentMd: string;
  quotes: StudioQuote[];
  /** Distinct plain item links, `[[id]]`. */
  links: number;
  /** In the order the publish reports them; empty when the text may go on. */
  problems: DraftProblem[];
}

export interface DraftContext {
  vault: VaultPort;
  routes: Route[];
  /** Vault path of the note being prepared: where relative links are resolved from. */
  fromPath: string;
  /** The Studio's origin, as the note records stamp it. */
  origin: string;
  fragmentCharCap: number;
}

type Lookup = { kind: "id"; id: string } | { kind: "problem"; message: string } | { kind: "leave" };

const noteRefOf = (path: string): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension: path.split(".").pop() ?? "" });
/** A label goes between `|` and `]]`: no bars, brackets or line breaks, one line of reasonable length. */
export function cleanLabel(text: string, max = 100): string {
  const flat = text.replace(/[|[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function lookupName(target: string, embed: boolean, ctx: DraftContext): Lookup {
  const resolved = ctx.vault.resolveLink(target, ctx.fromPath);
  if (!resolved || resolved.extension !== "md") return { kind: "leave" };
  const route = routeFor(ctx.routes, resolved.path);
  if (!route) return { kind: "leave" }; // not in a publish folder: the leftover checks have their say
  if (route.mode === "plain") return embed ? { kind: "problem", message: M.embedNotBlyg(target) } : { kind: "leave" };
  if (route.mode === "blyg") return { kind: "problem", message: M.studioNotInStudio(target, null) };
  const record = readStudioRecord(ctx.vault, noteRefOf(resolved.path), ctx.origin);
  switch (record.kind) {
    case "none":
      return { kind: "problem", message: M.embedNotPublished(target) };
    case "invalid":
      return { kind: "problem", message: M.studioQuoteDamaged(target, record.problem) };
    case "other":
      return { kind: "problem", message: M.studioNotInStudio(target, record.origin) };
    case "this":
      return record.withdrawn ? { kind: "problem", message: M.embedWithdrawn(target) } : { kind: "id", id: record.id };
  }
}

/** Names → ids, line by line, outside code. Line numbers never change. */
export function translateStudioNames(contentMd: string, ctx: DraftContext): { text: string; problems: string[]; count: number } {
  const problems: string[] = [];
  let count = 0;
  const maskedLines = maskCode(contentMd).split("\n");
  const lines = contentMd.split("\n").map((line, i) => {
    const where = `line ${i + 1}`;
    const masked = maskedLines[i] ?? "";
    const embed = masked === line ? EMBED_LINE.exec(line) : null;
    if (embed) {
      const inner = (embed[1] ?? "").trim();
      if (ID_WITH_LABEL.test(inner) || ID_VERSION.test(inner)) return line; // written for the wire; the leftover checks and the Studio judge it
      const target = (inner.split(/[|#^]/)[0] ?? "").trim();
      if (target === "") return line;
      const found = lookupName(target, true, ctx);
      if (found.kind === "leave") return line;
      if (found.kind === "problem") {
        problems.push(`${where}: ${found.message}`);
        return line;
      }
      if (/[|#^]/.test(inner)) {
        problems.push(`${where}: ${M.embedForm(inner)}`);
        return line;
      }
      count++;
      return `![[${found.id}]]`;
    }
    // Inline `[[Name]]` or `[[Name|text]]`, found in the code-masked line and replaced at the same place in the real one.
    let out = "";
    let from = 0;
    for (const m of masked.matchAll(INLINE_LINK)) {
      const at = m.index ?? 0;
      if (masked[at - 1] === "!") continue; // an inline embed: the leftover check reports it
      const name = (m[1] ?? "").trim();
      if (name === "" || BLYG_ID_PATTERN.test(name)) continue;
      const found = lookupName(name, false, ctx);
      if (found.kind === "leave") continue;
      if (found.kind === "problem") {
        problems.push(`${where}: ${found.message}`);
        continue;
      }
      const alias = cleanLabel(m[2] ?? "");
      out += line.slice(from, at) + (alias === "" ? `[[${found.id}]]` : `[[${found.id} | ${alias}]]`);
      from = at + m[0].length;
      count++;
    }
    return out + line.slice(from);
  });
  return { text: lines.join("\n"), problems, count };
}

/**
 * The way back, for pulling a Studio's copy into a note: `![[<id>]]` and `[[<id>]]` / `[[<id> | text]]` become `![[Note name]]` and
 * `[[Note name]]` / `[[Note name|text]]` where a note of THIS Studio holds that id, once (the same test `translateStudioNames` applies the other
 * way, so the text goes out again as it came in). An id with no such note, a withdrawn one, an ambiguous one and every `id | label` quote of
 * another blyg stay as they are: ids stay valid. `left` counts the ids kept.
 */
export function namesFromIds(contentMd: string, ctx: DraftContext, edit: NoteEditPort): { text: string; named: number; left: number } {
  const memo = new Map<string, string | null>();
  const nameOf = (id: string): string | null => {
    if (memo.has(id)) return memo.get(id) ?? null;
    let name: string | null = null;
    const notes = edit.notesWithBlygId(id).filter((n) => n.extension === "md");
    const only = notes.length === 1 ? notes[0] : undefined;
    if (only) {
      const text = edit.linkText(only, ctx.fromPath);
      const back = ctx.vault.resolveLink(text, ctx.fromPath);
      const found = back && back.path === only.path ? lookupName(text, false, ctx) : null;
      if (found && found.kind === "id" && found.id === id && !/[|[\]#^]/.test(text)) name = text;
    }
    memo.set(id, name);
    return name;
  };
  let named = 0;
  let left = 0;
  const masked = maskCode(contentMd).split("\n");
  const lines = contentMd.split("\n").map((line, i) => {
    const m = masked[i] === line ? DIRECTIVE_LINE.exec(line) : null;
    if (m) {
      if ((m[2] ?? "").trim() !== "") return line; // `id | label`: another blyg's item
      const name = nameOf(m[1] ?? "");
      if (name === null) {
        left++;
        return line;
      }
      named++;
      return `![[${name}]]`;
    }
    let out = "";
    let from = 0;
    for (const link of (masked[i] ?? "").matchAll(ID_LINK_CAPTURE)) {
      const at = link.index ?? 0;
      if ((masked[i] ?? "")[at - 1] === "!") continue;
      const name = nameOf(link[1] ?? "");
      if (name === null) {
        left++;
        continue;
      }
      const alias = (link[2] ?? "").trim();
      out += line.slice(from, at) + (alias === "" ? `[[${name}]]` : `[[${name}|${alias}]]`);
      from = at + link[0].length;
      named++;
    }
    return out + line.slice(from);
  });
  return { text: lines.join("\n"), named, left };
}

/** The directive lines of a text with their attached quote lines, outside code: `![[id]]` or `![[id | label]]` alone on a line. */
export function scanStudioQuotes(contentMd: string): { quotes: StudioQuote[]; links: number } {
  const lines = contentMd.split("\n");
  const masked = maskCode(contentMd).split("\n");
  const quotes: StudioQuote[] = [];
  const taken = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE_LINE.exec(masked[i] ?? "");
    if (!m) continue;
    let j = i + 1;
    const run: string[] = [];
    while (j < lines.length && QUOTE_LINE.test(lines[j] ?? "")) {
      run.push((lines[j] ?? "").replace(/^\s*>\s?/, ""));
      j++;
    }
    const label = cleanLabel(m[2] ?? "");
    quotes.push({ id: m[1] ?? "", quoteMd: run.length > 0 ? run.join("\n") : null, line: i + 1, label: label === "" ? null : label });
    for (let k = i; k < j; k++) taken.add(k);
    i = j - 1;
  }
  const ids = new Set<string>();
  masked.forEach((line, i) => {
    if (taken.has(i)) return;
    for (const m of line.matchAll(ID_LINK)) {
      if (line[(m.index ?? 0) - 1] !== "!") ids.add(m[1] ?? "");
    }
  });
  return { quotes, links: ids.size };
}

/**
 * Everything the plugin can decide about this text without asking the Studio. `contentMd` is the note's body as a publish would take it
 * (frontmatter off, `%%` comments out, normalised).
 */
export function prepareStudioText(contentMd: string, kind: StudioItemKind, ctx: DraftContext): StudioDraft {
  const problems: DraftProblem[] = [];
  const translated = translateStudioNames(contentMd, ctx);
  if (translated.problems.length > 0) problems.push({ kind: "names", messages: translated.problems });
  // Line breaks are kept as the author sees them; the cap below counts the text as it is sent.
  const text = keepLineBreaks(translated.problems.length > 0 ? contentMd : translated.text);

  if (kind === "fragment") {
    const body = checkFragmentBody(text, ctx.fragmentCharCap);
    if (!body.ok) problems.push(body.reason === "empty" ? { kind: "empty" } : { kind: "too-long", length: body.length, cap: body.cap });
  } else if (text === "") {
    problems.push({ kind: "empty" });
  }

  const { quotes, links } = scanStudioQuotes(text);
  if (kind === "thread") {
    const lazy = lazyQuoteLines(text);
    if (lazy.length > 0) problems.push({ kind: "lazy-quote", lines: lazy });
  }
  const first = quotes[0];
  if (kind === "fragment" && first) problems.push({ kind: "fragment-quote", line: first.line });
  const stray = leftoverEmbeds(text, quotes);
  if (stray.length > 0) problems.push({ kind: "embeds", list: stray });
  const names = extractWikilinks(text)
    .filter((l) => !l.embed)
    .map((l) => `[[${l.target}]]`);
  if (names.length > 0) problems.push({ kind: "links", names });
  return { contentMd: text, quotes, links, problems };
}

const RESERVED_DIRECTIVE_LINE = new RegExp(`^\\s*!\\[\\[${ID}@v\\d+\\]\\]\\s*$`);
/** Lines that CommonMark ends a blockquote on even without a blank line (they interrupt a paragraph). Anything not listed here continues it. */
const ENDS_QUOTE = [
  /^ {0,3}#{1,6}(\s|$)/, // ATX heading
  /^ {0,3}(`{3,}|~{3,})/, // code fence
  /^ {0,3}([-*_])(\s*\1){2,}\s*$/, // thematic break
  /^ {0,3}[-*+]\s+\S/, // bullet item with content (an empty one cannot interrupt a paragraph)
  /^ {0,3}1[.)]\s+\S/, // ordered list starting at 1 (only that can interrupt a paragraph)
  /^ {0,3}<[a-zA-Z/!?]/, // html block start (conservative: some kinds cannot interrupt a paragraph, and then this refuses nothing extra)
];

/**
 * Lines (1-based) that sit directly under a directive's `>` run with no blank line and no `>` of their own. Studio 0.50 and later take
 * CommonMark's blockquote extent for a partial quote, lazy continuation included, so such a line is part of the QUOTED passage; Studio 0.49
 * and the plugin's own reading took it for the author's words. A directive line (or the reserved `![[id@vN]]` form) is never a continuation
 * line (spec §10.1, ninth revision): it ends the selection. The block starts above end a quote too. Where unsure the line is reported: better
 * to refuse than to publish someone's quoted words as one's own (docs/plans/E9-thread-quote-extent.md).
 */
export function lazyQuoteLines(contentMd: string): number[] {
  const lines = contentMd.split("\n");
  const masked = maskCode(contentMd).split("\n");
  const found: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!DIRECTIVE_LINE.test(masked[i] ?? "")) continue;
    let j = i + 1;
    while (j < lines.length && QUOTE_LINE.test(lines[j] ?? "")) j++;
    if (j === i + 1) continue; // a whole quotation: no passage, no extent to worry about
    const next = lines[j];
    if (next !== undefined && next.trim() !== "" && !DIRECTIVE_LINE.test(next) && !RESERVED_DIRECTIVE_LINE.test(next) && !ENDS_QUOTE.some((re) => re.test(next))) found.push(j + 1);
    i = j - 1;
  }
  return found;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
/** Lines that are not running paragraph text: they start or are a block of their own, where a line break needs no help. */
const NOT_PLAIN = [
  /^\s{0,3}#{1,6}(\s|$)/, // heading
  /^\s*([-*+]|\d{1,9}[.)])\s/, // list item
  /^\s*>/, // quote line (a thread's attached passage lines too)
  /^\s*\|/, // table row
  /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, // thematic break
  /^\s*(=+|-+)\s*$/, // setext underline
  /^( {4}|\t)/, // indented code
  /^\s*</, // html block
  /^\s*!\[\[/, // a quote directive
  /^\s*\[\^?[^\]]+\]:\s/, // footnote or link reference definition
];
const isPlain = (line: string): boolean => line.trim() !== "" && !NOT_PLAIN.some((re) => re.test(line));
const endsWithBreak = (line: string): boolean => / {2,}$/.test(line) || line.endsWith("\\");

/**
 * Obsidian shows a single line break inside a paragraph as a break; CommonMark, and so a Studio's renderer (`breaks: false`), turns it into a space
 * ("Line1⏎Line2" reads "Line1 Line2" on the page; found in the S2 device test, 2026-10-23). The site's old renderer kept such breaks (remark-breaks), so this
 * keeps what the author sees: where two plain paragraph lines follow each other, the first gets a Markdown hard break (two trailing spaces). Code,
 * lists, quotes, tables, headings, html and quote directives are left alone. The note in the vault is never changed; the text sent is.
 */
export function keepLineBreaks(text: string): string {
  const lines = text.split("\n");
  let fence: { char: string; length: number } | null = null;
  const inCode: boolean[] = lines.map((line) => {
    const m = FENCE_LINE.exec(line);
    if (fence) {
      if (m && m[1]?.[0] === fence.char && (m[1]?.length ?? 0) >= fence.length && line.trim() === m[1]) fence = null;
      return true;
    }
    if (m) {
      fence = { char: m[1]?.[0] ?? "`", length: m[1]?.length ?? 3 };
      return true;
    }
    return false;
  });
  return lines
    .map((line, i) => {
      const next = lines[i + 1];
      if (next === undefined || inCode[i] || inCode[i + 1]) return line;
      return isPlain(line) && isPlain(next) && !endsWithBreak(line) ? `${line}  ` : line;
    })
    .join("\n");
}

/** The message a publish refuses with for the first problem (the wording the other refusals use). */
export function refusalFor(problem: DraftProblem): string {
  switch (problem.kind) {
    case "names":
      return M.itemProblems(problem.messages);
    case "empty":
      return M.emptyBody;
    case "too-long":
      return M.tooLong(problem.length, problem.cap);
    case "fragment-quote":
      return M.fragmentQuotes(problem.line);
    case "embeds":
      return M.embedsLeft(problem.list);
    case "links":
      return M.studioLinks(problem.names.slice(0, 5));
    case "lazy-quote":
      return M.lazyQuote(problem.lines);
  }
}

/** The same problems as short lines for the panel. */
export function panelLines(problems: DraftProblem[]): string[] {
  return problems.flatMap((p): string[] => {
    switch (p.kind) {
      case "names":
        return p.messages;
      case "empty":
        return ["The note is empty: write something first."];
      case "too-long":
        return [`Too long for a fragment: ${p.length} characters, the limit is ${p.cap}. Shorten it, or make it a thread.`];
      case "fragment-quote":
        return [`Line ${p.line} quotes another item, which only a thread can do (add the property blyg_kind: thread before the first publish).`];
      case "embeds":
        return p.list.map((e) => `${e}: an embed the Studio would show as literal brackets`);
      case "links":
        return [`Links to notes the Studio does not have: ${p.names.slice(0, 3).join(", ")}${p.names.length > 3 ? ", …" : ""}.`];
      case "lazy-quote":
        return p.lines.map((n) => `Line ${n} sits directly under a quote with no “>”: newer Studios read it as part of the quote. Add a blank line before it, or put “>” in front.`);
    }
  });
}
