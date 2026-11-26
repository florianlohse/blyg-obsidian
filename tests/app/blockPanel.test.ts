// V1-C.3: the panel's per-paragraph states, read against a real client over the fake Studio.
import { describe, expect, it } from "vitest";
import { loadBlockRows } from "../../src/app/blockPanel";
import { publishParagraph } from "../../src/publish/studioBlocks";
import { loadStudioFacts, type StudioFacts } from "../../src/studio/live";
import { STUDIO_ORIGIN } from "../studio/fake-studio";
import { makeStudioWorld, STUDIO_ROUTES, type StudioWorld } from "../studio/world";

const DAILY = "studio/Daily note.md";
const P1 = "Most of what I call thinking is rereading my own sentences until one of them holds.";
const P2 = "A good note is one I can quote without apologising for the context around it.";
const ref = { path: DAILY, name: "Daily note.md", extension: "md" };
const lineOf = (w: StudioWorld, words: string): number => (w.local.get(DAILY) ?? "").split("\n").findIndex((l) => l.startsWith(words.slice(0, 12))) + 1;

async function rows(w: StudioWorld, known: boolean | Record<string, StudioFacts> = true): ReturnType<typeof loadBlockRows> {
  const client = w.deps.studio?.client;
  if (!client) throw new Error("setup");
  const cache = new Map<string, StudioFacts>();
  const map = (w.deps.vault.frontmatterValue(ref, "blyg_blocks") ?? {}) as Record<string, string>;
  if (known === true) for (const id of Object.values(map)) cache.set(id, await loadStudioFacts(client, id, w.deps.clock));
  else if (known !== false) for (const [id, f] of Object.entries(known)) cache.set(id, f);
  return loadBlockRows({ vault: w.deps.vault, routes: STUDIO_ROUTES, fragmentCharCap: 1000, origin: STUDIO_ORIGIN, facts: (id) => cache.get(id) }, ref);
}

async function twoPublished(): Promise<StudioWorld> {
  const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: `---\ntags: [x]\n---\n${P1} ^ab12\n\n${P2} ^cd34\n\nUnpublished one.\n` } });
  for (const p of [P1, P2]) expect((await publishParagraph(w.deps, ref, lineOf(w, p))).status).toBe("published");
  return w;
}

describe("the panel's paragraphs", () => {
  it("both in sync after publishing", async () => {
    const w = await twoPublished();
    const r = await rows(w);
    expect(r.rows.map((x) => [x.blockId, x.state, x.version])).toEqual([["ab12", "in-sync", 1], ["cd34", "in-sync", 1]]);
    expect(r.rows[0]?.excerpt).toBe(P1.slice(0, 70));
  });

  it("an edited paragraph is Changed, with its line; the other stays in sync", async () => {
    const w = await twoPublished();
    w.local.set(DAILY, (w.local.get(DAILY) ?? "").replace("quote without", "quote it without"));
    const r = await rows(w);
    expect(r.rows.map((x) => [x.blockId, x.state])).toEqual([["ab12", "in-sync"], ["cd34", "changed"]]);
    expect(r.rows[1]?.line).toBe(lineOf(w, P2));
  });

  it("an edit that is undone is in sync again", async () => {
    const w = await twoPublished();
    const before = w.local.get(DAILY) ?? "";
    w.local.set(DAILY, before.replace("quote without", "quote it without"));
    expect((await rows(w)).rows[1]?.state).toBe("changed");
    w.local.set(DAILY, before);
    expect((await rows(w)).rows[1]?.state).toBe("in-sync");
  });

  it("a paragraph that is no longer in the note is Gone; the item stays", async () => {
    const w = await twoPublished();
    w.local.set(DAILY, (w.local.get(DAILY) ?? "").replace(`${P1} ^ab12\n\n`, ""));
    const r = await rows(w);
    expect(r.rows[0]).toMatchObject({ blockId: "ab12", state: "gone", excerpt: null, line: null });
  });

  it("before the Studio has answered it says Checking; when it could not be asked, Not checked; a missing or withdrawn item says so", async () => {
    const w = await twoPublished();
    expect((await rows(w, false)).rows.map((x) => x.state)).toEqual(["checking", "checking"]);
    const ids = Object.values((w.deps.vault.frontmatterValue(ref, "blyg_blocks") ?? {}) as Record<string, string>);
    const at = 0;
    const r = await rows(w, {
      [ids[0] as string]: { item: "unreachable", mentions: null, at },
      [ids[1] as string]: { item: "missing", mentions: null, at },
    });
    expect(r.rows.map((x) => x.state)).toEqual(["unknown", "missing"]);
    const withdrawn = await rows(w, { [ids[0] as string]: { item: { status: "withdrawn", version: 2, workingHash: "x" }, mentions: null, at } });
    expect(withdrawn.rows[0]?.state).toBe("withdrawn");
  });

  it("a note with no record, or the record of another Studio, lists nothing", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: "Words.\n" } });
    expect(await rows(w)).toEqual({ rows: [], more: 0 });
    const other = await twoPublished();
    other.local.set(DAILY, (other.local.get(DAILY) ?? "").replace(STUDIO_ORIGIN, "https://other.example/"));
    expect(await rows(other)).toEqual({ rows: [], more: 0 });
  });
});

