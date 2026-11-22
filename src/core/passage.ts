// Find a quoted passage in the paragraphs of a text (pure). The quote may have been made from an older version of the text, so
// the search relaxes in steps: exact, then the same words with spacing, case, quotation marks, dashes and punctuation ignored,
// then enough of the same words. The caller learns which step matched and how sure it is, and shows the paragraph, never edits.
import { foldTerm, tokenize } from "./terms";

export type PassageMethod = "exact" | "normalised" | "overlap";

export interface PassageMatch {
  /** The first paragraph holding the passage. */
  index: number;
  /** The last paragraph holding it (greater than `index` for a passage that spans several paragraphs). */
  end: number;
  /** 1 for an exact match, below 1 otherwise: 0.9 to 0.99 normalised, up to 0.9 for token overlap. */
  confidence: number;
  method: PassageMethod;
}

export interface FindPassageOptions {
  /** Smallest share of the passage's terms that a paragraph must contain for an overlap match (default 0.6). */
  minOverlap?: number;
  /** An overlap match needs at least this many distinct terms in the passage (default 3). */
  minTerms?: number;
}

/** Text reduced to words: case, accents, quotation marks, dashes, punctuation and runs of whitespace are all one space. */
export function normalizeForMatch(text: string): string {
  return foldTerm(text)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟«»″]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface Single {
  index: number;
  confidence: number;
  method: PassageMethod;
}

function findBlock(block: string, paragraphs: readonly string[], from: number, options: FindPassageOptions): Single | null {
  for (let i = from; i < paragraphs.length; i++) {
    if ((paragraphs[i] ?? "").includes(block)) return { index: i, confidence: 1, method: "exact" };
  }
  const wanted = normalizeForMatch(block);
  if (wanted === "") return null;
  const normalised = paragraphs.map((p) => normalizeForMatch(p));
  for (let i = from; i < paragraphs.length; i++) {
    const para = normalised[i] ?? "";
    if (para.includes(wanted)) {
      // A passage that is most of the paragraph is surer than a snippet of a long one.
      const share = Math.min(1, wanted.length / Math.max(1, para.length));
      return { index: i, confidence: 0.9 + 0.09 * share, method: "normalised" };
    }
  }
  const minTerms = options.minTerms ?? 3;
  let keepStopWords = false;
  let terms = [...new Set(tokenize(block))];
  if (terms.length < minTerms) {
    keepStopWords = true; // a passage made only of common words is still compared, on all its words
    terms = [...new Set(tokenize(block, { keepStopWords }))];
  }
  if (terms.length < minTerms) return null;
  const threshold = options.minOverlap ?? 0.6;
  let best: Single | null = null;
  let bestScore = 0;
  for (let i = from; i < paragraphs.length; i++) {
    const have = new Set(tokenize(paragraphs[i] ?? "", { keepStopWords }));
    let hit = 0;
    for (const t of terms) if (have.has(t)) hit++;
    const containment = hit / terms.length;
    if (containment < threshold) continue;
    // Among paragraphs with the same containment prefer the one that is not mostly other words.
    const score = containment + 0.01 * (hit / Math.max(1, have.size));
    if (score > bestScore) {
      bestScore = score;
      best = { index: i, confidence: Math.min(0.9, 0.9 * containment), method: "overlap" };
    }
  }
  return best;
}

/**
 * Where `passage` sits in `paragraphs`. Blocks of the passage separated by a blank line (or a line break) are each looked up, in
 * order; the result spans them. `null` when nothing is close enough: the caller then says the passage could not be found.
 */
export function findPassage(passage: string, paragraphs: readonly string[], options: FindPassageOptions = {}): PassageMatch | null {
  const trimmed = passage.trim();
  if (trimmed === "" || paragraphs.length === 0) return null;
  // The whole passage inside one paragraph first (a quote of a line break inside a paragraph stays one match).
  const whole = findBlock(trimmed, paragraphs, 0, options);
  if (whole && whole.method !== "overlap") return { index: whole.index, end: whole.index, confidence: whole.confidence, method: whole.method };
  const blocks = trimmed.split(/\n+/).map((b) => b.trim()).filter((b) => b !== "");
  if (blocks.length > 1) {
    let from = 0;
    let first = -1;
    let last = -1;
    let confidence = 1;
    let method: PassageMethod = "exact";
    let ok = true;
    for (const block of blocks) {
      const hit = findBlock(block, paragraphs, from, options);
      if (!hit) {
        ok = false;
        break;
      }
      if (first < 0) first = hit.index;
      last = hit.index;
      from = hit.index;
      confidence = Math.min(confidence, hit.confidence);
      if (hit.method === "overlap" || (hit.method === "normalised" && method === "exact")) method = hit.method;
    }
    if (ok) return { index: first, end: last, confidence, method };
  }
  return whole ? { index: whole.index, end: whole.index, confidence: whole.confidence, method: whole.method } : null;
}
