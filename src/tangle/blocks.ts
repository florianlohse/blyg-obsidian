// V1-C.2: Obsidian blocks. Any plain paragraph in a note can be published as an item: it gets Obsidian's own block id (`^ab12`, at the end of the paragraph)
// and `![[Note#^ab12]]` in a thread quotes it. Pure: no Obsidian, no network.
import type { Random } from "../platform/ports";
import { maskCode } from "../core/links";
import { isBlygId } from "../core/ids";

export type ParagraphProblem = "properties" | "blank" | "code" | "heading" | "list" | "quote" | "table" | "html" | "other";

export interface Paragraph {
  /** 1-based lines of the paragraph in the note's text. */
  startLine: number;
  endLine: number;
  /** The paragraph's words as they would be published: its lines, without the block id. */
  text: string;
  /** The block id the paragraph already has (`^ab12` at its end), or null. */
  blockId: string | null;
}

const NOT_PLAIN: Array<[RegExp, ParagraphProblem]> = [
  [/^\s{0,3}#{1,6}(\s|$)/, "heading"],
  [/^\s*([-*+]|\d{1,9}[.)])\s/, "list"],
  [/^\s*>/, "quote"],
  [/^\s*\|/, "table"],
  [/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, "other"],
  [/^\s*</, "html"],
  [/^\s*\[\^?[^\]]+\]:\s/, "other"],
  [/^\s*\^[A-Za-z0-9-]+\s*$/, "other"],
  [/^\s*%%/, "other"],
];
const ID_AT_END = /(^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;

/** Where the properties block ends: the 0-based index of its closing `---` line, or -1 when the note has none. */
function propertiesEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i++) if (lines[i]?.trim() === "---") return i;
  return -1;
}

/** The plain paragraph around 1-based `line` of a note's whole text, or why there is none. Lists, quotes, tables, headings, code and html are not offered. */
export function paragraphAt(raw: string, line: number): { ok: true; paragraph: Paragraph } | { ok: false; problem: ParagraphProblem } {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
  const masked = maskCode(raw).split("\n");
  const at = line - 1;
  if (at < 0 || at >= lines.length) return { ok: false, problem: "blank" };
  if (at <= propertiesEnd(lines)) return { ok: false, problem: "properties" };
  const blank = (i: number): boolean => (lines[i] ?? "").trim() === "";
  if (blank(at)) return { ok: false, problem: "blank" };
  const codeLine = (i: number): boolean => (lines[i] ?? "").trim() !== "" && (masked[i] ?? "").trim() === "";
  if (codeLine(at)) return { ok: false, problem: "code" };
  const floor = propertiesEnd(lines) + 1;
  let a = at;
  while (a - 1 >= floor && !blank(a - 1)) a--;
  let b = at;
  while (b + 1 < lines.length && !blank(b + 1)) b++;
  for (let i = a; i <= b; i++) {
    if (codeLine(i)) return { ok: false, problem: "code" };
    const bad = NOT_PLAIN.find(([re]) => re.test(lines[i] ?? ""));
    if (bad) return { ok: false, problem: bad[1] };
  }
  const own = lines.slice(a, b + 1);
  const last = own[own.length - 1] ?? "";
  const id = ID_AT_END.exec(last);
  const withoutId = id ? [...own.slice(0, -1), last.slice(0, id.index).replace(/[ \t]+$/, "")] : own;
  const text = withoutId.join("\n").trim();
  if (text === "") return { ok: false, problem: "blank" };
  return { ok: true, paragraph: { startLine: a + 1, endLine: b + 1, text, blockId: id ? (id[2] as string) : null } };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A new block id the way Obsidian makes them (6 lowercase letters and digits) that the note does not use yet. */
export function newBlockId(random: Random, noteText: string): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = random.bytes(6);
    const id = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    if (!new RegExp(`\\^${id}(?![A-Za-z0-9-])`).test(noteText)) return id;
  }
  throw new Error("could not make a block id the note does not use");
}

/** The body with ` ^id` at the end of the paragraph whose words are `paragraphText` and which has no id. Null unless exactly one paragraph matches. */
export function withBlockId(body: string, paragraphText: string, id: string): string | null {
  const lines = body.split("\n");
  const want = paragraphText.split("\n");
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => (lines[i + k] ?? "").replace(/\r$/, "").trimEnd() === w.trimEnd()) && (i === 0 || (lines[i - 1] ?? "").trim() === "") && ((lines[i + want.length] ?? "").trim() === "")) hits.push(i);
  }
  if (hits.length !== 1) return null;
  const lastAt = (hits[0] as number) + want.length - 1;
  const last = lines[lastAt] ?? "";
  const cr = last.endsWith("\r") ? "\r" : "";
  lines[lastAt] = `${last.replace(/\r$/, "").trimEnd()} ^${id}${cr}`;
  return lines.join("\n");
}

export interface BlockEmbed {
  line: number;
  host: string;
  blockId: string;
}
export interface HeadingEmbed {
  line: number;
  target: string;
}

const BLOCK_EMBED = /^\s*!\[\[([^[\]|#\n]*)#\^([A-Za-z0-9-]+)\]\]\s*$/;
const HEADING_EMBED = /^\s*!\[\[([^[\]|#\n]*)#([^^[\]|\n][^[\]|\n]*)(?:\|[^[\]\n]*)?\]\]\s*$/;

/** Own-line embeds of one block (`![[Note#^ab12]]`) and of a heading's section (`![[Note#Heading]]`), outside code, as the lines of a thread. */
export function blockEmbeds(text: string): { blocks: BlockEmbed[]; headings: HeadingEmbed[] } {
  const blocks: BlockEmbed[] = [];
  const headings: HeadingEmbed[] = [];
  const masked = maskCode(text).split("\n");
  text.split("\n").forEach((line, i) => {
    if (masked[i] !== line) return;
    const b = BLOCK_EMBED.exec(line);
    if (b) return void blocks.push({ line: i + 1, host: (b[1] ?? "").trim(), blockId: b[2] as string });
    const h = HEADING_EMBED.exec(line);
    if (h) headings.push({ line: i + 1, target: `${(h[1] ?? "").trim()}#${(h[2] ?? "").trim()}` });
  });
  return { blocks, headings };
}

/** The `blyg_blocks` property: block id to item id. Anything else in it (a hand edit) is left out. */
export function readBlockMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, id] of Object.entries(value)) if (/^[A-Za-z0-9-]+$/.test(key) && isBlygId(id)) out[key] = id;
  return out;
}

/** The plain paragraph that carries block id `^blockId` (at its end), or null: the id is not in the note, or what carries it is not a plain paragraph. */
export function paragraphOfBlock(raw: string, blockId: string): Paragraph | null {
  const lines = raw.split("\n");
  const at = lines.findIndex((l) => ID_AT_END.exec(l.replace(/\r$/, ""))?.[2] === blockId);
  if (at < 0) return null;
  const found = paragraphAt(raw, at + 1);
  return found.ok && found.paragraph.blockId === blockId ? found.paragraph : null;
}
