// DG4b: the automatic write (once per edition, guarded), the history of the last 14 editions, the footer estimate, and the day switcher.
process.env.TZ = "Europe/Berlin";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FakeEl {
    cls = new Set<string>();
    text = "";
    children: FakeEl[] = [];
    handlers: Array<() => void> = [];
    constructor(public tag = "div") {}
    addClass(c: string) {
      this.cls.add(c);
    }
    toggleClass(c: string, on: boolean) {
      if (on) this.cls.add(c);
      else this.cls.delete(c);
    }
    attrs: Record<string, string> = {};
    setAttr(k: string, v: string) {
      this.attrs[k] = v;
    }
    removeAttribute(k: string) {
      delete this.attrs[k];
    }
    private make(tag: string, o?: { cls?: string; text?: string }) {
      const el = new FakeEl(tag);
      if (o?.cls) o.cls.split(" ").forEach((c) => el.cls.add(c));
      if (o?.text) el.text = o.text;
      this.children.push(el);
      return el;
    }
    createDiv(o?: { cls?: string; text?: string }) {
      return this.make("div", o);
    }
    createSpan(o?: { cls?: string; text?: string }) {
      return this.make("span", o);
    }
    createEl(tag: string, o?: { cls?: string; text?: string }) {
      return this.make(tag, o);
    }
    addEventListener(_t: string, fn: () => void) {
      this.handlers.push(fn);
    }
    click() {
      this.handlers.forEach((h) => h());
    }
    empty() {
      this.children = [];
    }
    all(): FakeEl[] {
      return [this, ...this.children.flatMap((c) => c.all())];
    }
  }
  class ItemView {
    contentEl = new FakeEl();
    constructor(public leaf: unknown) {}
  }
  return { ItemView, setIcon: (el: { attrs?: Record<string, string> }, n: string) => void (el.attrs ??= {}, el.attrs["data-icon"] = n) };
});

import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import { autoDue, ceilingRefusal, usageLine, addUsage } from "../../src/digest/autoWrite";
import { Editions } from "../../src/digest/editionHost";
import { buildPast, History, HISTORY_MAX_CHARS, parseHistory, type PastEdition } from "../../src/digest/history";
import { emptyStore, writeDigest, type LlmDeps, type LlmStore, type Outcome } from "../../src/digest/llm";
import { clusterPosts } from "../../src/digest/cluster";
import { addTokens } from "../../src/digest/budget";
import { EDITIONS_KEPT, type EditionRec } from "../../src/digest/edition";
import type { RawRequest } from "../../src/platform/http";
import type { ReadingPost } from "../../src/studio/reading";

const NOW = Date.parse("2030-03-10T12:00:00Z");
const KEY = "sk-test-0123456789abcdefghijklmnop";
const p = (over: Partial<ReadingPost>): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Blyg", origin: "https://one.example.com/", remoteId: "a".repeat(26), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: "<p>Hello there, a long enough sentence.</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over,
});
const a = p({ remoteId: "a".repeat(26), contentHtml: "<p>Shared topic about gardens and tomatoes in spring.</p>", authorName: "Ann" });
const b = p({ remoteId: "b".repeat(26), isReply: true, stubTarget: { id: a.remoteId } as never, contentHtml: "<p>My tomatoes did badly this spring.</p>", authorName: "Bo" });
const lone = p({ remoteId: "z".repeat(26), contentHtml: "<p>A lone post nobody answers at all.</p>", authorName: "Cy" });
const list = { posts: [a, b, lone], mentions: [], savedAt: NOW };
type El = { text: string; tag: string; click(): void; all(): El[]; handlers: Array<() => void> };
const cls = (e: unknown): Set<string> => (e as { cls: Set<string> }).cls;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const ok = (): Outcome => ({ written: [{ headline: "Gardens", summary: "Tomatoes grew.", model: "m", posts: 2 }], sections: null, status: "ok", tokens: 1234, cost: 0.004 });

