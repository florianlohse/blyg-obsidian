// The sections pass on a big edition (about 120 single posts, 15 stories): batches bounded by the expected ANSWER size too, an answer cut off at max_tokens (retried
// once in halves, partly kept), fences and prose around the JSON, a re-sort that fails keeps the old placement, and the backfill of bylines and lines for an edition
// written before digest v2. Fake transport; invented names only.
import { describe, expect, it } from "vitest";
import { emptyStore } from "../../src/digest/llm";
import { planSteps, runSectionPass, SECTIONS_MAX_REQUESTS, type ExistingSections, type PassSpec } from "../../src/digest/sectionPass";
import { readPlacement, SECTIONS_MAX_ITEMS, SECTIONS_MAX_SINGLES, SECTIONS_MAX_TOKENS, type SectionSingle, type SectionStory } from "../../src/digest/sections";
import type { RawRequest, RawResponse } from "../../src/platform/http";

const KEY = "sk-test-0123456789abcdefghijklmnop";
const settings = { endpoint: "https://api.example.com/", model: "claude-sonnet-5-5" };
const stories: SectionStory[] = Array.from({ length: 15 }, (_, i) => ({ headline: `Harbour headline ${i}`, summary: `Summary of story ${i}.` }));
const singles = (n: number): SectionSingle[] => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, author: `Ann${i}`, excerpt: `Excerpt number ${i} about tea.` }));
const NAMES = ["Alpha", "Beta", "Gamma"];

const contentOf = (r: RawRequest): string => (JSON.parse(r.body ?? "") as { messages: Array<{ content: string }> }).messages[0]?.content ?? "";
const bodyOf = (r: RawRequest): { max_tokens: number; system: string } => JSON.parse(r.body ?? "") as { max_tokens: number; system: string };
const isFill = (r: RawRequest): boolean => bodyOf(r).system.startsWith("You add missing short texts");
const ids = (c: string, tag: string): number[] => [...c.matchAll(new RegExp(`<${tag} id="(\\d+)"`, "g"))].map((m) => Number(m[1]));
const reply = (text: string, stop = "end_turn"): RawResponse => ({ status: 200, headers: {}, text: JSON.stringify({ stop_reason: stop, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } }) });

