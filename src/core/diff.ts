// A readable diff for the preview window: lines first (cheap, handles long essays), then words inside the lines that
// changed. Pure; sizes are capped so a phone never spends seconds on a pathological input.

export type DiffOp = { type: "same" | "del" | "add"; text: string };

export type DiffBlock =
  | { kind: "same"; text: string }
  | { kind: "change"; ops: DiffOp[] };

export interface TextDiff {
  blocks: DiffBlock[];
  addedWords: number;
  removedWords: number;
  /** True when the texts are equal. */
  identical: boolean;
}

const MAX_CELLS = 2_000_000;

/** Generic LCS diff over token arrays, after trimming the common prefix and suffix. Falls back to one del + one add. */
function diffTokens(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).join("");
  const tail = a.slice(endA).join("");
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffOp[] = [];
  if (head) ops.push({ type: "same", text: head });

  if (midA.length * midB.length > MAX_CELLS) {
    if (midA.length) ops.push({ type: "del", text: midA.join("") });
    if (midB.length) ops.push({ type: "add", text: midB.join("") });
  } else if (midA.length === 0 || midB.length === 0) {
    if (midA.length) ops.push({ type: "del", text: midA.join("") });
    if (midB.length) ops.push({ type: "add", text: midB.join("") });
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const row = lcs[i] as Uint32Array;
        row[j] = midA[i] === midB[j] ? ((lcs[i + 1] as Uint32Array)[j + 1] ?? 0) + 1 : Math.max((lcs[i + 1] as Uint32Array)[j] ?? 0, row[j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    const push = (type: DiffOp["type"], text: string): void => {
      const last = ops[ops.length - 1];
      if (last && last.type === type) last.text += text;
      else ops.push({ type, text });
    };
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push("same", midA[i] as string);
        i++;
        j++;
      } else if (((lcs[i + 1] as Uint32Array)[j] ?? 0) >= ((lcs[i] as Uint32Array)[j + 1] ?? 0)) {
        push("del", midA[i++] as string);
      } else {
        push("add", midB[j++] as string);
      }
    }
    while (i < n) push("del", midA[i++] as string);
    while (j < m) push("add", midB[j++] as string);
  }
  if (tail) ops.push({ type: "same", text: tail });
  return ops;
}

const words = (text: string): string[] => text.split(/(\s+)/).filter((t) => t !== "");
/** Lines with their line breaks kept (no regex lookbehind: older iOS versions do not support it). */
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * Diff `before` against `after`. Unchanged stretches come back as `same` blocks (the UI shows a little context
 * around changes), changed stretches as word-level ops.
 */
export function diffText(before: string, after: string): TextDiff {
  if (before === after) return { blocks: [{ kind: "same", text: after }], addedWords: 0, removedWords: 0, identical: true };

  const lineOps = diffTokens(lines(before), lines(after));
  const blocks: DiffBlock[] = [];
  let added = 0;
  let removed = 0;

  for (let k = 0; k < lineOps.length; k++) {
    const op = lineOps[k] as DiffOp;
    if (op.type === "same") {
      blocks.push({ kind: "same", text: op.text });
      continue;
    }
    // A run of del/add line ops becomes one changed block, refined to words.
    let delText = "";
    let addText = "";
    while (k < lineOps.length && (lineOps[k] as DiffOp).type !== "same") {
      const cur = lineOps[k] as DiffOp;
      if (cur.type === "del") delText += cur.text;
      else addText += cur.text;
      k++;
    }
    k--;
    const wordOps = diffTokens(words(delText), words(addText));
    for (const w of wordOps) {
      if (w.type === "add") added += countWords(w.text);
      if (w.type === "del") removed += countWords(w.text);
    }
    blocks.push({ kind: "change", ops: wordOps });
  }
  return { blocks, addedWords: added, removedWords: removed, identical: false };
}
