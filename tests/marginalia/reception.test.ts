// HK3 stage 2: the pure parts: the parser adapter, the paragraphs of a note, the matching, and the store.
import { describe, expect, it } from "vitest";
import { MarginaliaLookup, type MarginaliaEntry, type MarginaliaMention } from "../../src/marginalia/lookup";
import { buildReception, leadOf, markersOf, paragraphsOf, parseQuotesOf, placementNote, plainOfParagraph } from "../../src/marginalia/reception";
import { ReceptionStore } from "../../src/marginalia/store";
import type { InboundMention } from "../../src/studio/reading";

const ID = "01hzzzzzzzzzzzzzzzzzzzzzzz".replace(/z/g, "a").slice(0, 26).replace(/[ilou]/g, "a");
const m = (over: Partial<MarginaliaMention> = {}): MarginaliaMention => ({ id: "m1", targetItemId: ID, relation: "transclusion", status: "verified", hidden: false, sourceOrigin: "https://b.example", sourceId: "x1", sourcePage: "https://b.example/x1/", sourceAuthorName: "Teo", firstSeen: "2026-11-10T10:00:00Z", ...over });
const note = "---\nblyg_id: x\n---\n\nFirst paragraph about gardens.\n\nSecond paragraph, with **bold** words and a [link](https://e.example/a).\nIt runs two lines.\n\n```\ncode block\n```\n\nLast one.\n";

describe("parseQuotesOf", () => {
  it("a directive with > lines is a passage, one without is the whole post; other items are ignored", () => {
    const md = `hi\n\n![[${ID}]]\n> a passage\n> of two lines\n\n![[${ID}]]\n\n![[${"b".repeat(26)}]]\n> not ours\n`;
    expect(parseQuotesOf(md, ID)).toEqual([{ kind: "passage", text: "a passage of two lines" }, { kind: "whole" }]);
  });
  it("no directive for the item gives an empty list", () => {
    expect(parseQuotesOf("just text", ID)).toEqual([]);
  });
});

describe("paragraphsOf", () => {
  it("skips frontmatter and code, joins the lines of a paragraph, and says where each ends", () => {
    const ps = paragraphsOf(note);
    expect(ps.map((p) => p.plain)).toEqual(["First paragraph about gardens.", "Second paragraph, with bold words and a link. It runs two lines.", "Last one."]);
    expect(note.slice(ps[0]!.from, ps[0]!.to)).toBe("First paragraph about gardens.");
    expect(note.slice(ps[1]!.to - 10, ps[1]!.to)).toBe("two lines.");
  });
  it("a quote directive line is not a paragraph", () => {
    expect(paragraphsOf(`Para.\n\n![[${ID}]]\n\nNext.`).map((p) => p.plain)).toEqual(["Para.", "Next."]);
  });
  it("plain text drops Markdown marks", () => {
    expect(plainOfParagraph("## A *b* [[note|c]] ![[x]] `d`")).toBe("A b c d");
  });
});

const entry = (mention: MarginaliaMention, quotes: Array<{ kind: "whole" } | { kind: "passage"; text: string }>): MarginaliaEntry => ({ mention, result: { kind: "quotes", quotes, version: 1 } });