/** A valid answer for any sections request: three sections (or the known ones), a line for every single post. */
function good(r: RawRequest, wrapText: (j: string) => string = (j) => j): RawResponse {
  const c = contentOf(r);
  const known = [...c.matchAll(/<section(?: about="[^"]*")?>([^<]*)<\/section>/g)].map((m) => m[1] as string);
  const names = known.length ? known : NAMES;
  const authors = new Map([...c.matchAll(/<post id="(\d+)" author="([^"]*)"/g)].map((m) => [Number(m[1]), m[2]]));
  const p = ids(c, "post");
  const s = ids(c, "story");
  const sections = names.map((name, k) => ({ name, ...(known.length ? {} : { about: `About ${name}` }), stories: s.filter((i) => i % names.length === k), posts: p.filter((i) => i % names.length === k).map((id) => ({ id, line: `${authors.get(id)} on tea and more` })) }));
  return reply(wrapText(JSON.stringify({ sections })));
}
const cutText = (r: RawRequest): RawResponse => {
  const full = (JSON.parse(good(r).text) as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  return reply(full.slice(0, Math.floor(full.length * 0.6)), "max_tokens"); // ends in the middle of an object
};

function run(answer: (r: RawRequest, n: number) => RawResponse, spec: Partial<PassSpec> & { n?: number } = {}, store = emptyStore()) {
  const sent: RawRequest[] = [];
  const s = singles(spec.n ?? 120);
  const deps = { now: () => 1, transport: async (r: RawRequest) => answer(r, sent.push(r)) };
  const pass = runSectionPass(deps, settings, KEY, store, "m", stories, { singles: s, existing: spec.existing ?? null, resort: spec.resort ?? false });
  return pass.then((res) => ({ res, sent, store, singles: s }));
}
const placed = (sections: ReadonlyArray<{ posts?: string[] }> | null): number => (sections ?? []).reduce((n, s) => n + (s.posts?.length ?? 0), 0);

describe("batches are bounded by the expected answer, not only the input", () => {
  it("120 single posts and 15 stories: at most 40 singles and 50 items per request, all covered, later requests name the sections", async () => {
    const steps = planSteps(stories.map(() => 300), singles(120).map((p) => ({ id: p.id, chars: 120 })), { existing: null, resort: false });
    expect(steps.length).toBeLessThanOrEqual(SECTIONS_MAX_REQUESTS);
    expect(steps[0]?.mode).toBe("full");
    expect(steps[0]?.stories).toHaveLength(15);
    for (const st of steps) {
      expect(st.singles.length).toBeLessThanOrEqual(SECTIONS_MAX_SINGLES);
      if (st.mode === "assign") expect(st.stories.length + st.singles.length).toBeLessThanOrEqual(SECTIONS_MAX_ITEMS);
    }
    expect(steps.slice(1).every((st) => st.mode === "assign")).toBe(true);
    expect(steps.flatMap((st) => st.singles).sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, i) => i));
  });
  it("sends three requests with the larger token budget and places every post with its line", async () => {
    const { res, sent } = await run((r) => good(r));
    expect(sent).toHaveLength(3);
    expect(sent.every((r) => bodyOf(r).max_tokens === SECTIONS_MAX_TOKENS && SECTIONS_MAX_TOKENS >= 8192)).toBe(true);
    expect(placed(res.sections)).toBe(120);
    expect(res.sections?.flatMap((s) => Object.keys(s.lines ?? {}))).toHaveLength(120);
    expect(res.sections?.every((s) => s.about)).toBe(true);
    expect(res.note).toBe("");
  });
});

describe("an answer cut off at max_tokens", () => {
  it("is what the old reading could not parse (the device's note), and is now named as cut off", () => {
    const text = cutText({ body: JSON.stringify({ messages: [{ content: '<post id="1" author="Ann">x</post><post id="2" author="Bo">y</post><post id="3" author="Cy">z</post>' }] }) } as RawRequest).text;
    expect(() => readPlacement(text, 0, 3)).toThrow(/cut off/);
    // the same text without a stop_reason of max_tokens is just unreadable
    const plain = JSON.stringify({ content: [{ type: "text", text: '{"sections":[{"name":"A","posts":[1,' }] });
    expect(() => readPlacement(plain, 0, 3)).toThrow(/shape this plugin cannot read/);
  });
  it("is retried ONCE in half-size batches and says so", async () => {
    let cuts = 0;
    const { res, sent } = await run((r) => (cuts++ === 0 ? cutText(r) : good(r)));
    expect(res.note).toBe("The answer was cut off; sorted in smaller batches.");
    expect(sent.length).toBe(1 + 2 + 2); // cut, its two halves, then the other two batches
    expect(placed(res.sections)).toBe(120);
  });
  it("one batch of several that still fails: the batches that worked are kept, the rest waits in the Mixed bag, with a plain note", async () => {
    const { res, sent, singles: s } = await run((r) => (contentOf(r).includes('author="Ann50"') ? cutText(r) : good(r))); // the second batch holds 40..79 (and every retry half of it that holds Ann50)
    expect(res.sections).not.toBeNull();
    expect(res.note).toMatch(/only partly made \(\d of 3 batches worked\)/);
    expect(res.note).toMatch(/cut off again/);
    expect(res.note).toMatch(/Tried \d+ requests?, one retried in smaller batches/);
    expect(res.note).not.toContain(KEY);
    const got = new Set((res.sections ?? []).flatMap((x) => x.posts ?? []));
    expect(got.has(s[0]?.id as string)).toBe(true); // the first batch worked
    expect(got.has(s[119]?.id as string)).toBe(true); // the third batch worked
    expect(got.has(s[50]?.id as string)).toBe(false); // the failed half stays unplaced
    expect(got.has(s[70]?.id as string)).toBe(true); // the half that worked is kept
    expect(placed(res.sections)).toBe(100);
    for (const r of sent) expect(r.body).not.toContain(KEY.slice(3)); // the key is only in the header
  });
  it("a first full request that cannot be read leaves the front page, and says what was tried", async () => {
    const { res } = await run(() => reply("I am sorry, I cannot do that."));
    expect(res.sections).toBeNull();
    expect(res.note).toMatch(/^Sections could not be made: .*shape this plugin cannot read\. Tried \d+ requests?.*Showing the front page\.$/);
  });
  it("a failed re-sort keeps the sections as they were (never a silent no-op)", async () => {
    const ex: ExistingSections = { names: ["Old"], stories: stories.map(() => "Old"), posts: Object.fromEntries(singles(10).map((p) => [p.id, "Old"])), about: { Old: "The old line" }, lines: {} };
    const { res } = await run(() => cutText({ body: JSON.stringify({ messages: [{ content: "" }] }) } as RawRequest), { n: 10, existing: ex, resort: true });
    expect(res.sections?.map((s) => s.name)).toEqual(["Old"]);
    expect(res.sections?.[0]?.ids).toHaveLength(15);
    expect(res.note).toMatch(/could not be re-sorted.*Keeping the sections as they were\./);
  });
});

describe("the answer wrapped in fences or prose", () => {
  it.each([
    ["markdown fences", (j: string) => "```json\n" + j + "\n```"],
    ["prose before and after", (j: string) => `Here are the sections {as asked}:\n${j}\nI hope this helps.`],
  ])("is read: %s", async (_n, wrapper) => {
    const { res, sent } = await run((r) => good(r, wrapper), { n: 12 });
    expect(sent).toHaveLength(1);
    expect(placed(res.sections)).toBe(12);
    expect(res.note).toBe("");
  });
});

describe("backfill for an edition written before digest v2", () => {
  const ex = (n: number, extra: Partial<ExistingSections> = {}): ExistingSections => ({ names: NAMES, stories: stories.map((_, i) => NAMES[i % 3]), posts: Object.fromEntries(singles(n).map((p, i) => [p.id, NAMES[i % 3] as string])), ...extra });
  it("sends only the missing items and keeps the cached result valid", async () => {
    const s = singles(6);
    const existing = ex(6, { about: { Alpha: "Already has one" }, lines: { [s[0]?.id as string]: "Ann0 on tea" } });
    const { res, sent } = await run((r) => (isFill(r) ? fillOf(r) : good(r)), { n: 6, existing });
    expect(sent).toHaveLength(1);
    const c = contentOf(sent[0] as RawRequest);
    expect(isFill(sent[0] as RawRequest)).toBe(true);
    expect(c).toContain("<name>Beta</name>");
    expect(c).toContain("<name>Gamma</name>");
    expect(c).not.toContain("<name>Alpha</name>"); // it has a byline already
    expect(ids(c, "post")).toEqual([1, 2, 3, 4, 5]); // singles 1..5 (positions among the sent ones); the post with a line is not sent
    expect(c).not.toContain("Ann0");
    expect(c).not.toContain("Excerpt number 0");
    expect(res.sections?.find((x) => x.name === "Beta")?.about).toBe("About Beta here");
    expect(res.sections?.find((x) => x.name === "Alpha")?.about).toBe("Already has one");
    expect(res.sections?.flatMap((x) => Object.keys(x.lines ?? {}))).toHaveLength(6);
    expect(res.sections?.find((x) => x.posts?.includes(s[0]?.id as string))?.lines?.[s[0]?.id as string]).toBe("Ann0 on tea"); // untouched
    expect(placed(res.sections)).toBe(6);
    expect(sent[0]?.body).not.toContain(KEY.slice(3));
  });
  it("nothing missing: nothing is sent; Other needs no byline", async () => {
    const s = singles(5);
    const existing = ex(5, { names: [...NAMES, "Other"], about: { Alpha: "a", Beta: "b", Gamma: "c" }, lines: Object.fromEntries(s.map((p) => [p.id, `${p.author} on tea`])) });
    const { sent } = await run(() => good({ body: "{}" } as RawRequest), { n: 5, existing });
    expect(sent).toHaveLength(0);
  });
  it("a lying answer is dropped: a section that was not sent, a line for another author", async () => {
    const existing = ex(5);
    const answer = reply(JSON.stringify({ about: [{ name: "Invented", about: "x" }, { name: "Alpha", about: "A fine byline for Alpha" }], lines: [{ id: 1, line: "Somebody Else on tea" }, { id: 2, line: "Ann1 on tea" }, { id: 99, line: "Ann1 on tea" }] }));
    const { res } = await run(() => answer, { n: 5, existing });
    expect(res.sections?.find((x) => x.name === "Alpha")?.about).toBe("A fine byline for Alpha");
    expect(res.sections?.flatMap((x) => Object.values(x.lines ?? {}))).toEqual(["Ann1 on tea"]);
    expect(res.sections?.some((x) => x.name === "Invented")).toBe(false);
  });
  it("a failed backfill keeps the sections as they are, with a note", async () => {
    const { res } = await run(() => reply("no json here"), { n: 5, existing: ex(5) });
    expect(placed(res.sections)).toBe(5);
    expect(res.note).toMatch(/only partly updated/);
  });
});

function fillOf(r: RawRequest): RawResponse {
  const c = contentOf(r);
  return reply(JSON.stringify({
    about: [...c.matchAll(/<name>([^<]*)<\/name>/g)].map((m) => ({ name: m[1], about: `About ${m[1]} here` })),
    lines: [...c.matchAll(/<post id="(\d+)" author="([^"]*)"/g)].map((m) => ({ id: Number(m[1]), line: `${m[2]} on tea` })),
  }));
}
