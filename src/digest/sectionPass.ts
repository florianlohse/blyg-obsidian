// The sections pass of "Write the digest": which requests are made, how they are batched, and how the answers become sections. Pure apart from the transport.
//   First write of an edition (or no sections yet, or the person asks to re-sort): a FULL request with every story and as many single posts as fit; single
//     posts beyond the request size go in further requests that name the sections so far.
//   Later writes: only the NEW items are sent, with the EXISTING section names; each goes to an existing section, to Other, or (only if needed) a new one.
//     Items that already have a section are never sent and never move.
// Single posts are strangers' words: only the author and an excerpt go (sections.ts), delimited and named as data. Nothing here stores text: the caller keeps
// section NAMES and ids in the edition record.
import { redact } from "../platform/redact";
import { buildFillRequest, FILL_MAX_REQUESTS, FILL_MAX_SINGLES, FILL_SYSTEM_PROMPT, readFill } from "./sectionFill";
import { CutOffError, LlmError, mapFailure, usageOf, type DigestAiSettings, type LlmDeps, type LlmStore } from "./llm";
import {
  buildSectionsRequest, estimateSections, EST_CHARS_PER_STORY, MIN_STORIES_FOR_SECTIONS, OTHER_NAME, readPlacement, SECTIONS_ASSIGN_PROMPT, SECTIONS_MAX_ITEMS, SECTIONS_MAX_SINGLES, SECTIONS_SYSTEM_PROMPT, sectionsCacheKey, sectionsFit,
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
  /** "fill": only the missing bylines (`names`) and single-post lines are asked for (an edition written before digest v2). */
  mode: "full" | "assign" | "fill";
  stories: number[];
  singles: number[];
  names?: string[];
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
    while (k < singles.length && first.singles.length < SECTIONS_MAX_SINGLES && size + (singles[k]?.chars ?? 0) <= SECTIONS_MAX_REQUEST_CHARS) {
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
    const n = cur ? cur.stories.length + cur.singles.length : 0;
    // A request is bounded by what comes BACK too: each single post needs an id and a line in the answer.
    if (!cur || ((size + it.chars > SECTIONS_MAX_REQUEST_CHARS || n >= SECTIONS_MAX_ITEMS || (!it.story && cur.singles.length >= SECTIONS_MAX_SINGLES)) && n > 0)) {
      cur = { mode: "assign", stories: [], singles: [] };
      steps.push(cur);
      size = NAMES_OVERHEAD;
    }
    (it.story ? cur.stories : cur.singles).push(it.i);
    size += it.chars;
  }
  if (!isFull(spec)) {
    const ex = spec.existing as ExistingSections;
    const names = ex.names.filter((n) => n !== OTHER_NAME && !ex.about?.[n]);
    const need = singles.map((p, i) => (ex.posts[p.id] !== undefined && !ex.lines?.[p.id] ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k === 0 ? names.length + need.length > 0 : k < need.length && k < FILL_MAX_REQUESTS * FILL_MAX_SINGLES; k += FILL_MAX_SINGLES) {
      steps.push({ mode: "fill", stories: [], singles: need.slice(k, k + FILL_MAX_SINGLES), ...(k === 0 && names.length ? { names } : {}) });
      if (need.length === 0) break;
    }
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
  if (steps.length > 0 && steps[0]?.mode !== "full") return { need: true, cached: null, steps };
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
      (s.mode === "assign" ? NAMES_OVERHEAD : 0) + (s.names?.length ?? 0) * 400;
    const e = estimateSections(s.stories.length + s.singles.length + (s.names?.length ?? 0), chars, s.mode === "assign");
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

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A failed step in halves (singles first, then stories; a full request keeps its stories together), or null when it cannot be made smaller. */
function halves(st: Step): [Step, Step] | null {
  if (st.mode === "fill") {
    if (st.singles.length < 2) return null;
    const h = Math.ceil(st.singles.length / 2);
    return [{ ...st, singles: st.singles.slice(0, h) }, { mode: "fill", stories: [], singles: st.singles.slice(h) }];
  }
  if (st.mode === "full") {
    if (st.singles.length < 2) return null;
    const h = Math.ceil(st.singles.length / 2);
    return [{ ...st, singles: st.singles.slice(0, h) }, { mode: "assign", stories: [], singles: st.singles.slice(h) }];
  }
  const items = [...st.stories.map((i) => ({ story: true, i })), ...st.singles.map((i) => ({ story: false, i }))];
  if (items.length < 2) return null;
  const h = Math.ceil(items.length / 2);
  const of = (xs: typeof items): Step => ({ mode: "assign", stories: xs.filter((x) => x.story).map((x) => x.i), singles: xs.filter((x) => !x.story).map((x) => x.i) });
  return [of(items.slice(0, h)), of(items.slice(h))];
}

/**
 * Make the requests. Never throws. Network, key and limit problems stop the run; an answer that is cut off or unreadable is tried ONCE more in half-size batches, and a
 * batch that still fails is skipped (its items land under Other or in the Mixed bag) while the batches that worked are kept. A failed FIRST full request leaves no new
 * sections: a re-sort keeps the old placement, a first write shows the front page. The note says what was tried.
 */
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
  const oldPlacement = (): Section[] | null => (spec.resort && spec.existing ? sectionsOf(accOf({ ...spec, resort: false }), stories.length, spec.singles) : null);
  let requests = 0;
  let cut = 0;
  let retried = 0;
  let failed = 0;
  let firstBad: LlmError | null = null;
  const post = async (req: { url: string; headers: Record<string, string>; body: string; chars: number }, system: string, outTokens: number): Promise<string> => {
    res.bodies.push(req.body);
    res.chars += req.chars;
    requests++;
    let r;
    try {
      r = await deps.transport({ url: req.url, method: "POST", headers: req.headers, body: req.body, contentType: "application/json" });
    } catch {
      throw new LlmError("offline", "The provider could not be reached. Are you offline?");
    }
    if (r.status < 200 || r.status >= 300) throw mapFailure(r.status, r.headers, key);
    res.tokens += usageOf(r.text) ?? Math.ceil((system.length + req.chars) / 4) + outTokens;
    return r.text;
  };
  const send = async (step: Step): Promise<void> => {
    const ss = step.stories.map((i) => stories[i] as SectionStory);
    const ps = step.singles.map((i) => spec.singles[i] as SectionSingle);
    res.sentSingles.push(...ps.map((p) => p.id));
    if (step.mode === "fill") {
      const names = step.names ?? [];
      const sec = names.map((name) => ({ name, headlines: stories.filter((_, i) => acc.story.get(i) === name).map((s) => s.headline) }));
      const req = buildFillRequest(settings, key, sec, ps);
      const text = await post(req, FILL_SYSTEM_PROMPT, estimateSections(ps.length + names.length).outputTokens);
      const got = readFill(text, names, ps.map((x) => x.author));
      for (const [n, a] of got.about) if (!acc.about.has(n)) acc.about.set(n, a);
      for (const [i, l] of got.lines) if (!acc.line.has((ps[i] as SectionSingle).id)) acc.line.set((ps[i] as SectionSingle).id, l);
      return;
    }
    const assign = step.mode === "assign";
    const req = buildSectionsRequest(ss, settings, key, ps, assign ? acc.order : undefined, assign ? Object.fromEntries(acc.about) : {});
    const text = await post(req, assign ? SECTIONS_ASSIGN_PROMPT : SECTIONS_SYSTEM_PROMPT, estimateSections(ss.length + ps.length).outputTokens);
    for (const p of readPlacement(text, ss.length, ps.length, assign ? acc.order : undefined, ps.map((x) => x.author))) {
      if (!acc.order.includes(p.name)) acc.order.push(p.name);
      if (p.about && !acc.about.has(p.name) && p.name !== OTHER_NAME) acc.about.set(p.name, p.about);
      for (const [i, line] of Object.entries(p.lines ?? {})) acc.line.set((spec.singles[step.singles[Number(i)] as number] as SectionSingle).id, line);
      for (const i of p.stories) acc.story.set(step.stories[i] as number, p.name);
      for (const i of p.singles) acc.post.set((spec.singles[step.singles[i] as number] as SectionSingle).id, p.name);
    }
  };
  // Returns false when the batch could not be made (after one retry in halves).
  const attempt = async (step: Step, retry: boolean): Promise<boolean> => {
    try {
      await send(step);
      return true;
    } catch (e) {
      if (!(e instanceof LlmError) || e.kind !== "bad") throw e;
      firstBad ??= e;
      if (e instanceof CutOffError) cut++;
      const h = retry ? halves(step) : null;
      if (!h) return false;
      retried++;
      const a = await attempt(h[0], false);
      return (await attempt(h[1], false)) && a; // both halves are tried: the half that works is kept
    }
  };
  const total = steps.length;
  let ok = 0;
  let stopped: LlmError | null = null;
  try {
    for (const [n, step] of steps.entries()) {
      if (await attempt(step, true)) ok++;
      else {
        failed++;
        if (n === 0 && step.mode === "full") break; // nothing to name later batches after
      }
    }
  } catch (e) {
    stopped = e instanceof LlmError ? e : new LlmError("bad", "the answer was not usable.");
  }
  const bad = firstBad as LlmError | null;
  const reason = stopped ? stopped.message : bad instanceof CutOffError ? "The answer was cut off again, even in smaller batches." : bad ? bad.message : "";
  const why = redact(reason, [key]);
  const tried = `Tried ${plural(requests, "request")}${retried ? `, ${retried === 1 ? "one" : retried} retried in smaller batches` : ""}.`;
  res.sections = sectionsOf(acc, stories.length, spec.singles);
  const lostFirst = full && !acc.order.length;
  if (stopped || failed > 0) {
    const keep = lostFirst ? oldPlacement() : res.sections;
    res.sections = keep;
    res.note = lostFirst
      ? `Sections could not be ${spec.resort ? "re-sorted" : "made"}: ${why} ${tried} ${keep ? "Keeping the sections as they were." : "Showing the front page."}`
      : `Sections were only partly ${full ? "made" : "updated"} (${ok} of ${total} ${total === 1 ? "batch" : "batches"} worked): ${why} ${tried} The rest is shown under Other or in the Mixed bag.`;
    return res;
  }
  if (cut > 0) res.note = "The answer was cut off; sorted in smaller batches.";
  if (full && res.sections && cut === 0) {
    store.sections[cacheKey] = { at: deps.now(), sections: res.sections };
    trimSectionsCache(store.sections);
  }
  return res;
}
