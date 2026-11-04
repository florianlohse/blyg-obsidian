// The pure parts of the thread commands ("New Blyg thread", "Make this note a thread", "Insert quote…"): names, the text a
// quote inserts and where, and which of the author's notes the picker offers. No Obsidian here; src/ui and src/main.ts draw and wire.
import { BLYG_ID_PATTERN, isBlygId } from "../core/ids";
import { stripObsidianComments } from "../core/comments";
import { stripFrontmatter } from "../core/frontmatter";
import { quoteFromSelection } from "../core/quote";
import { normalizeSelection } from "../core/textContent";

/** The text of a new thread note: the property that makes it a thread, then an empty body. */
export const NEW_THREAD_TEXT = "---\nblyg_kind: thread\n---\n\n";

const two = (n: number): string => String(n).padStart(2, "0");

/** The text of a new fragment: empty. */
export const NEW_NOTE_TEXT = "";

/** "Thread 2026-10-10 0930" (or "Fragment …"), with " 2", " 3" … when that name is taken. Local time: it is a name for the author. */
export function newItemName(prefix: "Thread" | "Fragment", now: Date, taken: (name: string) => boolean): string {
  const base = `${prefix} ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())}`;
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
  return `${base} ${now.getSeconds()}`;
}

/**
 * The name a fragment made into a thread gets: "Fragment 2026-10-10 0930 2" becomes "Thread 2026-10-10 0930 2" (the number is kept if
 * that name is free, else the next free one). Only the plugin's own automatic names are renamed; a name the author chose is theirs.
 */
