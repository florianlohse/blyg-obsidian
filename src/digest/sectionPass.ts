// The sections pass of "Write the digest": which requests are made, how they are batched, and how the answers become sections. Pure apart from the transport.
//   First write of an edition (or no sections yet, or the person asks to re-sort): a FULL request with every story and as many single posts as fit; single
//     posts beyond the request size go in further requests that name the sections so far.
//   Later writes: only the NEW items are sent, with the EXISTING section names; each goes to an existing section, to Other, or (only if needed) a new one.
//     Items that already have a section are never sent and never move.
// Single posts are strangers' words: only the author and an excerpt go (sections.ts), delimited and named as data. Nothing here stores text: the caller keeps
// section NAMES and ids in the edition record.
import { redact } from "../platform/redact";
import { LlmError, mapFailure, usageOf, type DigestAiSettings, type LlmDeps, type LlmStore } from "./llm";
import {
  buildSectionsRequest, estimateSections, EST_CHARS_PER_STORY, MIN_STORIES_FOR_SECTIONS, OTHER_NAME, readPlacement, SECTIONS_ASSIGN_PROMPT, SECTIONS_SYSTEM_PROMPT, sectionsCacheKey, sectionsFit,
  singleBlock, storiesForSections, storyBlock, trimSectionsCache, type Section, type SectionSingle, type SectionStory,
} from "./sections";

/** A sections request is cut here so it stays reliable on a phone network (the stories always travel together; single posts fill the rest, then the next request). */
export const SECTIONS_MAX_REQUEST_CHARS = 40000;
/** A safety stop on the sections requests of one run; single posts beyond it stay in the Mixed bag. */
export const SECTIONS_MAX_REQUESTS = 12;
/** The room the existing section names take in a later request. */
const NAMES_OVERHEAD = 400;

/** What the edition record already says: the section names (in order), each story's section by position in the stories, and each single post's by id. */
export interface ExistingSections {
  names: string[];
  stories: Array<string | undefined>;
  posts: Record<string, string>;
  /** The bylines and single-post lines already kept (by section name, by post id). */
  about?: Record<string, string>;
  lines?: Record<string, string>;
}

export interface PassSpec {
  singles: readonly SectionSingle[];
  existing: ExistingSections | null;
  /** The person asked to sort everything again. */
  resort: boolean;
}

/** One request: the stories and single posts in it, as positions in the lists passed. */
export interface Step {
  mode: "full" | "assign";
  stories: number[];
  singles: number[];
}

const isFull = (spec: Pick<PassSpec, "existing" | "resort">): boolean => spec.resort || !spec.existing || spec.existing.names.length === 0;

/** The requests a run needs, from the sizes alone (so the estimate can be made before the headlines exist). */
export function planSteps(storyChars: readonly number[], singles: ReadonlyArray<{ id: string; chars: number }>, spec: Pick<PassSpec, "existing" | "resort">): Step[] {
  const steps: Step[] = [];
  const items: Array<{ story: boolean; i: number; chars: number }> = [];
  if (isFull(spec)) {
    const first: Step = { mode: "full", stories: storyChars.map((_, i) => i), singles: [] };
    let size = storyChars.reduce((a, b) => a + b, 0);
    let k = 0;
    while (k < singles.length && size + (singles[k]?.chars ?? 0) <= SECTIONS_MAX_REQUEST_CHARS) {
      size += singles[k]?.chars ?? 0;
      first.singles.push(k++);
    }
    steps.push(first);
    for (; k < singles.length; k++) items.push({ story: false, i: k, chars: singles[k]?.chars ?? 0 });
  } else {
    const ex = spec.existing as ExistingSections;
    storyChars.forEach((chars, i) => ex.stories[i] === undefined && items.push({ story: true, i, chars }));
    singles.forEach((p, i) => ex.posts[p.id] === undefined && items.push({ story: false, i, chars: p.chars }));
  }
  let cur: Step | null = null;
  let size = 0;
  for (const it of items) {
    if (!cur || (size + it.chars > SECTIONS_MAX_REQUEST_CHARS && cur.stories.length + cur.singles.length > 0)) {
      cur = { mode: "assign", stories: [], singles: [] };
      steps.push(cur);
      size = NAMES_OVERHEAD;
    }
    (it.story ? cur.stories : cur.singles).push(it.i);
    size += it.chars;
  }
  return steps.slice(0, SECTIONS_MAX_REQUESTS);
}

