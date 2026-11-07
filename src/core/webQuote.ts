// "Insert web quote" (docs/plans/S20-web-quote.md): a quote from any web page with a link to its source, written as plain Markdown from a format.
// NOT a blyg operation: it knows no routes, ids, versions or Studio, makes no request, and writes ordinary Markdown that the protocol never reads
// (spec 0.4 §10.2, the plain-web register: "a quotation with a link, editable, unverified"). Pure; the form and the command live elsewhere.
//
// Unlike `quote.ts` (which must reproduce a blyg quote's text exactly and so escapes everything), nothing in the quote is escaped here: what the
// author pasted is what the note holds, emphasis and links included. Only the label of the attribution link is escaped, because it is built by us.

/** The longest visible text of a shortened link, in characters (the ellipsis included). A constant on purpose (plan §5, D3). */
export const SHORT_LINK_MAX = 40;

/**
 * The format drives the whole block: `{quote}` is the quote, `{link}` the whole link, `{alias}` its visible text, `{url}` the address. The default makes a
 * block quote whose last line is the italic source, with no blank line between (Florian, 2026-11-07).
 */
export const DEFAULT_FORMAT = "> {quote}\n> *{link}*";

export interface WebQuoteOptions {
  /** One or more lines; placeholders {quote} (exactly once), {link}, {alias}, {url}. */
  format: string;
  stripTracking: boolean;
}

export const DEFAULT_WEB_QUOTE: WebQuoteOptions = { format: DEFAULT_FORMAT, stripTracking: true };

export interface Pos {
  line: number;
  ch: number;
}

// ---- the address ------------------------------------------------------------------------------------------------------------------------

const GENERIC_TRACKING = /^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid)$/i;
const SUBSTACK_TRACKING = /^(?:r|triedRedirect|showWelcomeOnShare)$/;

const isSubstackHost = (host: string): boolean => host === "substack.com" || host.endsWith(".substack.com");

export type CleanUrl = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The address to write: `http(s)` only, no user name or password, tracking parameters removed when asked, and the characters that would break a
 * Markdown link destination percent-encoded. The fragment stays (it may name a section). The query is kept in its original spelling apart from the
 * removed parameters.
 */
export function cleanUrl(input: string, stripTracking: boolean): CleanUrl {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "Paste the address of the page." };
  if (/\s/.test(text)) return { ok: false, reason: "The address contains a space or a line break." };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: "That is not a web address. It should start with https://" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "Only http:// and https:// addresses are accepted." };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "The address contains a user name or password." };

  let search = u.search;
  if (stripTracking && search.length > 1) {
    const substack = isSubstackHost(u.hostname);
    const kept = search
      .slice(1)
      .split("&")
      .filter((part) => {
        if (part === "") return false;
        const rawName = part.split("=")[0] ?? "";
        let name = rawName;
        try {
          name = decodeURIComponent(rawName);
        } catch {
          /* keep the raw spelling */
        }
        return !(GENERIC_TRACKING.test(name) || (substack && SUBSTACK_TRACKING.test(name)));
      });
    search = kept.length > 0 ? `?${kept.join("&")}` : "";
  }
  const href = `${u.protocol}//${u.host}${u.pathname}${search}${u.hash}`;
  return { ok: true, url: href.replace(/[()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) };
}

/**
 * The visible text of a link without an alias: no scheme, no `www.`, no query, no fragment, no trailing slash; over `max` characters it keeps the
 * host and cuts the rest with `…` (the host is what a reader recognises). The href is never shortened. Counts characters, not UTF-16 units.
 */
export function shortLink(url: string, max: number = SHORT_LINK_MAX): string {
  let host = url;
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./i, "");
    path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep it encoded */
    }
  } catch {
    /* not parseable: show it as given, cut */
  }
  path = path.replace(/\/+$/, "").replace(/[\p{Cc}\s]+/gu, " ");
  const chars = Array.from(host + path);
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/** Make text safe as the label of a Markdown link (and inside `*…*`): line breaks become spaces, markup characters get a backslash. */
export function escapeLabel(text: string): string {
  const flat = text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
  let out = "";
  const chars = Array.from(flat);
  chars.forEach((ch, i) => {
    if (ch === "\\" || ch === "[" || ch === "]" || ch === "*" || ch === "`" || ch === "<") {
      out += `\\${ch}`;
    } else if (ch === "_") {
      // An underscore between two letters or digits is plain text; elsewhere it could start emphasis.
      const before = chars[i - 1];
      const after = chars[i + 1];
      const inWord = before !== undefined && after !== undefined && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
      out += inWord ? ch : `\\${ch}`;
    } else out += ch;
  });
  return out;
}

