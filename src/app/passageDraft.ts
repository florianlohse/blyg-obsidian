// "Draft as Blyg fragment / thread" (feature `passages`): what a selection in a note becomes. The selection is COPIED into an independent draft; the note is
// not changed. A selection may hold a captured quote (a directive line `![[id | label]]` with its attached `>` lines, the shape the quote picker and "Send
// passage to note" write). The Studio takes such a quote in a thread and refuses it in a fragment (text.ts `fragment-quote`), and a quote cut in half is no quote:
// so the selection is classified first, and the writer is asked before anything is written. Pure; the editor and the vault are in src/app/passageDraftEntry.ts.
import { scanStudioQuotes } from "../studio/text";
import { extractedItemBody } from "./threadCommands";

export interface Pos {
  line: number;
  ch: number;
}

/** A directive line with its attached quote lines: 0-based first and last line. */
export interface QuoteBlock {
  first: number;
  last: number;
}

export type DraftPlan =
  | { kind: "empty" }
  /** Only the writer's own words (no quote inside or touched). */
  | { kind: "words"; body: string }
  /** One or more whole quote blocks, intact: only a thread can hold them. */
  | { kind: "quotes"; body: string; count: number }
  /** The selection starts or ends inside a quote block. `expanded` takes the whole block(s) in; `trimmed` leaves them out ("" when nothing else is selected). */
  | { kind: "cuts"; expanded: string; trimmed: string; count: number };

/** The quote blocks of a note's text, outside code, in order. */
export function quoteBlocks(text: string): QuoteBlock[] {
  return scanStudioQuotes(text).quotes.map((q) => ({ first: q.line - 1, last: q.line - 1 + (q.quoteMd === null ? 0 : q.quoteMd.split("\n").length) }));
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The text of [from, to] taken from the note's lines (so a CRLF note and a selection made in either direction give the same words). */
function sliceText(lines: readonly string[], from: Pos, to: Pos): string {
  const out: string[] = [];
  for (let i = from.line; i <= to.line; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    out.push(line.slice(i === from.line ? from.ch : 0, i === to.line ? to.ch : line.length));
  }
  return out.join("\n");
}

/** Classify the selection `from`..`to` of the note `text`. */
export function planSelection(text: string, a: Pos, b: Pos): DraftPlan {
  const lines = text.split("\n");
  const [from, to0] = a.line < b.line || (a.line === b.line && a.ch <= b.ch) ? [a, b] : [b, a];
  // A selection that ends at the very start of a line does not touch that line.
  const to: Pos = to0.ch === 0 && to0.line > from.line ? { line: to0.line - 1, ch: (lines[to0.line - 1] ?? "").replace(/\r$/, "").length } : to0;
  const own = sliceText(lines, from, to);
  if (own.trim() === "") return { kind: "empty" };

  const touched = quoteBlocks(text).filter((q) => from.line <= q.last && to.line >= q.first);
  if (touched.length === 0) return { kind: "words", body: extractedItemBody(own) };

  const startsBefore = (q: QuoteBlock): boolean => from.line < q.first || (from.line === q.first && from.ch <= indentOf(lines[q.first] ?? ""));
  const endsAfter = (q: QuoteBlock): boolean => to.line > q.last || (to.line === q.last && to.ch >= (lines[q.last] ?? "").replace(/\r$/, "").trimEnd().length);
  const cut = touched.some((q) => !(startsBefore(q) && endsAfter(q)));
  if (!cut) return { kind: "quotes", body: extractedItemBody(own), count: touched.length };

  // Take the whole blocks in: the range grows to the start of the first touched block and the end of the last one.
  const first = touched[0] as QuoteBlock;
  const last = touched[touched.length - 1] as QuoteBlock;
  const wide: [Pos, Pos] = [
    from.line > first.first ? { line: first.first, ch: 0 } : from.line === first.first ? { line: from.line, ch: 0 } : from,
    to.line < last.last ? { line: last.last, ch: (lines[last.last] ?? "").replace(/\r$/, "").length } : to.line === last.last ? { line: to.line, ch: (lines[to.line] ?? "").replace(/\r$/, "").length } : to,
  ];
  const expanded = extractedItemBody(sliceText(lines, wide[0], wide[1]));

  // Leave them out: only the selected lines that are not in a touched block, as separate paragraphs.
  const inBlock = (i: number): boolean => touched.some((q) => i >= q.first && i <= q.last);
  const pieces: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.join("\n").trim() !== "") pieces.push(run.join("\n").trim());
    run = [];
  };
  for (let i = from.line; i <= to.line; i++) {
    if (inBlock(i)) {
      flush();
      continue;
    }
    const line = (lines[i] ?? "").replace(/\r$/, "");
    run.push(line.slice(i === from.line ? from.ch : 0, i === to.line ? to.ch : line.length));
  }
  flush();
  return { kind: "cuts", expanded, trimmed: pieces.length === 0 ? "" : extractedItemBody(pieces.join("\n\n")), count: touched.length };
}