const stepsFor = (stories: ReadonlyArray<SectionStory | null>, spec: PassSpec): Step[] =>
  stories.length + spec.singles.length < MIN_STORIES_FOR_SECTIONS
    ? []
    : planSteps(stories.map((s) => (s ? storyBlock(s, 0).length : EST_CHARS_PER_STORY)), spec.singles.map((p) => ({ id: p.id, chars: singleBlock(p, 0).length })), spec);

interface Acc {
  order: string[];
  story: Map<number, string>;
  post: Map<string, string>;
  about: Map<string, string>;
  line: Map<string, string>;
}

function accOf(spec: PassSpec): Acc {
  const acc: Acc = { order: [], story: new Map(), post: new Map(), about: new Map(), line: new Map() };
  if (isFull(spec) || !spec.existing) return acc;
  acc.order = [...spec.existing.names];
  for (const [k, v] of Object.entries(spec.existing.about ?? {})) acc.about.set(k, v);
  for (const [k, v] of Object.entries(spec.existing.lines ?? {})) acc.line.set(k, v);
  spec.existing.stories.forEach((n, i) => n !== undefined && acc.story.set(i, n));
  for (const p of spec.singles) {
    const n = spec.existing.posts[p.id];
    if (n !== undefined) acc.post.set(p.id, n);
  }
  return acc;
}

/** The sections the accumulator holds: only items that were really placed (an unplaced story is drawn under Other by the page, an unplaced single post stays in the Mixed bag). */
function sectionsOf(acc: Acc, storyCount: number, singles: readonly SectionSingle[]): Section[] | null {
  const names = [...acc.order.filter((n) => n !== OTHER_NAME), ...acc.order.filter((n) => n === OTHER_NAME)];
  const out: Section[] = [];
  for (const name of names) {
    const ids: number[] = [];
    for (let i = 0; i < storyCount; i++) if (acc.story.get(i) === name) ids.push(i);
    const posts = singles.filter((p) => acc.post.get(p.id) === name).map((p) => p.id);
    const about = acc.about.get(name);
    const lines: Record<string, string> = {};
    for (const id of posts) {
      const l = acc.line.get(id);
      if (l) lines[id] = l;
    }
    if (ids.length + posts.length > 0) out.push({ name, ...(about ? { about } : {}), ids, ...(posts.length ? { posts } : {}), ...(Object.keys(lines).length ? { lines } : {}) });
  }
  return out.length > 0 ? out : null;
}

/** The cached arrangement for exactly these stories and single posts, or null. */
export function cachedPass(store: LlmStore, written: ReadonlyArray<SectionStory | null>, singles: readonly SectionSingle[], model: string): Section[] | null {
  const stories = storiesForSections(written, singles.length);
  const e = stories ? store.sections[sectionsCacheKey(stories, model, singles)] : undefined;
  return stories && e && sectionsFit(e.sections, stories.length, singles.map((p) => p.id)) ? e.sections : null;
}

/** Before anything is sent: does the run need sections requests, and what does the cache or the record already hold? */
export function sectionsPrecheck(store: LlmStore, written: ReadonlyArray<SectionStory | null>, spec: PassSpec, model: string): { need: boolean; cached: Section[] | null; steps: Step[] } {
  const steps = stepsFor(written, spec);
  if (steps.length > 0 && steps[0]?.mode === "assign") return { need: true, cached: null, steps };
  if (steps.length > 0) {
    const cached = spec.resort ? null : cachedPass(store, written, spec.singles, model);
    return { need: cached === null, cached, steps };
  }
  const kept = !isFull(spec) ? sectionsOf(accOf(spec), written.length, spec.singles) : null;
  return { need: false, cached: kept, steps };
}

export interface PassEstimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Single posts (author and excerpt) that go along. */
  singles: number;
}