// ---- the format -----------------------------------------------------------------------------------------------------------------------

/** Null when the format is usable, else what to change. */
export function formatProblem(format: string): string | null {
  if (format.trim() === "") return "The format is empty. Use {quote} and {link}, for example “> {quote}” on one line and “> *{link}*” on the next.";
  const unknown = /\{(?!quote\}|link\}|alias\}|url\})([^{}\s]*)\}/.exec(format);
  if (unknown) return `Unknown placeholder {${unknown[1] ?? ""}}. Use {quote}, {link}, {alias} or {url}.`;
  const count = format.split("{quote}").length - 1;
  if (count === 0) return "The format needs {quote}, the place where the quote goes.";
  if (count > 1) return "{quote} can stand only once in the format.";
  if (!format.includes("{link}") && !format.includes("{url}")) return "The format needs {link} (or {url}) so the quote carries its source.";
  return null;
}

/**
 * The quote as lines of text (no `>` prefix; a blank line is ""). Line endings become `\n`, trailing spaces go, blank lines at the ends go, a run of blank
 * lines becomes one. If every non-blank line already starts with `>` (a quote copied from Markdown) one level is removed first, so it does not nest under
 * the format's own `>`. Empty when nothing is left.
 */
export function quoteText(raw: string): string[] {
  let lines = raw.replace(/\r\n?|\u2028|\u2029/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  const nonBlank = lines.filter((l) => l !== "");
  if (nonBlank.length > 0 && nonBlank.every((l) => /^ {0,3}>/.test(l))) lines = lines.map((l) => l.replace(/^ {0,3}> ?/, "").replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && out[out.length - 1] === "") continue;
    out.push(l);
  }
  return out;
}

/**
 * The block from the format, in one pass (a value that itself contains `{url}` is not substituted again). On the format line that holds `{quote}`, the
 * quote's later lines get that line's leading `>` marks and spaces, so `> {quote}` makes every line of the quote a quote line (a blank line of the quote
 * becomes a bare `>`). Blank lines at the ends of the result are dropped; any blank line inside is one the format has.
 */
export function renderFormat(format: string, parts: { quote: string[]; text: string; url: string }): string {
  const label = escapeLabel(parts.text);
  const lines = format
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const lead = /^[ \t]*(?:>[ \t]*)*/.exec(line)?.[0] ?? "";
      return line.replace(/\{(quote|link|alias|url)\}/g, (_m, name: string) => {
        if (name === "link") return `[${label}](${parts.url})`;
        if (name === "alias") return label;
        if (name === "url") return parts.url;
        return parts.quote.map((l, i) => (i === 0 ? l : l === "" ? lead.trimEnd() : `${lead}${l}`)).join("\n");
      });
    });
  return lines.join("\n").replace(/^\n+|\n+$/g, "");
}

export interface WebQuoteInput {
  quote: string;
  link: string;
  alias: string;
}

export type WebQuote =
  | { ok: true; text: string; /** The chosen format was unusable and the default was used. */ formatFellBack: boolean }
  | { ok: false; reason: string };

/** The block to insert (no blank lines around it; see `planInsert`). */
export function buildWebQuote(input: WebQuoteInput, options: WebQuoteOptions): WebQuote {
  const quote = quoteText(input.quote);
  if (quote.length === 0) return { ok: false, reason: "The quote is empty." };
  const cleaned = cleanUrl(input.link, options.stripTracking);
  if (!cleaned.ok) return { ok: false, reason: cleaned.reason };
  const text = input.alias.trim() !== "" ? input.alias : shortLink(cleaned.url);
  const formatFellBack = formatProblem(options.format) !== null;
  return { ok: true, text: renderFormat(formatFellBack ? DEFAULT_FORMAT : options.format, { quote, text, url: cleaned.url }), formatFellBack };
}

