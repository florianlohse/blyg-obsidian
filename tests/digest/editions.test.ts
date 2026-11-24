// Editions: the clock (cutoffs, DST, a changed Digest time), stable stories within an edition, "updated" marks, and the AI texts that follow them.
process.env.TZ = "Europe/Berlin";
import { describe, expect, it } from "vitest";
import { EDITION_MS, EDITIONS_KEPT, ensureEdition, emptyEditions, latestCutoff, nextCutoff, parseDigestTime, parseEditions, type EditionStore } from "../../src/digest/edition";
import { storyIdFor } from "../../src/digest/sync/state";
import { Editions, cachedStories, recordSections, rememberWrite } from "../../src/digest/editionHost";
import { emptyStore, writeDigest, type LlmDeps, type LlmStore } from "../../src/digest/llm";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import type { ReadingPost } from "../../src/studio/reading";

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();

describe("the clock", () => {
  it("runs on Europe/Berlin here", () => expect(new Date(at(2030, 3, 12, 12)).getTimezoneOffset()).toBe(-60));
  it("reads and mends the setting", () => {
    expect(parseDigestTime("7:05")).toBe("07:05");
    expect(parseDigestTime("24:00")).toBe("07:00");
    expect(parseDigestTime(undefined)).toBe("07:00");
  });
  it("makes an edition at the first open after the cutoff, and keeps it until the next cutoff", () => {
    const early = ensureEdition(emptyEditions(), at(2030, 3, 12, 6), "07:00"); // before today's cutoff: yesterday's
    expect(early.edition.id).toBe(at(2030, 3, 11, 7));
    const first = ensureEdition(emptyEditions(), at(2030, 3, 12, 7, 5), "07:00");
    expect(first.edition.id).toBe(at(2030, 3, 12, 7));
    expect(first.created).toBe(true);
    const later = ensureEdition(first.store, at(2030, 3, 13, 6, 59), "07:00");
    expect(later.created).toBe(false);
    expect(later.edition.id).toBe(first.edition.id);
    const next = ensureEdition(first.store, at(2030, 3, 13, 7), "07:00");
    expect(next.created).toBe(true);
    expect(next.edition.id).toBe(at(2030, 3, 13, 7));
    expect(next.store.editions).toHaveLength(2);
  });
  it("not opened until 14:00: the edition is made then, with the cutoff's id and a window that starts 24 hours before the cutoff", async () => {
    let now = at(2030, 3, 12, 14);
    const ed = new Editions({ read: async () => null, write: async () => undefined, now: () => now, time: () => "07:00" });
    const info = await ed.open([]);
    expect(info.id).toBe(at(2030, 3, 12, 7));
    expect(info.since).toBe(at(2030, 3, 12, 7) - EDITION_MS);
    expect(info.until).toBe(now);
    now = at(2030, 3, 12, 20);
    expect((await ed.open([])).until).toBe(now); // it grows
  });
  it("is made after days away with the latest cutoff", () => {
    const first = ensureEdition(emptyEditions(), at(2030, 3, 12, 8), "07:00");
    const r = ensureEdition(first.store, at(2030, 3, 16, 9), "07:00");
    expect(r.edition.id).toBe(at(2030, 3, 16, 7));
  });
  it("follows the device's clock over the autumn change (a 25-hour day) and the spring change", () => {
    const a = ensureEdition(emptyEditions(), at(2030, 10, 26, 8), "07:00");
    const cut = nextCutoff(a.edition, "07:00");
    expect(cut).toBe(at(2030, 10, 27, 7));
    expect(ensureEdition(a.store, cut - 1000, "07:00").created).toBe(false);
    const b = ensureEdition(a.store, cut + 1000, "07:00");
    expect(b.edition.id).toBe(cut);
    expect(nextCutoff(b.edition, "07:00")).toBe(at(2030, 10, 28, 7));
    expect(cut - a.edition.id).toBe(EDITION_MS + 3600_000); // the day with 25 hours
    expect(nextCutoff(b.edition, "07:00") - b.edition.id).toBe(EDITION_MS);
    expect(b.edition.id - EDITION_MS).toBe(cut - 24 * 3600_000); // the window is exactly 24 hours
    const s = ensureEdition(emptyEditions(), at(2030, 3, 30, 3), "02:30");
    expect(new Date(nextCutoff(s.edition, "02:30")).getHours()).toBe(3); // 02:30 does not exist on 31 March: the device's own rule gives 03:30
    expect(latestCutoff(at(2030, 3, 31, 12), "02:30")).toBe(at(2030, 3, 31, 2, 30));
  });
  it("changing the Digest time moves only the next cutoff: no second edition that day, no edition rewritten", () => {
    const a = ensureEdition(emptyEditions(), at(2030, 3, 12, 7, 5), "07:00");
    const frozen = structuredClone(a.store);
    const same = ensureEdition(a.store, at(2030, 3, 12, 21), "20:00"); // moved to 20:00: today's 20:00 has passed, but it is the same day
    expect(same.created).toBe(false);
    expect(nextCutoff(a.edition, "20:00")).toBe(at(2030, 3, 13, 20));
    expect(ensureEdition(a.store, at(2030, 3, 13, 19, 59), "20:00").created).toBe(false);
    const n = ensureEdition(a.store, at(2030, 3, 13, 20, 1), "20:00");
    expect(n.edition.id).toBe(at(2030, 3, 13, 20));
    expect(a.store).toEqual(frozen);
    expect(n.store.editions[0]).toEqual(frozen.editions[0]); // the old edition is as it was
    expect(nextCutoff(a.edition, "06:00")).toBe(at(2030, 3, 13, 6)); // earlier in the day: the next occurrence after the edition was made
  });
  it("keeps the last 14 editions", () => {
    let store: EditionStore = emptyEditions();
    for (let d = 1; d <= 20; d++) store = ensureEdition(store, at(2030, 3, d, 9), "07:00").store;
    expect(store.editions).toHaveLength(EDITIONS_KEPT);
    expect(store.editions[0]?.id).toBe(at(2030, 3, 7, 7));
    const long = { v: 1, editions: Array.from({ length: 20 }, (_, i) => ({ id: i, createdAt: i, n: 1, stories: [], mixed: [], seen: {} })) };
    expect(parseEditions(long).editions.map((e) => e.id)).toEqual(Array.from({ length: EDITIONS_KEPT }, (_, i) => i + 6));
    expect(parseEditions({ editions: [{ id: "x" }, null, 3] }).editions).toEqual([]);
  });
});

