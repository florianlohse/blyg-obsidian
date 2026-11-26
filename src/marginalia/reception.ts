// HK3 Marginalia (read-only): from the quotes found in the posts that quote a note, to what the note shows: a marker at the end of the paragraph a passage
// sits in, and a "Reception" list that also holds whole-post quotes, quotes whose text is no longer in the note, and mentions that could not be read.
// Pure: no Obsidian, no network. The quoted text of a stranger is only ever held in memory by the callers; nothing here writes anything.
import { findPassage, type PassageMethod } from "../core/passage";
import { parseQuoteRefs } from "../core/quoteRefs";
import { relationWords } from "../studio/reading";
import type { FoundQuote, MarginaliaEntry, MarginaliaMention, QuoteParser, UnknownReason } from "./lookup";

/** The quote parser of the lookup, made from HK0's: the quotes of `itemId` in a post's Markdown. A directive with `>` lines is a passage, without them the whole post. */
export const parseQuotesOf: QuoteParser = (markdown, itemId) =>
  parseQuoteRefs(markdown)
    .filter((r) => r.itemId === itemId)
    .map((r): FoundQuote => (r.passageText !== null && r.passageText.trim() !== "" ? { kind: "passage", text: r.passageText } : { kind: "whole" }));

/** A paragraph of the note: where it ends in the text (for the marker) and its words without Markdown (for the match). */
export interface NoteParagraph {
  from: number;
  /** The end of its last line, not counting the line break. */
  to: number;
  plain: string;
}

const DIRECTIVE_LINE = /^\s*!\[\[[^\]]*\]\]\s*$/;

/** Reduce one paragraph's Markdown to its words: links to their text, emphasis marks and tags gone. Only used to compare, never shown. */
export function plainOfParagraph(md: string): string {
  return md
    .split("\n")
    .map((l) => l.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, ""))
    .join(" ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~=`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The paragraphs of a note's text (frontmatter, code blocks and quote-directive lines left out), in order, with where each ends. */
export function paragraphsOf(text: string): NoteParagraph[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: NoteParagraph[] = [];
  let offset = 0;
  let i = 0;
  const starts: number[] = [];
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  if ((lines[0] ?? "").trim() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (close > 0) i = close + 1;
  }
  let block: number[] = [];
  let fenced = false;
  const flush = (): void => {
    if (block.length > 0) {
      const first = block[0] as number;
      const last = block[block.length - 1] as number;
      const plain = plainOfParagraph(block.map((k) => lines[k] ?? "").join("\n"));
      if (plain !== "") out.push({ from: starts[first] ?? 0, to: (starts[last] ?? 0) + (lines[last] ?? "").length, plain });
    }
    block = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.trim() === "" || DIRECTIVE_LINE.test(line)) flush();
    else block.push(i);
  }
  flush();
  return out;
}

export type Placement =
  /** The passage is in this paragraph of the note (the last one it spans): a marker goes at its end. */
  | { kind: "paragraph"; index: number; method: Extract<PassageMethod, "exact" | "normalised"> }
  /** The post quotes the whole item. */
  | { kind: "whole" }
  /** A reply (relation `stub`) whose text quotes nothing of the item. */
  | { kind: "reply" }
  /** The post quotes a passage the note no longer holds as written (the note changed after the quote, or the match is only by word overlap). */
  | { kind: "earlier" }
  /** The post says it quotes, but what it quotes could not be read. Never to be shown as "no quotes". */
  | { kind: "unknown"; reason: UnknownReason };

export interface ReceptionRow {
  mention: MarginaliaMention;
  placement: Placement;
  /** The quoted words, for the list (a stranger's text: shown, never stored). */
  excerpt: string | null;
  /** The whole quoted passage (not cut like `excerpt`), to find it in the note's text for the mark. Memory only. */
  passage?: string | null;
}