interface Opts { due?: boolean[]; write?: () => Promise<Outcome>; past?: PastEdition[]; usage?: { tokens: number; cost: number | null }; autoNote?: string; enabled?: boolean }
async function mount(o: Opts = {}) {
  const calls: Array<{ auto?: boolean; resort?: boolean } | undefined> = [];
  const due = [...(o.due ?? [])];
  const host: DigestHost = {
    loadList: () => Promise.resolve(list),
    edition: () => Promise.resolve({ id: NOW - 5 * 3600_000, since: NOW - 29 * 3600_000, until: NOW, ...(o.usage ? { usage: o.usage } : {}), ...(o.autoNote ? { auto: { note: o.autoNote } } : {}) }),
    history: () => Promise.resolve({ editions: o.past ?? [], capped: false }),
    ai: {
      enabled: () => o.enabled !== false,
      cached: async () => [],
      autoDue: async () => due.shift() === true,
      write: (_c, _s, opts) => (calls.push(opts), (o.write ?? (async () => ok()))()),
    },
    font: () => "serif", showFeed: () => Promise.resolve(), openPost: () => Promise.resolve(), openWeb: () => undefined,
  };
  const opened: string[] = [];
  host.openPost = (post) => Promise.resolve(void opened.push(post.remoteId));
  const view = new BlygDailyView({ id: "leaf" } as never, host);
  await view.onOpen();
  await settle();
  const root = (view as unknown as { contentEl: El }).contentEl;
  return { root, view, calls, opened, texts: () => root.all().map((e) => e.text) };
}

describe("automatic write: when it is due (pure rules)", () => {
  const rec = (over: Partial<EditionRec> = {}): EditionRec => ({ id: 1, createdAt: 1, n: 1, stories: [{ id: "s1", posts: ["x", "y"] }], mixed: [], seen: {}, ...over });
  const store = (host = "api.example.com"): LlmStore => ({ ...emptyStore(), consent: { host, model: "m", at: 1 } });
  const s = { useAi: true, autoWrite: true, endpoint: "https://api.example.com", dailyTokenCeiling: 2_000_000 };
  it("is due only with every condition", () => {
    expect(autoDue(s, rec(), store(), 1)).toBe(true);
    expect(autoDue({ ...s, autoWrite: false }, rec(), store(), 1)).toBe(false); // setting off
    expect(autoDue({ ...s, useAi: false }, rec(), store(), 1)).toBe(false); // AI off
    expect(autoDue(s, rec(), emptyStore(), 1)).toBe(false); // no consent
    expect(autoDue(s, rec(), store("other.example.com"), 1)).toBe(false); // consent for another host
    expect(autoDue(s, rec(), store(), 0)).toBe(false); // no story to write
    expect(autoDue(s, null, store(), 1)).toBe(false);
    expect(autoDue(s, rec({ stories: [{ id: "s1", posts: [], textKey: "k" }] }), store(), 1)).toBe(false); // already written by hand: updates stay manual
  });
  it("the ceiling is enforced for automatic runs and counts today's tally", () => {
    const st = { ...store(), tally: addTokens(null, NOW, 1_900_000) };
    expect(ceilingRefusal(s, st, NOW, { tokens: 50_000 })).toBeNull();
    expect(ceilingRefusal(s, st, NOW, { tokens: 150_000 })).toContain("daily token ceiling");
    expect(ceilingRefusal({ dailyTokenCeiling: 0 }, st, NOW, { tokens: 1e9 })).toBeNull(); // 0: none
  });
  it("the footer line", () => {
    expect(usageLine({ tokens: 1234, cost: 0.004 })).toBe("about 1234 tokens, under 1 cent");
    expect(usageLine({ tokens: 10, cost: null })).toBe("about 10 tokens, cost unknown");
    expect(addUsage({ tokens: 10, cost: 0.001 }, 5, 0.002)).toEqual({ tokens: 15, cost: 0.003 });
  });
});

describe("automatic write: once per edition, in the store", () => {
  it("claims the attempt once; a failed attempt is not claimed again", async () => {
    let file: unknown = null;
    const t = Date.UTC(2030, 2, 10, 12);
    const ed = new Editions({ read: async () => file, write: async (x) => void (file = JSON.parse(x)), now: () => t, time: () => "07:00" });
    await ed.open([]);
    expect(await ed.claimAuto(() => false)).toBe(false); // not allowed: not used up
    expect(await ed.claimAuto(() => true)).toBe(true);
    expect(await ed.claimAuto(() => true)).toBe(false); // the one attempt is gone
    await ed.update((await ed.current())?.id ?? 0, (e) => ({ ...e, auto: { note: "failed" } }));
    expect(await ed.claimAuto(() => true)).toBe(false); // still no retry after a failure
    expect((await ed.open([])).auto).toEqual({ note: "failed" }); // and the note comes back with the edition
  });
});