// ---- stable stories ----
const T0 = at(2030, 3, 12, 7, 5);
let counter = 0;
const nid = (): string => `p${String(++counter).padStart(25, "0")}`;
const quote = (qid: string): string => `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${qid}" data-blyg-version="1"><p>Quoted.</p></blockquote>`;
function post(over: Partial<ReadingPost> & { text?: string; html?: string; at?: number } = {}): ReadingPost {
  const { text, html, at: when, ...rest } = over;
  return {
    subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: nid(), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
    observedAt: new Date(when ?? T0 + 600_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: html ?? `<p>${text ?? "Some words."}</p>`, contentMd: "", authorName: "Ann", authorUrl: null, sourceUrl: null, ...rest,
  };
}
const TOPICS = ["harbour lantern tide", "orchard cider press", "glacier survey drone", "market ledger tariff", "stadium league referee", "parliament budget vote"];
const QUOTED = "q".repeat(26);
function world() {
  const items: ReadingPost[] = [];
  const leads: ReadingPost[] = [];
  TOPICS.forEach((t, k) => {
    const a = post({ text: `Secret${k} notes about ${t} and the long walk home today.`, ...(k === 2 ? { html: `<p>Secret2 notes about ${t} and the long walk home today.</p>${quote(QUOTED)}` } : {}) });
    const b = post({ text: `Reply ${k}: yes.`, isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId }, authorName: "Bo" });
    leads.push(a);
    items.push(a, b);
  });
  const lone = post({ text: "A lone remark about nothing in particular whatsoever." });
  items.push(lone);
  return { items, leads, lone };
}
function store() {
  let text: string | null = null;
  let now = T0 + 3600_000;
  const ed = new Editions({ read: async () => (text ? (JSON.parse(text) as unknown) : null), write: async (t) => void (text = t), now: () => now, time: () => "07:00" });
  return { ed, raw: () => text, setNow: (t: number) => (now = t) };
}
// A story's id comes from its oldest post (DG16: the same on every device); in these worlds the lead post is the oldest of its story.
const sid = (p: ReadingPost): string => storyIdFor(p.remoteId);
const idsOf = (g: { clusters: Array<{ id?: string; posts: ReadingPost[] }> }): Record<string, string[]> => Object.fromEntries(g.clusters.map((c) => [c.id as string, c.posts.map((p) => p.remoteId)]));