export function estimatePass(steps: readonly Step[], written: ReadonlyArray<SectionStory | null>, singles: readonly SectionSingle[]): PassEstimate {
  const out: PassEstimate = { requests: steps.length, inputTokens: 0, outputTokens: 0, singles: 0 };
  for (const s of steps) {
    const chars =
      s.stories.reduce((n, i) => n + (written[i] ? storyBlock(written[i], 0).length : EST_CHARS_PER_STORY), 0) +
      s.singles.reduce((n, i) => n + (singles[i] ? singleBlock(singles[i], 0).length : 0), 0) +
      (s.mode === "assign" ? NAMES_OVERHEAD : 0);
    const e = estimateSections(s.stories.length + s.singles.length, chars, s.mode === "assign");
    out.inputTokens += e.inputTokens;
    out.outputTokens += e.outputTokens;
    out.singles += s.singles.length;
  }
  return out;
}

export interface PassResult {
  sections: Section[] | null;
  /** The request bodies exactly as sent. */
  bodies: string[];
  chars: number;
  tokens: number;
  /** Ids of the single posts that were sent (ids only). */
  sentSingles: string[];
  /** "" when all went well. */
  note: string;
}

/** Make the requests. Never throws. A failure keeps what was placed so far (a later run puts the rest); a failed FIRST full request leaves no sections. */
export async function runSectionPass(deps: Pick<LlmDeps, "transport" | "now">, settings: DigestAiSettings, key: string, store: LlmStore, model: string, stories: readonly SectionStory[], spec: PassSpec): Promise<PassResult> {
  const res: PassResult = { sections: null, bodies: [], chars: 0, tokens: 0, sentSingles: [], note: "" };
  const steps = stepsFor(stories, spec);
  const acc = accOf(spec);
  if (steps.length === 0) {
    res.sections = sectionsOf(acc, stories.length, spec.singles);
    return res;
  }
  const full = steps[0]?.mode === "full";
  const cacheKey = sectionsCacheKey(stories, model, spec.singles);
  if (full && !spec.resort) {
    const hit = cachedPass(store, stories, spec.singles, model);
    if (hit) return { ...res, sections: hit };
  }
  let done = 0;
  try {
    for (const step of steps) {
      const ss = step.stories.map((i) => stories[i] as SectionStory);
      const ps = step.singles.map((i) => spec.singles[i] as SectionSingle);
      const assign = step.mode === "assign";
      const req = buildSectionsRequest(ss, settings, key, ps, assign ? acc.order : undefined, assign ? Object.fromEntries(acc.about) : {});
      res.bodies.push(req.body);
      res.chars += req.chars;
      res.sentSingles.push(...ps.map((p) => p.id));
      let r;
      try {
        r = await deps.transport({ url: req.url, method: "POST", headers: req.headers, body: req.body, contentType: "application/json" });
      } catch {
        throw new LlmError("offline", "The provider could not be reached. Are you offline?");
      }
      if (r.status < 200 || r.status >= 300) throw mapFailure(r.status, r.headers, key);
      res.tokens += usageOf(r.text) ?? Math.ceil(((assign ? SECTIONS_ASSIGN_PROMPT : SECTIONS_SYSTEM_PROMPT).length + req.chars) / 4) + estimateSections(ss.length + ps.length).outputTokens;
      for (const p of readPlacement(r.text, ss.length, ps.length, assign ? acc.order : undefined, ps.map((x) => x.author))) {
        if (!acc.order.includes(p.name)) acc.order.push(p.name);
        if (p.about && !acc.about.has(p.name) && p.name !== OTHER_NAME) acc.about.set(p.name, p.about);
        for (const [i, line] of Object.entries(p.lines ?? {})) acc.line.set((spec.singles[step.singles[Number(i)] as number] as SectionSingle).id, line);
        for (const i of p.stories) acc.story.set(step.stories[i] as number, p.name);
        for (const i of p.singles) acc.post.set((spec.singles[step.singles[i] as number] as SectionSingle).id, p.name);
      }
      done++;
    }
  } catch (e) {
    const why = redact(e instanceof LlmError ? e.message : "the answer was not usable.", [key]);
    const keep = full && done === 0 ? null : sectionsOf(acc, stories.length, spec.singles);
    return { ...res, sections: keep, note: keep ? `Sections were only partly updated: ${why} The rest is shown under Other or in the Mixed bag.` : `Sections could not be made: ${why} Showing the front page.` };
  }
  res.sections = sectionsOf(acc, stories.length, spec.singles);
  if (full && res.sections) {
    store.sections[cacheKey] = { at: deps.now(), sections: res.sections };
    trimSectionsCache(store.sections);
  }
  return res;
}