export function renamedForThread(basename: string, taken: (name: string) => boolean): string | null {
  const m = /^Fragment (\d{4}-\d{2}-\d{2} \d{4})(?: (\d+))?$/.exec(basename);
  if (m === null) return null;
  const base = `Thread ${m[1]}`;
  const wanted = m[2] === undefined ? base : `${base} ${m[2]}`;
  if (!taken(wanted)) return wanted;
  for (let n = 2; n < 1000; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
  return null;
}

export const newThreadName = (now: Date, taken: (name: string) => boolean): string => newItemName("Thread", now, taken);

/** What the quote picker gives back. */
export type QuoteChoice = { kind: "whole" } | { kind: "passage"; selected: string };

/**
 * The lines a quote adds to a thread: an embed of the quoted note, plus the attached blockquote for a passage. `ref` is what Obsidian
 * links by (the note's name, or its path when the name is ambiguous): the plugin turns it into the note's id when publishing
 * (publish/embeds.ts). A 26-character id is accepted too.
 */
export function quoteBlock(ref: string, choice: QuoteChoice): { ok: true; text: string } | { ok: false; reason: "empty" | "cannot" | "bad-ref" } {
  if (!BLYG_ID_PATTERN.test(ref) && (ref.trim() === "" || /[[\]|#^\n]/.test(ref))) return { ok: false, reason: "bad-ref" };
  return quoteBlockOf(ref, choice);
}

/** The same lines for `inner` taken as given: the Studio picker writes `id | label` between the brackets, which `quoteBlock` would refuse as a name. */
export function quoteBlockOf(inner: string, choice: QuoteChoice): { ok: true; text: string } | { ok: false; reason: "empty" | "cannot" } {
  if (choice.kind === "whole") return { ok: true, text: `![[${inner}]]` };
  const selection = normalizeSelection(choice.selected);
  if (selection === "") return { ok: false, reason: "empty" };
  const quote = quoteFromSelection(selection);
  if (quote === null) return { ok: false, reason: "cannot" };
  return { ok: true, text: `![[${inner}]]\n${quote}` };
}

/**
 * The text to put at the cursor so the block stands on its own lines with blank lines round it (a directive needs a line of its
 * own). `before`/`after`: the current line left and right of the cursor; `previousLine`: the line above, if any.
 */
export function blockToInsert(at: { before: string; after: string; previousLine: string | undefined }, block: string): string {
  const lead = at.before.trim() !== "" ? "\n\n" : at.previousLine !== undefined && at.previousLine.trim() !== "" ? "\n" : "";
  return `${lead}${block}\n\n`;
}

/** "Make this note a thread" is allowed only for a note that has never been published: the kind never changes afterwards. */
export function threadConversion(note: { inBlygRoute: boolean; id: unknown; kind: unknown }): { ok: true } | { ok: false; message: string } {
  if (!note.inBlygRoute) return { ok: false, message: "Only a note in a Blyg folder can be a thread." };
  if (note.kind === "thread") return { ok: false, message: "This note is already a thread." };
  const hasId = note.id !== undefined && note.id !== null && note.id !== "" && note.id !== false;
  if (hasId) return { ok: false, message: "This note is already published as a fragment, and the kind of a published item never changes. Start a new thread note instead." };
  if (note.kind !== undefined && note.kind !== null && note.kind !== "" && note.kind !== "fragment") {
    return { ok: false, message: "The note has a blyg_kind the plugin does not know. Fix or remove it in the properties." };
  }
  return { ok: true };
}

/** A note the picker may offer. `text` is the note as written (frontmatter included). */
export interface PickerEntry {
  path: string;
  name: string;
  frontmatter: { blyg_id?: unknown; blyg_withdrawn?: unknown; blyg_updated?: unknown; blyg_channel?: unknown };
  text: string;
}

export interface PickerCandidate {
  id: string;
  path: string;
  name: string;
  /** The first words of the note, to tell notes apart (a fragment has no title). */
  excerpt: string;
}

const EXCERPT_CHARS = 90;

function firstWords(text: string): string {
  const stripped = stripObsidianComments(stripFrontmatter(text));
  const body = stripped.ok ? stripped.text : stripFrontmatter(text);
  const line = body.split("\n").find((l) => l.trim() !== "" && !/^\s*!\[\[/.test(l)) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS).trimEnd()}…` : flat;
}

const timeOf = (value: unknown): number => {
  const t = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The author's own published items, newest first: notes with a valid `blyg_id` that are not withdrawn and are not the thread being
 * written. On production, notes published to the test channel are left out (they cannot exist there). Only a hint of what can be
 * quoted: the lookup behind it (the repository and the site) has the last word.
 */
export function pickerCandidates(entries: PickerEntry[], opts: { activePath: string | undefined; channel: "production" | "preview" }): PickerCandidate[] {
  return entries
    .filter((e) => e.path !== opts.activePath)
    .filter((e) => isBlygId(e.frontmatter.blyg_id) && e.frontmatter.blyg_withdrawn !== true)
    .filter((e) => !(opts.channel === "production" && e.frontmatter.blyg_channel === "preview"))
    .sort((a, b) => timeOf(b.frontmatter.blyg_updated) - timeOf(a.frontmatter.blyg_updated) || a.name.localeCompare(b.name))
    .map((e) => ({ id: e.frontmatter.blyg_id as string, path: e.path, name: e.name, excerpt: firstWords(e.text) }));
}

/** How many text rows the box needs: one per paragraph break plus one per ~36 characters, at least 3, at most 12. */
export function quoteBoxRows(text: string): number {
  const rows = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 36)), 0);
  return Math.min(12, Math.max(3, rows));
}


/**
 * May text be moved out of this note into a new item, leaving an embed behind? (Florian, 2026-10-16: refuse for essays and pages.)
 * An essay or page is copied to the site as it is, so a left-behind `![[…]]` would show as literal brackets and break the deploy; a
 * fragment cannot quote at all. A thread, or a note outside the publish folders (which is never published), can.
 */
export function extractionVerdict(note: { routeMode: "blyg" | "plain" | "studio" | null; kind: "fragment" | "thread"; hasId: boolean }): { ok: true } | { ok: false; reason: "plain-route" | "fragment" | "published-fragment" } {
  if (note.routeMode === "plain") return { ok: false, reason: "plain-route" };
  if ((note.routeMode === "blyg" || note.routeMode === "studio") && note.kind === "fragment") return { ok: false, reason: note.hasId ? "published-fragment" : "fragment" };
  return { ok: true };
}

/** What the new item made from a selection holds: the selection with its surrounding blank lines gone (the template, if any, comes before it). */
export function extractedItemBody(selection: string): string {
  return `${selection.trim()}\n`;
}

/**
 * What stands in the original in place of the moved selection: an embed of the new item on a line of its own (a quote needs one), with a
 * paragraph break where the selection began or ended inside a line. `before`/`after` are the original's line text left of the selection's
 * start and right of its end; `ref` is what Obsidian links the new item by.
 */
export function embedReplacement(at: { before: string; after: string }, ref: string): string {
  return `${at.before.trim() !== "" ? "\n\n" : ""}![[${ref}]]${at.after.trim() !== "" ? "\n\n" : ""}`;
}