describe("stable stories", () => {
  it("groups the first time as before, and keeps the stories' ids and members", async () => {
    const w = world();
    const s = store();
    const first = await s.ed.open(w.items);
    expect(first.grouped.clusters.map((c) => c.id)).toEqual(w.leads.map(sid));
    expect(first.grouped.mixed.map((p) => p.remoteId)).toEqual([w.lone.remoteId]);
    const again = await s.ed.open(w.items);
    expect(idsOf(again.grouped)).toEqual(idsOf(first.grouped));
  });
  it("puts a new post in the story it answers, quotes the same item as, or resembles; never starts a story alone", async () => {
    const w = world();
    const s = store();
    const first = await s.ed.open(w.items);
    const before = idsOf(first.grouped);
    const reply = post({ text: "Another answer entirely.", isReply: true, stubTarget: { origin: "https://one.example.com/", id: w.leads[0]!.remoteId }, authorName: "Cy" });
    const sameQuote = post({ text: "Unrelated chatter.", html: `<p>Unrelated chatter.</p>${quote(QUOTED)}` });
    const alike = post({ text: `Secret3 notes about ${TOPICS[3]} and the long walk home today, again.` });
    const loner = post({ text: "Completely different subject: zebras, kilns, and sailing manuals." });
    const info = await s.ed.open([...w.items, reply, sameQuote, alike, loner]);
    const now = idsOf(info.grouped);
    expect(Object.keys(now).sort()).toEqual(Object.keys(before).sort()); // no new top-level story (the same set; the order is the page's order now, not the record's)
    const [s1, s2, s3, s4, s5, s6] = w.leads.map(sid) as [string, string, string, string, string, string];
    expect(now[s1]).toContain(reply.remoteId); // by reply
    expect(now[s3]).toContain(sameQuote.remoteId); // by the same quoted item
    expect(now[s4]).toContain(alike.remoteId); // by similarity
    expect(Object.values(now).flat()).not.toContain(loner.remoteId);
    expect(info.grouped.mixed.map((p) => p.remoteId)).toContain(loner.remoteId); // no match: Mixed bag
    for (const k of [s2, s5, s6]) expect(now[k]).toEqual(before[k]);
    expect(now[s1]?.slice(0, 2)).toEqual(before[s1]); // the old members keep their places
  });
  it("lets two new posts that match each other (and no story) form a story", async () => {
    const w = world();
    const s = store();
    await s.ed.open(w.items);
    const a = post({ text: "Kiln glaze recipe: iron, ash and patience for the autumn firing." });
    const b = post({ text: "Replying about the kiln.", isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId }, authorName: "Bo" });
    const info = await s.ed.open([...w.items, a, b]);
    expect(info.grouped.clusters).toHaveLength(7);
    expect(idsOf(info.grouped)[sid(a)]).toEqual([a.remoteId, b.remoteId]);
    expect(info.grouped.clusters.slice(0, 6).map((c) => c.id)).toEqual(w.leads.map(sid));
  });
  it("keeps only ids in its record, and the next edition is the 24 hours before its own cutoff, with posts added late appearing again", async () => {
    const w = world();
    const s = store();
    const late = post({ text: "Late arrival about the orchard cider press and a lantern.", at: T0 + 20 * 3600_000 }); // 03:05 next morning: before the next cutoff, after the first edition's cutoff
    await s.ed.open([...w.items, late]);
    expect(s.raw()).not.toMatch(/Secret0|long walk|Late arrival/); // no post bodies
    expect((JSON.parse(s.raw() ?? "{}") as { editions: unknown[] }).editions).toHaveLength(1);
    s.setNow(at(2030, 3, 13, 9));
    const next = await s.ed.open([...w.items, late]);
    expect(next.id).toBe(at(2030, 3, 13, 7));
    expect(next.since).toBe(at(2030, 3, 12, 7));
    expect(Object.values(idsOf(next.grouped)).flat().concat(next.grouped.mixed.map((p) => p.remoteId))).toContain(late.remoteId);
    expect((JSON.parse(s.raw() ?? "{}") as { editions: unknown[] }).editions).toHaveLength(2);
  });
});

// ---- the AI texts ----
const KEY = "sk-test-0123456789abcdefghijklmnop";
const wrap = (text: string): RawResponse => ({ status: 200, headers: {}, text: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } }) });
function aiHarness() {
  const sent: RawRequest[] = [];
  let st: LlmStore = emptyStore();
  let tag = "Headline";
  const deps: LlmDeps = {
    settings: () => ({ endpoint: "https://api.example.com/", model: "test-model" }),
    transport: async (r) => {
      sent.push(r);
      const content = (JSON.parse(r.body ?? "") as { messages: Array<{ content: string }> }).messages[0]?.content ?? "";
      if (content.includes("<story id=")) {
        const ids = [...content.matchAll(/<story id="(\d+)">/g)].map((m) => Number(m[1]));
        return wrap(JSON.stringify({ sections: [{ name: "One", stories: ids.filter((i) => i % 3 === 0) }, { name: "Two", stories: ids.filter((i) => i % 3 === 1) }, { name: "Three", stories: ids.filter((i) => i % 3 === 2) }] }));
      }
      const ids = [...content.matchAll(/<cluster id="(\d+)">/g)].map((m) => Number(m[1]));
      return wrap(JSON.stringify({ clusters: ids.map((id) => ({ id, headline: `${tag} ${id}`, summary: `Summary ${id}.` })) }));
    },
    getKey: () => KEY,
    confirm: async () => true,
    askConsent: async () => true,
    load: async () => structuredClone(st),
    save: async (s) => void (st = structuredClone(s)),
    now: () => T0,
  };
  return { deps, sent, setTag: (t: string) => (tag = t), store: () => st };
}
const storyRequests = (sent: RawRequest[]): RawRequest[] => sent.filter((r) => !(r.body ?? "").includes("<story id="));
const sectionRequests = (sent: RawRequest[]): RawRequest[] => sent.filter((r) => (r.body ?? "").includes("<story id="));