describe("buildReception", () => {
  const ps = paragraphsOf(note);
  it("places a passage at the paragraph it is in, even across Markdown", () => {
    const rows = buildReception([entry(m(), [{ kind: "passage", text: "bold words and a link" }])], ps);
    expect(rows[0]!.placement).toMatchObject({ kind: "paragraph", index: 1 });
    expect([...markersOf(rows).keys()]).toEqual([1]);
  });
  it("a whole-post quote, a passage the note no longer holds, and an unreadable post each get a row, none a marker", () => {
    const rows = buildReception(
      [entry(m({ id: "a" }), [{ kind: "whole" }]), entry(m({ id: "b" }), [{ kind: "passage", text: "words that were never in this note at all" }]), { mention: m({ id: "c" }), result: { kind: "unknown", reason: "unreadable" } }],
      ps,
    );
    expect(rows.map((r) => r.placement.kind)).toEqual(["whole", "earlier", "unknown"]);
    expect(markersOf(rows).size).toBe(0);
    expect(placementNote(rows[1]!.placement)).toBe("from an earlier version");
    expect(placementNote(rows[2]!.placement)).toBe("the Studio does not hold this post, so what it quotes cannot be read");
  });
  it("a reply that quotes nothing is its own row, in words, with no marker; a reply that quotes a passage is placed like any quote", () => {
    const reply = m({ id: "r", relation: "stub" });
    const rows = buildReception([{ mention: reply, result: { kind: "quotes", version: 1, quotes: [] } }, entry(m({ id: "q", relation: "stub" }), [{ kind: "passage", text: "bold words and a link" }])], ps);
    expect(rows.map((r) => r.placement.kind)).toEqual(["reply", "paragraph"]);
    expect(markersOf(rows).size).toBe(1);
    expect(placementNote(rows[0]!.placement)).toBe("a reply, with no quote");
    expect(leadOf(reply)).toBe("Teo replied to this");
  });
  it("two quotes by one post are two rows; two posts in one paragraph share one marker", () => {
    const rows = buildReception([entry(m({ id: "a" }), [{ kind: "passage", text: "First paragraph about gardens." }, { kind: "passage", text: "Last one." }]), entry(m({ id: "b" }), [{ kind: "passage", text: "first paragraph about gardens" }])], ps);
    expect(rows).toHaveLength(3);
    expect(markersOf(rows).get(0)).toHaveLength(2);
  });
  it("names who quoted", () => {
    expect(leadOf(m())).toBe("Teo quoted this");
    expect(leadOf(m({ sourceAuthorName: null }))).toBe("b.example quoted this");
  });
});

describe("ReceptionStore", () => {
  const inbound = (over: Partial<InboundMention> = {}): InboundMention => ({ ...m(), ...over });
  const make = (list: () => Promise<{ mentions: InboundMention[]; complete: boolean } | null>, md = `![[${ID}]]\n> hello there friend\n`) => {
    let t = 0;
    let asked = 0;
    const asks: string[] = [];
    const lookup = new MarginaliaLookup(async () => ({ version: 1, markdown: md, withdrawn: false }), parseQuotesOf);
    const store = new ReceptionStore({ mentions: (id) => { asked++; asks.push(id); return list(); }, now: () => t }, lookup);
    return { store, tick: (ms: number) => { t += ms; }, asked: () => asked, asks };
  };
  const settled = (store: ReceptionStore): Promise<void> => new Promise((r) => { const off = store.subscribe(() => { off(); r(); }); });

  it("loads once, says loading meanwhile, then ready; the Studio is asked for this item's mentions (and again for another item)", async () => {
    const { store, asked, asks } = make(async () => ({ mentions: [inbound()], complete: true }));
    const done = settled(store);
    store.request(ID);
    expect(store.peek(ID)).toEqual({ kind: "loading" });
    await done;
    const s = store.peek(ID);
    expect(s?.kind).toBe("ready");
    store.request(ID);
    expect(asked()).toBe(1);
    const other = settled(store);
    store.request("another-item");
    await other;
    expect(asks).toEqual([ID, "another-item"]);
  });
  it("a failed Studio is failed, never an empty ready list", async () => {
    const { store } = make(async () => null);
    const done = settled(store);
    store.request(ID);
    await done;
    expect(store.peek(ID)?.kind).toBe("failed");
  });
  it("a failed refresh keeps the earlier good answer", async () => {
    let fail = false;
    const { store, tick } = make(async () => (fail ? null : { mentions: [inbound()], complete: true }));
    let done = settled(store);
    store.request(ID);
    await done;
    fail = true;
    tick(10 * 60_000);
    store.invalidate();
    done = settled(store);
    store.request(ID);
    await done;
    expect(store.peek(ID)?.kind).toBe("failed");
  });
});
