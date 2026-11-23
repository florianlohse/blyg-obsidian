// DG10: the change note of a revised post, read lazily from the Studio's history of an imported item (src/digest/changeNotes.ts), shown as the lead of the correction line.
// Fake DOM, fake Studio; invented names only.
process.env.TZ = "Europe/Berlin";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class FakeEl {
    cls = new Set<string>();
    text = "";
    children: FakeEl[] = [];
    handlers: Array<() => void> = [];
    scrollTop = 0;
    scrolled = 0;
    isConnected = true;
    attrs: Record<string, string> = {};
    constructor(public tag = "div") {}
    addClass(c: string) { this.cls.add(c); }
    toggleClass(c: string, on: boolean) { if (on) this.cls.add(c); else this.cls.delete(c); }
    setAttr(k: string, v: string) { this.attrs[k] = v; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    private make(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) {
      const el = new FakeEl(tag);
      if (o?.cls) o.cls.split(" ").forEach((c) => el.cls.add(c));
      if (o?.text) el.text = o.text;
      Object.assign(el.attrs, o?.attr ?? {});
      this.children.push(el);
      return el;
    }
    createDiv(o?: { cls?: string; text?: string }) { return this.make("div", o); }
    createSpan(o?: { cls?: string; text?: string }) { return this.make("span", o); }
    createEl(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.make(tag, o); }
    addEventListener(_t: string, fn: () => void) { this.handlers.push(fn); }
    click() { this.handlers.forEach((h) => h()); }
    empty() { this.children = []; }
    removeClass(c: string) { this.cls.delete(c); }
    prepend(el: FakeEl) { this.children = this.children.filter((c) => c !== el); this.children.unshift(el); }
    scrollIntoView() { this.scrolled++; }
    all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  }
  class ItemView {
    contentEl = new FakeEl();
    constructor(public leaf: unknown) {}
  }
  return { ItemView, setIcon: (el: { attrs?: Record<string, string> }, n: string) => void (el.attrs ??= {}, el.attrs["data-icon"] = n) };
});


import { ChangeNotes, NOTE_MAX_CHARS, NOTES_PER_DRAW, cleanNote } from "../../src/digest/changeNotes";
import { clearScrolls } from "../../src/digest/scrollMemory";
import { resetMarks } from "../../src/digest/markQueue";
import { BlygDailyView, type DigestHost } from "../../src/ui/DigestView";
import type { ReadingPost } from "../../src/studio/reading";
import type { StudioResult } from "../../src/studio/types";

vi.stubGlobal("window", globalThis); // the plugin's timers are window timers (popout windows); Node has none

