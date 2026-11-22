// Terms and ranking (pure: no Obsidian, no network, no storage): a Unicode tokenizer, German and English stop words, and a BM25 index.
// Used by the reader's digest and by anything that matches text against text. Deterministic: the same input gives the same order.

/** Words too common to say what a text is about (German and English). Compared after `foldTerm`, so write them folded (ß → ss, no umlaut marks kept). */
const STOP_WORDS_EN = `a about above after again against all also am an and any are as at be because been before being below between both but by can
could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it
its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such
than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which
while who whom why will with would you your yours yourself yourselves s t don isnt arent wasnt werent hasnt havent didnt doesnt wont cant
one two get got us via per`;

const STOP_WORDS_DE = `aber alle allem allen aller alles als also am an ander andere anderen anderer anderes anders auch auf aus bei bin bis bist da damit
dann der den des dem die das dass daß dein deine deinem deinen deiner deines dich dir doch dort du durch ein eine einem einen einer eines einig
einige einigen einiger einmal er es etwas euch euer eure eurem euren eurer fur gegen gewesen hab habe haben hat hatte hatten hier hin hinter ich
ihm ihn ihnen ihr ihre ihrem ihren ihrer im in indem ins ist ja jede jedem jeden jeder jedes jetzt kann kein keine keinem keinen keiner konnen
konnte machen man manche manchem manchen mancher manches mein meine meinem meinen meiner mich mir mit muss musste nach nicht nichts noch nun nur
ob oder ohne sehr sein seine seinem seinen seiner seines selbst sich sie sind so solche solchen solcher solches soll sollte sondern sonst uber um
und uns unse unsem unsen unser unses unter viel vom von vor wahrend war waren warst was weg weil weiter welche welchen welcher welches wenn werde
werden wie wieder will wir wird wirst wo wollen wollte wurde wurden zu zum zur zwar zwischen`;

/** Lower-case, canonical composition, ß → ss, and the diacritics of German vowels dropped (ä → a), so "Über" and "uber" meet. */
export function foldTerm(term: string): string {
  return term
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC");
}

export const STOP_WORDS: ReadonlySet<string> = new Set(
  `${STOP_WORDS_EN} ${STOP_WORDS_DE}`.split(/\s+/).filter(Boolean).map(foldTerm),
);

export interface TokenizeOptions {
  /** Keep stop words (default false). */
  keepStopWords?: boolean;
  /** Shortest term kept, in characters (default 2). */
  minLength?: number;
}

/** Terms of a text in order, repeats included: runs of letters and digits, folded; stop words and one-letter terms dropped. */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const min = options.minLength ?? 2;
  const out: string[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) {
    // "don't" → "dont": an apostrophe inside a word is not a boundary.
    const term = foldTerm(m[0].replace(/['’]/g, ""));
    if (term.length < min) continue;
    if (!options.keepStopWords && STOP_WORDS.has(term)) continue;
    out.push(term);
  }
  return out;
}

/** Term → count. */
export function termCounts(terms: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
  /** The query terms found in this document, in the order of the query. */
  terms: string[];
}

export interface Bm25Options {
  /** Term-frequency saturation (default 1.2). */
  k1?: number;
  /** Length normalisation (default 0.75). */
  b?: number;
}

export interface SearchOptions {
  /** At most this many hits (default: all). */
  limit?: number;
  /** Drop hits scoring below this (default 0: any match). */
  minScore?: number;
}

interface Posting {
  doc: number;
  tf: number;
}

/** A BM25 index over documents held in memory. Build once from documents, then `search` with text. */
export class Bm25Index {
  private readonly ids: string[] = [];
  private readonly lengths: number[] = [];
  private readonly postings = new Map<string, Posting[]>();
  private readonly avgLength: number;
  private readonly k1: number;
  private readonly b: number;

  constructor(documents: readonly Bm25Document[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    let total = 0;
    for (const doc of documents) {
      const terms = tokenize(doc.text);
      const index = this.ids.length;
      this.ids.push(doc.id);
      this.lengths.push(terms.length);
      total += terms.length;
      for (const [term, tf] of termCounts(terms)) {
        const list = this.postings.get(term);
        if (list) list.push({ doc: index, tf });
        else this.postings.set(term, [{ doc: index, tf }]);
      }
    }
    this.avgLength = documents.length > 0 ? total / documents.length : 0;
  }

  get size(): number {
    return this.ids.length;
  }

  /** How many documents contain the term (the term as `tokenize` would give it). */
  documentFrequency(term: string): number {
    return this.postings.get(foldTerm(term))?.length ?? 0;
  }

  /** Documents ranked by BM25 against the query text: best first, ties in the order the documents were given. */
  search(query: string, options: SearchOptions = {}): Bm25Hit[] {
    const queryTerms = [...new Set(tokenize(query))];
    const n = this.ids.length;
    const scores = new Map<number, { score: number; found: Set<string> }>();
    for (const term of queryTerms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const len = this.lengths[doc] ?? 0;
        const norm = this.avgLength > 0 ? 1 - this.b + (this.b * len) / this.avgLength : 1;
        const part = (idf * (tf * (this.k1 + 1))) / (tf + this.k1 * norm);
        const entry = scores.get(doc);
        if (entry) {
          entry.score += part;
          entry.found.add(term);
        } else scores.set(doc, { score: part, found: new Set([term]) });
      }
    }
    const min = options.minScore ?? 0;
    const hits = [...scores.entries()]
      .filter(([, e]) => e.score > min || (min === 0 && e.score > 0))
      .sort((x, y) => y[1].score - x[1].score || x[0] - y[0])
      .map(([doc, e]) => ({
        id: this.ids[doc] ?? "",
        score: e.score,
        terms: queryTerms.filter((t) => e.found.has(t)),
      }));
    return options.limit === undefined ? hits : hits.slice(0, options.limit);
  }
}

/** Build an index from documents. */
export function buildBm25Index(documents: readonly Bm25Document[], options?: Bm25Options): Bm25Index {
  return new Bm25Index(documents, options);
}