describe("updated stories and the digest's text", () => {
  async function written() {
    const w = world();
    const s = store();
    const h = aiHarness();
    const info = await s.ed.open(w.items);
    const first = await writeDigest(h.deps, info.grouped.clusters);
    await rememberWrite(h.deps, s.ed, info.id, info.grouped.clusters, first);
    return { w, s, h, info, first };
  }
  it("a story with new posts keeps its text and shows which posts are new; the others show none", async () => {
    const { w, s, h } = await written();
    const reply = post({ text: "Another answer entirely.", isReply: true, stubTarget: { origin: "https://one.example.com/", id: w.leads[0]!.remoteId }, authorName: "Cy" });
    const info = await s.ed.open([...w.items, reply]);
    const texts = await cachedStories(h.deps, await s.ed.current(), info.grouped.clusters);
    expect(texts[0]?.headline).toBe("Headline 1"); // the old text, not blank
    expect(texts[0]?.fresh).toEqual([reply.remoteId]);
    expect(texts.slice(1).every((t) => t?.fresh?.length === 0)).toBe(true);
  });
  it("Write the digest re-summarises only the updated stories, and asks the sections again only when the headline set changed", async () => {
    const { w, s, h, first } = await written();
    expect(storyRequests(h.sent)).toHaveLength(1);
    expect(sectionRequests(h.sent)).toHaveLength(1);
    expect(first.sections).not.toBeNull();
    const reply = post({ text: "Another answer entirely.", isReply: true, stubTarget: { origin: "https://one.example.com/", id: w.leads[0]!.remoteId }, authorName: "Cy" });
    let info = await s.ed.open([...w.items, reply]);
    h.sent.length = 0;
    const o = await writeDigest(h.deps, info.grouped.clusters);
    await rememberWrite(h.deps, s.ed, info.id, info.grouped.clusters, o);
    const reqs = storyRequests(h.sent);
    expect(reqs).toHaveLength(1);
    const body = reqs[0]?.body ?? "";
    expect(body).toContain("Secret0");
    expect(body).toContain("Another answer entirely");
    for (let k = 1; k < 6; k++) expect(body).not.toContain(`Secret${k}`); // only the updated story is sent
    expect(sectionRequests(h.sent)).toHaveLength(0); // same headlines: the sections are as they were
    const after = await cachedStories(h.deps, await s.ed.current(), info.grouped.clusters);
    expect(after[0]?.fresh).toEqual([]); // the mark is gone once the text is rewritten
    // another new post; this time the re-written headline differs: the sections are asked again
    const reply2 = post({ text: "One more answer here.", isReply: true, stubTarget: { origin: "https://one.example.com/", id: w.leads[0]!.remoteId }, authorName: "Cy" });
    info = await s.ed.open([...w.items, reply, reply2]);
    h.setTag("Changed");
    h.sent.length = 0;
    await writeDigest(h.deps, info.grouped.clusters);
    expect(storyRequests(h.sent)).toHaveLength(1);
    expect(sectionRequests(h.sent)).toHaveLength(1);
  });
  it("stories keep their section until the next write; a new story is shown under Other", async () => {
    const { w, s, h, info } = await written();
    const rec = await s.ed.current();
    const sec = recordSections(rec, info.grouped.clusters);
    expect(sec?.map((x) => x.name).sort()).toEqual(["One", "Three", "Two"]);
    const a = post({ text: "Kiln glaze recipe: iron, ash and patience for the autumn firing." });
    const b = post({ text: "Replying about the kiln.", isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId } });
    const info2 = await s.ed.open([...w.items, a, b]);
    const sec2 = recordSections(await s.ed.current(), info2.grouped.clusters);
    expect(sec2?.find((x) => x.name === "Other")?.ids).toEqual([6]);
    expect(sec2?.filter((x) => x.name !== "Other").flatMap((x) => x.ids).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(h.sent.length).toBe(2); // nothing was sent by reading
  });
});