describe("automatic write in the Daily", () => {
  it("writes once in the background: the plain digest shows first, the text replaces it", async () => {
    let release: (o: Outcome) => void = () => undefined;
    const m = await mount({ due: [true], write: () => new Promise<Outcome>((r) => (release = r)) });
    expect(m.calls).toEqual([{ resort: false, auto: true }]);
    expect(m.texts()).toContain("Writing the digest…"); // quiet spinner while it runs
    expect(m.texts()).toContain("Front page"); // the plain digest is there meanwhile
    release(ok());
    await settle();
    expect(m.texts()).toContain("Gardens");
    expect(m.texts().join("\n")).toContain("about 1234 tokens, under 1 cent"); // the footer estimate
  });
  it("does not write when nothing is due (off, no consent, over the ceiling, already tried)", async () => {
    const m = await mount({ due: [false] });
    expect(m.calls).toEqual([]);
    expect(m.texts()).toContain("Write the digest");
  });
  it("one attempt: a failure shows a small note, the button stays, and nothing is retried", async () => {
    const m = await mount({ due: [true, false], write: async () => ({ written: [], status: "failed", note: "The provider could not be reached." }) });
    expect(m.calls).toHaveLength(1);
    expect(m.texts().join("\n")).toContain("The automatic write did not work: The provider could not be reached.");
    expect(m.texts()).toContain("Write the digest");
    m.root.all().find((e) => e.text === "Refresh")?.click(); // opening again: the host says no (the attempt was used)
    await settle();
    expect(m.calls).toHaveLength(1);
  });
  it("a manual write is a plain write, and the note of a past automatic try is shown", async () => {
    const m = await mount({ autoNote: "Not written automatically: it would pass the daily token ceiling." });
    expect(m.texts().join("\n")).toContain("daily token ceiling");
    cls(m.root.all().find((e) => cls(e).has("blyg-story-write")) ?? {}); // the button is there
    m.root.all().find((e) => cls(e).has("blyg-story-write"))?.click();
    await settle();
    expect(m.calls).toEqual([{ resort: false }]);
  });
  it("shows the stored usage in the footer when the text is there", async () => {
    const m = await mount({ usage: { tokens: 800, cost: null } });
    expect(m.texts().join("\n")).not.toContain("about 800"); // no text, no footer
  });
});

// ---- the transport: nothing leaves without consent, and the key is never kept
function llmHarness(consent: string | null) {
  const sent: RawRequest[] = [];
  let st: LlmStore = { ...emptyStore(), consent: consent ? { host: consent, model: "test-model", at: 1 } : null };
  const asked: string[] = [];
  const deps: LlmDeps = {
    settings: () => ({ endpoint: "https://api.example.com/", model: "test-model" }),
    transport: async (r) => (sent.push(r), { status: 200, headers: {}, text: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ clusters: [{ id: 1, headline: "Gardens", summary: "Tomatoes grew." }] }) }] }) }),
    getKey: () => KEY, confirm: async () => true, askConsent: async (h) => (asked.push(h), false),
    load: async () => structuredClone(st), save: async (s) => void (st = structuredClone(s)), now: () => NOW,
  };
  return { deps, sent, asked, store: () => st };
}
const fronts = () => clusterPosts([a, b]);

describe("automatic run through writeDigest", () => {
  it("sends nothing without consent and never asks for it", async () => {
    const h = llmHarness(null);
    const o = await writeDigest(h.deps, fronts(), { confirm: false });
    expect(o.status).toBe("cancelled");
    expect(h.sent).toHaveLength(0);
  });
  it("the ceiling gate refuses before anything is sent", async () => {
    const h = llmHarness("api.example.com");
    const o = await writeDigest(h.deps, fronts(), { confirm: false, gate: () => "Not written automatically: ceiling." });
    expect(o).toMatchObject({ status: "cancelled", note: "Not written automatically: ceiling." });
    expect(h.sent).toHaveLength(0);
  });
  it("with consent and room it sends once, reports its tokens, and the key stays out of the history record", async () => {
    const h = llmHarness("api.example.com");
    const o = await writeDigest(h.deps, fronts(), { confirm: false, gate: () => null });
    expect(o.status).toBe("ok");
    expect(h.sent).toHaveLength(1);
    expect(o.tokens).toBeGreaterThan(0);
    const rec = buildPast(7, fronts(), o, [lone], NOW);
    expect(JSON.stringify(rec)).not.toContain(KEY);
    expect(rec.stories[0]).toMatchObject({ headline: "Gardens", summary: "Tomatoes grew." });
    expect(rec.who[a.remoteId]).toBe("Ann");
    expect(JSON.stringify(rec)).not.toContain("tomatoes and"); // no post body
  });
});