const NOW = Date.parse("2030-03-10T12:00:00Z");
let n = 0;
const post = (text: string, author: string | null, over: Partial<ReadingPost> = {}): ReadingPost => ({
  subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: `m${String(++n).padStart(6, "0")}`.padEnd(26, "x"), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
  observedAt: new Date(NOW - 3600_000 - n * 1000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: `<p>${text}</p>`, contentMd: "", authorName: author, authorUrl: null, sourceUrl: null, ...over,
});
type El = { text: string; tag: string; cls: Set<string>; click(): void; all(): El[] };
const has = (e: El, c: string): boolean => e.cls.has(c);
const flush = async (): Promise<void> => void (await new Promise((r) => setTimeout(r, 0)));
type Answer = StudioResult<{ notes: Array<{ version: number; note: string }> }>;
const ok = (notes: Array<{ version: number; note: string }>): Answer => ({ kind: "ok", value: { notes } });

function engine(answer: (sub: string, id: string) => Answer | Promise<Answer>, stored: unknown = null, timeoutMs?: number) {
  const calls: string[] = [];
  const saved: string[] = [];
  const notes = new ChangeNotes({ fetch: async (s, i) => (calls.push(`${s}/${i}`), answer(s, i)), load: () => Promise.resolve(stored), save: (t) => Promise.resolve(void saved.push(t)), ...(timeoutMs ? { timeoutMs } : {}) });
  return { notes, calls, saved };
}

describe("ChangeNotes", () => {
  it("returns the note of the post's own version and keeps it by item and version", async () => {
    const p = post("x", "Ann", { version: 3 });
    const e = engine(() => ok([{ version: 2, note: "older" }, { version: 3, note: "Fixed the March total" }]));
    expect(await e.notes.get(p)).toBe("Fixed the March total");
    expect((JSON.parse(e.saved[0]!) as { notes: Record<string, string> }).notes[`s1/${p.remoteId}@3`]).toBe("Fixed the March total");
  });
  it("asks once per (item, version), also when asked together or again, and again for a new version", async () => {
    const p = post("x", "Ann", { version: 2 });
    const e = engine(() => ok([{ version: 2, note: "A" }, { version: 3, note: "B" }]));
    expect(await Promise.all([e.notes.get(p), e.notes.get(p)])).toEqual(["A", "A"]);
    await e.notes.get({ ...p });
    expect(e.calls).toHaveLength(1);
    expect(await e.notes.get({ ...p, version: 3 })).toBe("B");
    expect(e.calls).toHaveLength(2);
  });
  it("makes no request for a post that was not revised or is withdrawn", async () => {
    const e = engine(() => ok([]));
    expect(await e.notes.get(post("x", "Ann", { version: 1 }))).toBe("");
    expect(await e.notes.get(post("x", "Ann", { version: 2, withdrawn: true }))).toBe("");
    expect(e.calls).toHaveLength(0);
  });
  it("remembers that a version has no note (not asked again, also after a restart from storage)", async () => {
    const p = post("x", "Ann", { version: 2 });
    const e = engine(() => ok([{ version: 1, note: "first" }]));
    expect(await e.notes.get(p)).toBe("");
    await e.notes.get(p);
    expect(e.calls).toHaveLength(1);
    const again = engine(() => ok([]), JSON.parse(e.saved[0]!));
    expect(await again.notes.get(p)).toBe("");
    expect(again.calls).toHaveLength(0);
  });
  it("serves a stored note without a request", async () => {
    const p = post("x", "Ann", { version: 2 });
    const e = engine(() => ok([]), { v: 1, notes: { [`s1/${p.remoteId}@2`]: "From storage" } });
    expect(await e.notes.get(p)).toBe("From storage");
    expect(e.calls).toHaveLength(0);
  });
  it("a refusal, a thrown error, a timeout and a malformed store show nothing, store nothing and are not retried in the session", async () => {
    for (const answer of [(): Answer => ({ kind: "forbidden", message: "no" }), (): Answer => { throw new Error("offline"); }, (): Promise<Answer> => new Promise(() => undefined)]) {
      const p = post("x", "Ann", { version: 2 });
      const e = engine(answer, "garbage", 20);
      expect(await e.notes.get(p)).toBe("");
      expect(await e.notes.get(p)).toBe("");
      expect(e.calls).toHaveLength(1);
      expect(e.saved).toHaveLength(0);
    }
  });
  it("a Studio that is not set up (status 0) is not remembered as a failure and asks nothing", async () => {
    const p = post("x", "Ann", { version: 2 });
    let ready = false;
    const e = engine(() => (ready ? ok([{ version: 2, note: "Now set up" }]) : { kind: "error", status: 0, message: "no token" }));
    expect(await e.notes.get(p)).toBe("");
    ready = true;
    expect(await e.notes.get(p)).toBe("Now set up");
  });
  it("cleans the text: markup stays text, controls and direction marks go, whitespace collapses, the length is capped", () => {
    expect(cleanNote("<img src=x onerror=alert(1)> **bold**")).toBe("<img src=x onerror=alert(1)> **bold**");
    expect(cleanNote("a\u202eb\u0000c\n\n  d\u200b")).toBe("a b c d");
    expect(cleanNote("w".repeat(5000))).toHaveLength(NOTE_MAX_CHARS);
    expect(cleanNote("   ")).toBe("");
    expect(cleanNote({ note: "x" })).toBe("");
    expect(cleanNote(null)).toBe("");
  });
  it("an oversized note is capped before it is kept", async () => {
    const p = post("x", "Ann", { version: 2 });
    const e = engine(() => ok([{ version: 2, note: "y".repeat(100_000) }]));
    const got = await e.notes.get(p);
    expect(got).toHaveLength(NOTE_MAX_CHARS);
    expect(e.saved[0]!.length).toBeLessThan(1000);
  });
});

describe("the Corrections line with a lazily read note", () => {
  beforeEach(() => {
    n = 0;
    resetMarks();
    clearScrolls();
  });
  async function mount(posts: ReadingPost[], changeNote?: DigestHost["changeNote"]) {
    const host: DigestHost = {
      loadList: () => Promise.resolve({ posts, mentions: [], savedAt: NOW }),
      edition: () => Promise.resolve({ id: 7, since: NOW - 6 * 3600_000, until: NOW }),
      font: () => "serif",
      showFeed: () => Promise.resolve(),
      openPost: () => Promise.resolve(),
      openWeb: () => undefined,
      ...(changeNote ? { changeNote } : {}),
    };
    const view = new BlygDailyView({} as never, host);
    await view.onOpen();
    await flush();
    return (view as unknown as { contentEl: El }).contentEl;
  }
  const rows = (root: El): El[] => root.all().filter((e) => has(e, "blyg-daily-row"));
  const row = (root: El, headline: string): El => rows(root).find((r) => r.all().some((e) => e.text === headline))!;

  it("shows the note as the bold lead and the headline second; asks only for revised posts; one request per (item, version) over repeated draws", async () => {
    const revised = post("Corrected harbour figure here.", "Ann", { version: 2 });
    const first = post("A first version, never revised.", "Bo");
    const calls: string[] = [];
    const e = engine((_s, i) => (calls.push(i), ok([{ version: 2, note: "Fixed the March total" }])));
    const root = await mount([revised, first], (p) => e.notes.get(p));
    const r = row(root, "Corrected harbour figure here.");
    const kids = r.all().filter((x) => x.tag === "button");
    expect(kids.map((x) => x.text)).toEqual(["Fixed the March total", "Corrected harbour figure here."]);
    expect(has(kids[0]!, "blyg-correction-note")).toBe(true);
    expect(has(kids[1]!, "blyg-correction-headline")).toBe(true);
    expect(e.calls).toEqual([`s1/${revised.remoteId}`]);
    await mount([revised, first], (p) => e.notes.get(p)); // drawn again
    expect(e.calls).toHaveLength(1);
  });
  it("HTML in a note is shown as plain text", async () => {
    const revised = post("Corrected harbour figure here.", "Ann", { version: 2 });
    const e = engine(() => ok([{ version: 2, note: "<b>bold</b><script>x()</script>" }]));
    const root = await mount([revised], (p) => e.notes.get(p));
    expect(root.all().find((x) => has(x, "blyg-correction-note"))!.text).toBe("<b>bold</b><script>x()</script>");
  });
  it("a missing note, a failure, or no host support leaves the old line", async () => {
    const revised = post("Corrected harbour figure here.", "Ann", { version: 2 });
    for (const changeNote of [(): Promise<string> => Promise.resolve(""), (): Promise<string> => Promise.reject(new Error("x")), undefined]) {
      const root = await mount([revised], changeNote);
      expect(root.all().some((x) => has(x, "blyg-correction-note"))).toBe(false);
      expect(root.all().some((x) => has(x, "blyg-correction-headline"))).toBe(false);
      expect(root.all().some((x) => x.text === "Corrected harbour figure here.")).toBe(true);
      expect(root.all().some((x) => x.text === "Ann · revised to v2")).toBe(true);
    }
  });
  it("looks up at most a handful of notes per draw, one after the other", async () => {
    const many = Array.from({ length: NOTES_PER_DRAW + 5 }, (_, i) => post(`Distinct revised matter number ${i} alpha.`, "Ann", { version: 2 }));
    let running = 0;
    let peak = 0;
    const seen: string[] = [];
    await mount(many, async (p) => {
      seen.push(p.remoteId);
      peak = Math.max(peak, ++running);
      await flush();
      running--;
      return "";
    });
    for (let i = 0; i < 40; i++) await flush(); // the lookups run one after the other
    expect(seen).toHaveLength(NOTES_PER_DRAW);
    expect(peak).toBe(1);
  });
});
