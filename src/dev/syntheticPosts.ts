// A synthetic reading list for measuring the reader at scale (HK4). Deterministic (a seeded generator), made of invented words, no real person's text.
// Used by the scale tests and by the development build's command "Reader: draw synthetic posts". The posts look like rows of the Studio's reading list
// after they are read (`ReadingPost`), and `syntheticRow` makes the wire form of the same post, so the row reader can be timed too.
import type { ReadingPost } from "../studio/reading";

/** A small fast seeded generator (mulberry32): the same seed always gives the same posts. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["garden", "signal", "paper", "river", "lantern", "window", "orbit", "ledger", "thread", "harbor", "maple", "circuit", "quiet", "market", "pattern", "ember", "atlas", "field", "bridge", "copper", "story", "answer", "season", "engine", "margin", "island", "voice", "cloud", "stone", "habit"];
const NAMES = ["Ada Example", "Ben Sample", "Chi Placeholder", "Dana Test", "Eli Invented"];

export interface SyntheticOptions {
  /** How many blygs the posts are spread over (default 200). */
  blygs?: number;
  /** Seed of the generator (default 1). */
  seed?: number;
  /** Newest post's time, epoch ms (default 2026-01-01T00:00:00Z: fixed, so a run is repeatable). */
  newest?: number;
}

/** What one post is made of, before it is shaped as a row or a `ReadingPost`. */
interface Spec {
  index: number;
  blyg: number;
  kind: "fragment" | "thread";
  reply: boolean;
  html: string;
  observedAt: string;
  author: string | null;
}

export function syntheticSpec(index: number, rand: () => number, o: Required<SyntheticOptions>): Spec {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const sentence = (): string => `${Array.from({ length: 5 + Math.floor(rand() * 12) }, () => pick(WORDS)).join(" ")}.`;
  const paragraph = (): string => `<p>${Array.from({ length: 1 + Math.floor(rand() * 4) }, sentence).join(" ")}</p>`;
  const roll = rand();
  const parts: string[] = [];
  if (roll < 0.12) parts.push(`<h2>${pick(WORDS)} ${pick(WORDS)}</h2>`);
  if (roll > 0.85) parts.push(`<blockquote><p>${sentence()}</p></blockquote><p><a href="https://example.test/p/${index}">example.test</a></p>`);
  const paragraphs = roll < 0.6 ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 8); // most are short, some are essays
  for (let i = 0; i < paragraphs; i++) parts.push(paragraph().replace(/(\w+) (\w+)\./, "<strong>$1</strong> <em>$2</em>."));
  if (rand() < 0.1) parts.push(`<p><img src="https://example.test/media/${index}.jpg" alt="${pick(WORDS)}"></p>`);
  const blyg = index % o.blygs;
  // Newest first: each post is a few minutes older than the one before.
  const observedAt = new Date(o.newest - index * 7 * 60_000 - Math.floor(rand() * 60_000)).toISOString();
  return { index, blyg, kind: rand() < 0.15 ? "thread" : "fragment", reply: rand() < 0.2, html: parts.join("\n"), observedAt, author: rand() < 0.7 ? pick(NAMES) : null };
}

const withDefaults = (o: SyntheticOptions): Required<SyntheticOptions> => ({ blygs: o.blygs ?? 200, seed: o.seed ?? 1, newest: o.newest ?? Date.UTC(2026, 0, 1) });

/** `n` posts, newest first, as the reader holds them. */
export function syntheticPosts(n: number, options: SyntheticOptions = {}): ReadingPost[] {
  const o = withDefaults(options);
  const rand = seeded(o.seed);
  const out: ReadingPost[] = [];
  for (let i = 0; i < n; i++) {
    const s = syntheticSpec(i, rand, o);
    out.push({
      subscriptionId: `sub${s.blyg}`,
      subscriptionTitle: `Blyg ${s.blyg}`,
      origin: `https://blyg-${s.blyg}.example.test/`,
      remoteId: `item${i}`,
      kind: s.kind,
      withdrawn: false,
      version: 1,
      readVersion: i % 3 === 0 ? null : 1,
      observedAt: s.observedAt,
      created: s.observedAt,
      isReply: s.reply,
      stubTarget: s.reply ? { origin: `https://blyg-${(s.blyg + 1) % o.blygs}.example.test/`, id: `item${i + 1}` } : null,
      contentHtml: s.html,
      contentMd: "",
      authorName: s.author,
      authorUrl: null,
      sourceUrl: `https://blyg-${s.blyg}.example.test/f/item${i}`,
    });
  }
  return out;
}

/** The same posts as rows of `GET /api/reading/imported` (the wire form), newest first. */
export function syntheticRows(n: number, options: SyntheticOptions = {}): Record<string, unknown>[] {
  return syntheticPosts(n, options).map((p) => ({
    subscriptionId: p.subscriptionId,
    subscriptionTitle: p.subscriptionTitle,
    origin: p.origin,
    remoteId: p.remoteId,
    kind: p.kind,
    withdrawn: false,
    version: p.version,
    readVersion: p.readVersion,
    observedAt: p.observedAt,
    created: p.created,
    contentHtml: p.contentHtml,
    contentMd: "",
    author: p.authorName ? { name: p.authorName, url: null } : null,
    sourceUrl: p.sourceUrl,
    stubOf: p.stubTarget ? { origin: p.stubTarget.origin, id: p.stubTarget.id, version: 1 } : null,
  }));
}