/** What the writer is asked (or not) for this plan and this command, before anything is written. */
export type DraftDecision =
  | { ask: false; kind: "fragment" | "thread"; body: string }
  | { ask: false; refuse: "empty" | "too-long"; length?: number; cap?: number }
  | { ask: true; why: "quotes" | "cuts"; options: DraftOption[] };

export interface DraftOption {
  /** What the button says. */
  id: "thread-with-quote" | "words-only-fragment" | "words-only-thread" | "include-quote" | "leave-quote-out-fragment" | "leave-quote-out-thread";
  kind: "fragment" | "thread";
  body: string;
}

export function decideDraft(plan: DraftPlan, wanted: "fragment" | "thread", fragmentCap: number): DraftDecision {
  const tooLong = (body: string): boolean => wanted === "fragment" && body.trim().length > fragmentCap;
  if (plan.kind === "empty") return { ask: false, refuse: "empty" };
  if (plan.kind === "words") return tooLong(plan.body) ? { ask: false, refuse: "too-long", length: plan.body.trim().length, cap: fragmentCap } : { ask: false, kind: wanted, body: plan.body };
  if (plan.kind === "quotes") {
    if (wanted === "thread") return { ask: false, kind: "thread", body: plan.body };
    return { ask: true, why: "quotes", options: [{ id: "thread-with-quote", kind: "thread", body: plan.body }] };
  }
  const options: DraftOption[] = [{ id: "include-quote", kind: "thread", body: plan.expanded }];
  if (plan.trimmed !== "") options.push(wanted === "thread" ? { id: "leave-quote-out-thread", kind: "thread", body: plan.trimmed } : { id: "leave-quote-out-fragment", kind: "fragment", body: plan.trimmed });
  return { ask: true, why: "cuts", options };
}

/** Where a draft came from, for "Back to the note". Kept in the plugin's own storage, never in the draft. `hash` tells whether the selected words are still there. */
export interface DraftOrigin {
  path: string;
  from: Pos;
  to: Pos;
  hash: string;
}

export const ORIGINS_MAX = 30;

/** A small stable hash of the selected words (djb2): enough to tell "still the same words", not a secret. */
export function wordsHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const isPos = (v: unknown): v is Pos => typeof v === "object" && v !== null && Number.isInteger((v as Pos).line) && Number.isInteger((v as Pos).ch) && (v as Pos).line >= 0 && (v as Pos).ch >= 0;

/** The stored map read back; anything odd is dropped. Keys are draft paths. */
export function readOrigins(raw: unknown): Record<string, DraftOrigin> {
  const out: Record<string, DraftOrigin> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [draft, o] of Object.entries(raw)) {
    const r = o as Partial<DraftOrigin> | null;
    if (r && typeof r.path === "string" && typeof r.hash === "string" && isPos(r.from) && isPos(r.to)) out[draft] = { path: r.path, from: r.from, to: r.to, hash: r.hash };
  }
  return out;
}

/** The map with one more entry; the oldest go when there are more than ORIGINS_MAX. */
export function withOrigin(map: Record<string, DraftOrigin>, draftPath: string, origin: DraftOrigin): Record<string, DraftOrigin> {
  const entries = [...Object.entries(map).filter(([k]) => k !== draftPath), [draftPath, origin] as const];
  return Object.fromEntries(entries.slice(-ORIGINS_MAX));
}