// ---- where it goes ----------------------------------------------------------------------------------------------------------------------

/**
 * The edit that puts `block` into a note as a paragraph of its own: one blank line before and after, added only where the neighbouring line is not
 * already blank. A thread's `![[Item]]` directive takes the `>` lines directly under it as a partial quote (thread.ts `attachedQuote`, no blank line
 * between), so the blank line before is what keeps a web quote from being read as one. White space around the cursor on its line is replaced.
 */
export function planInsert(lines: string[], from: Pos, to: Pos, block: string): { from: Pos; to: Pos; text: string } {
  const startLine = lines[from.line] ?? "";
  const endLine = lines[to.line] ?? "";
  const textBefore = startLine.slice(0, from.ch);
  const textAfter = endLine.slice(to.ch);
  const start: Pos = textBefore.trim() === "" ? { line: from.line, ch: 0 } : from;
  const end: Pos = textAfter.trim() === "" ? { line: to.line, ch: endLine.length } : to;
  const prefix = textBefore.trim() !== "" ? "\n\n" : from.line > 0 && (lines[from.line - 1] ?? "").trim() !== "" ? "\n" : "";
  const next = lines[to.line + 1];
  const suffix = textAfter.trim() !== "" ? "\n\n" : next !== undefined && next.trim() !== "" ? "\n" : "";
  return { from: start, to: end, text: `${prefix}${block}${suffix}` };
}

/** Where the cursor stands after `text` was inserted at `from`: at the end of it. */
export function endOf(from: Pos, text: string): Pos {
  const parts = text.split("\n");
  const last = parts[parts.length - 1] ?? "";
  return parts.length === 1 ? { line: from.line, ch: from.ch + last.length } : { line: from.line + parts.length - 1, ch: last.length };
}

// ---- the form's state -------------------------------------------------------------------------------------------------------------------

export interface FormState {
  canInsert: boolean;
  /** Next to the link field; empty while nothing has been typed there. */
  linkProblem: string;
  /** The block as it will be written (a "…" stands in for a quote not typed yet); empty until the address is usable. */
  preview: string;
  formatFellBack: boolean;
}

export function formState(input: WebQuoteInput, options: WebQuoteOptions): FormState {
  const built = buildWebQuote(input, options);
  const cleaned = cleanUrl(input.link, options.stripTracking);
  const linkProblem = input.link.trim() === "" || cleaned.ok ? "" : cleaned.reason;
  const formatFellBack = formatProblem(options.format) !== null;
  if (built.ok) return { canInsert: true, linkProblem, preview: built.text, formatFellBack: built.formatFellBack };
  if (!cleaned.ok) return { canInsert: false, linkProblem, preview: "", formatFellBack };
  const quote = quoteText(input.quote);
  const text = input.alias.trim() !== "" ? input.alias : shortLink(cleaned.url);
  return { canInsert: false, linkProblem, preview: renderFormat(formatFellBack ? DEFAULT_FORMAT : options.format, { quote: quote.length > 0 ? quote : ["…"], text, url: cleaned.url }), formatFellBack };
}

// ---- the saved draft --------------------------------------------------------------------------------------------------------------------

export const DRAFT_KEY = "blyg-web-quote-draft-v1";

/** What was typed, as kept on the device (never in the settings file, never sent anywhere). */
export function parseDraft(raw: unknown): WebQuoteInput {
  const empty: WebQuoteInput = { quote: "", link: "", alias: "" };
  if (typeof raw !== "string") return empty;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof WebQuoteInput, unknown>>;
    return { quote: typeof p.quote === "string" ? p.quote : "", link: typeof p.link === "string" ? p.link : "", alias: typeof p.alias === "string" ? p.alias : "" };
  } catch {
    return empty;
  }
}

export const draftIsEmpty = (d: WebQuoteInput): boolean => d.quote.trim() === "" && d.link.trim() === "" && d.alias.trim() === "";