describe("through loadPanelState and the drawing", () => {
  it("the panel state carries the rows when the feature is on, and not when it is off", async () => {
    const { loadPanelState } = await import("../../src/app/panelState");
    const { defaultSettings } = await import("../../src/settings/schema");
    const { STUDIO_HOST } = await import("../studio/fake-studio");
    const w = await twoPublished();
    const s = defaultSettings();
    s.studio = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "t", importFolder: "" };
    s.routes = [...STUDIO_ROUTES];
    const facts = (id: string): StudioFacts => ({ item: { status: "public", version: 1, workingHash: `h-${id}` }, mentions: null, at: 0 });
    const live = (_n: unknown, id: string | null) => ({ ...(id ? { facts: facts(id) } : {}), warnings: [] as string[] });
    const on = await loadPanelState({ settings: s, vault: w.deps.vault, tangle: true, studioLive: live }, ref);
    expect(on.blocks?.rows.map((r) => [r.blockId, r.state])).toEqual([["ab12", "changed"], ["cd34", "changed"]]); // the invented hashes differ from the text
    const off = await loadPanelState({ settings: s, vault: w.deps.vault, studioLive: live }, ref);
    expect(off.blocks).toBeUndefined();
  });

  it("draws one row per paragraph, an Update button only for a changed one, as text", async () => {
    const { drawBlockRows } = await import("../../src/ui/blockRows");
    type El = { cls: string; text: string; kids: El[]; click?: () => void };
    const make = (cls = "", text = ""): El & Record<string, unknown> => {
      const el: El & Record<string, unknown> = { cls, text, kids: [] };
      const add = (tag: string, o?: { cls?: string; text?: string }): El & Record<string, unknown> => {
        const kid = make(o?.cls ?? "", o?.text ?? "");
        el.kids.push(kid);
        return kid;
      };
      el.createDiv = (o?: { cls?: string; text?: string }) => add("div", o);
      el.createSpan = (o?: { cls?: string; text?: string }) => add("span", o);
      el.createEl = (tag: string, o?: { cls?: string; text?: string }) => add(tag, o);
      el.addEventListener = (_t: string, fn: () => void) => (el.click = fn);
      return el;
    };
    const flat = (e: El): El[] => [e, ...e.kids.flatMap(flat)];
    const root = make();
    const published: string[] = [];
    drawBlockRows(root as unknown as HTMLElement, { more: 2, rows: [
      { blockId: "ab12", itemId: "i1", excerpt: "<b>bold</b> words", line: 5, state: "in-sync", version: 1 },
      { blockId: "cd34", itemId: "i2", excerpt: "changed words", line: 7, state: "changed", version: 2 },
    ] }, (row) => published.push(row.blockId));
    const all = flat(root);
    expect(all.some((e) => e.text === "Paragraphs from this note · 4 (1 changed)")).toBe(true);
    expect(all.some((e) => e.text === "<b>bold</b> words")).toBe(true); // text, not markup
    const buttons = all.filter((e) => e.text === "Update item…");
    expect(buttons).toHaveLength(1);
    buttons[0]?.click?.();
    expect(published).toEqual(["cd34"]);
    expect(all.some((e) => e.text === "2 more are not listed.")).toBe(true);
  });
});