describe("history", () => {
  const rec = (id: number, extra = 0): PastEdition => ({ id, at: id, stories: [{ headline: "H".repeat(10 + extra), summary: "S", posts: ["p1"] }], singles: ["p2"], sections: null, who: { p1: "Ann", p2: "Bo" } });
  const mem = () => {
    let file: unknown = null;
    return new History({ read: async () => file, write: async (t) => void (file = JSON.parse(t)) });
  };
  it("keeps the last 14 editions, newest first, and replaces a record of the same edition", async () => {
    const h = mem();
    for (let i = 1; i <= 20; i++) await h.put(rec(i));
    await h.put({ ...rec(20), at: 999 });
    const l = await h.list();
    expect(l.editions).toHaveLength(EDITIONS_KEPT);
    expect(l.editions[0]?.id).toBe(20);
    expect(l.editions[0]?.at).toBe(999);
    expect(l.editions.at(-1)?.id).toBe(7);
    expect(l.capped).toBe(false);
  });
  it("a size cap drops the oldest, keeps the newest, and says so", async () => {
    const h = mem();
    const big = (id: number): PastEdition => ({ ...rec(id), singles: Array.from({ length: 400 }, (_, i) => `post-${id}-${i}`.padEnd(26, "x")), who: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`post-${id}-${i}`.padEnd(26, "x"), "N".repeat(60)])) });
    for (let i = 1; i <= 14; i++) await h.put(big(i));
    const l = await h.list();
    expect(JSON.stringify(l.editions).length).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(l.editions.length).toBeLessThan(14);
    expect(l.editions[0]?.id).toBe(14);
    expect(l.capped).toBe(true);
  });
  it("reads a damaged file defensively", () => {
    expect(parseHistory({ editions: [{ id: "x" }, null, { id: 3, at: 3, stories: [{ headline: 5 }], who: { a: 1 } }] }).editions).toEqual([{ id: 3, at: 3, stories: [{ headline: "", summary: "", posts: [] }], singles: [], sections: null, who: {} }]);
    expect(parseHistory("nonsense").editions).toEqual([]);
  });
});

describe("the day switcher", () => {
  const past: PastEdition = { id: NOW - 29 * 3600_000, at: NOW, stories: [{ headline: "Last week's gardens", summary: "Old tomato news.", posts: [a.remoteId, "gone".padEnd(26, "x")] }], singles: [lone.remoteId, "away".padEnd(26, "x")], sections: [{ name: "Home", stories: [0], posts: [lone.remoteId, "away".padEnd(26, "x")] }], who: { [a.remoteId]: "Ann", ["gone".padEnd(26, "x")]: "Dee", ["away".padEnd(26, "x")]: "Eli" } };
  it("lists today's edition first, then the past ones, and shows a past edition read-only", async () => {
    const m = await mount({ past: [past] });
    const options = m.root.all().filter((e) => e.tag === "option").map((e) => e.text);
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("today's edition");
    m.root.all().find((e) => e.tag === "button" && e.text === "‹")?.click(); // previous edition
    const t = m.texts();
    expect(t).toContain("Home");
    expect(t).toContain("Last week's gardens");
    expect(t).toContain("Old tomato news.");
    expect(t).not.toContain("Write the digest"); // read-only: no write, no refresh
    expect(t).not.toContain("Refresh");
  });
  it("opens a post the reader still holds, and shows a missing one as a plain row with a note", async () => {
    const m = await mount({ past: [past] });
    m.root.all().find((e) => e.text === "‹")?.click();
    m.root.all().find((e) => cls(e).has("blyg-daily-headline"))?.click(); // unfold the story
    const t = m.texts();
    expect(t).toContain("Dee"); // not in the reader: plain text, from the record
    expect(t.filter((x) => x.includes("no longer in the reader's list")).length).toBeGreaterThanOrEqual(2); // Dee and Eli
    const row = m.root.all().find((e) => e.tag === "button" && e.text === "Ann");
    row?.click();
    expect(m.opened).toEqual([a.remoteId]); // held: opens
    expect(m.root.all().some((e) => e.tag === "button" && e.text === "Dee")).toBe(false); // missing: no button
    m.root.all().find((e) => e.text === "›")?.click(); // back to today's edition
    expect(m.texts()).toContain("Write the digest");
  });
});