/** One row per quote found; a mention whose quotes could not be read gives one `unknown` row. Newest mention first, as the lookup gave them. */
export function buildReception(entries: MarginaliaEntry[], paragraphs: NoteParagraph[]): ReceptionRow[] {
  const plain = paragraphs.map((p) => p.plain);
  const rows: ReceptionRow[] = [];
  for (const e of entries) {
    if (e.result.kind === "unknown") {
      rows.push({ mention: e.mention, placement: { kind: "unknown", reason: e.result.reason }, excerpt: null });
      continue;
    }
    if (e.result.quotes.length === 0) {
      rows.push({ mention: e.mention, placement: { kind: "reply" }, excerpt: null });
      continue;
    }
    for (const q of e.result.quotes) {
      if (q.kind === "whole") {
        rows.push({ mention: e.mention, placement: { kind: "whole" }, excerpt: null });
        continue;
      }
      const hit = findPassage(q.text, plain);
      const excerpt = q.text.length > 160 ? `${q.text.slice(0, 157)}…` : q.text;
      const placement: Placement = hit && hit.method !== "overlap" ? { kind: "paragraph", index: hit.end, method: hit.method } : { kind: "earlier" };
      rows.push({ mention: e.mention, placement, excerpt, passage: q.text });
    }
  }
  return rows;
}

/** The rows that sit in the note, grouped by the paragraph they end in. */
export function markersOf(rows: ReceptionRow[]): Map<number, ReceptionRow[]> {
  const by = new Map<number, ReceptionRow[]>();
  for (const r of rows) {
    if (r.placement.kind !== "paragraph") continue;
    const list = by.get(r.placement.index) ?? [];
    list.push(r);
    by.set(r.placement.index, list);
  }
  return by;
}

/** Who, in words: the author's name, else the host of their blyg, else "Someone". */
export function whoOf(m: MarginaliaMention): string {
  if (m.sourceAuthorName) return m.sourceAuthorName;
  try {
    return m.sourceOrigin ? new URL(m.sourceOrigin).host : "Someone";
  } catch {
    return "Someone";
  }
}

/** "Teo quoted this" (the relation as the Studio reports it). */
export const leadOf = (m: MarginaliaMention): string => `${whoOf(m)} ${relationWords(m.relation)} this`;

/** What a row says about where the quote is, for the list; null for a passage that sits in the note (the marker says it). */
export function placementNote(p: Placement): string | null {
  switch (p.kind) {
    case "paragraph": return null;
    case "whole": return "the whole post";
    case "reply": return "a reply, with no quote";
    case "earlier": return "from an earlier version";
    case "unknown": return p.reason === "over-cap" ? "not looked up yet" : p.reason === "unreadable" ? "the Studio does not hold this post, so what it quotes cannot be read" : "what it quotes could not be read";
  }
}

/** Where a passage stands, word for word, inside one paragraph of the note's Markdown: the span to underline. Null when it is not there as written (marks and links in the
 *  Markdown, a different case, a passage of several lines or paragraphs): the mark then goes at the paragraph's end instead. */
export function locatePassage(passage: string, para: NoteParagraph, docText: string): { from: number; to: number } | null {
  const text = passage.trim();
  if (text === "" || text.includes("\n")) return null;
  const at = docText.slice(para.from, para.to).indexOf(text);
  return at < 0 ? null : { from: para.from + at, to: para.from + at + text.length };
}

/** One mark in the text: the rows it stands for, where it sits, and the words to underline when the passage was found as written. */
export interface MarkGroup {
  pos: number;
  rows: ReceptionRow[];
  range: { from: number; to: number } | null;
}

/** The marks of a note: a quote found word for word is underlined with its count after the words; the rest of a paragraph's quotes share one count at the paragraph's end. */
export function markGroups(rows: ReceptionRow[], paragraphs: NoteParagraph[], docText: string): MarkGroup[] {
  const out: MarkGroup[] = [];
  for (const [index, list] of [...markersOf(rows)].sort((a, b) => a[0] - b[0])) {
    const para = paragraphs[index];
    if (!para) continue;
    const spans = new Map<string, MarkGroup>();
    const rest: ReceptionRow[] = [];
    for (const r of list) {
      const range = r.placement.kind === "paragraph" && r.placement.method === "exact" && r.passage ? locatePassage(r.passage, para, docText) : null;
      if (!range) { rest.push(r); continue; }
      const key = `${range.from}:${range.to}`;
      const g = spans.get(key) ?? { pos: range.to, rows: [], range };
      g.rows.push(r);
      spans.set(key, g);
    }
    out.push(...spans.values());
    if (rest.length > 0) out.push({ pos: para.to, rows: rest, range: null });
  }
  return out;
}
