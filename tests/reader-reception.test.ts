// Reception at the foot of one of your own posts (feature `marginalia`): which mentions count, what a row says, what a tap does, onto a tiny fake DOM.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMention, ReadingPost } from "../src/studio/reading";
import { drawOwnReception, receptionOf, receptionTitle, RECEPTION_ROWS } from "../src/ui/readerReception";

class El {
  text = "";
  cls = "";
  children: El[] = [];
  handlers: Record<string, Array<(e?: unknown) => void>> = {};
  constructor(o?: { text?: string; cls?: string }) {
    this.text = o?.text ?? "";
    this.cls = o?.cls ?? "";
  }
  createDiv(o?: { text?: string; cls?: string }) { return this.add(new El(o)); }
  createSpan(o?: { text?: string; cls?: string }) { return this.add(new El(o)); }
  appendText(t: string) { this.text += t; }
  empty() { this.children = []; this.text = ""; }
  private add(e: El) { this.children.push(e); return e; }
  addEventListener(n: string, h: () => void) { (this.handlers[n] ??= []).push(h); }
  fire(n: string, e?: unknown) { this.handlers[n]?.forEach((h) => h(e)); }
  all(): string { return [this.text, ...this.children.map((c) => c.all())].join("|"); }
}
beforeEach(() => vi.stubGlobal("activeWindow", { getSelection: () => null }));

const own = (over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "own", subscriptionTitle: "", origin: "https://you.example.com", remoteId: "item-1", kind: "fragment", withdrawn: false, version: 1, readVersion: 1, observedAt: "", created: null, isReply: false, contentHtml: "<p>mine</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, own: true, ...over });
/** One fixed "now" for the file, and a distinct firstSeen per mention (m0 is the newest, each next one a second older): the order the section shows never depends on the clock ticking over between two calls. */
const T0 = Date.now();
const mention = (over: Partial<InboundMention> = {}): InboundMention => ({ id: "m1", targetItemId: "item-1", relation: "transclusion", status: "verified", hidden: false, sourceOrigin: "https://other.example.com", sourceId: "s1", sourcePage: null, sourceAuthorName: "Ada", firstSeen: new Date(T0 - 3 * 3600_000 - (Number(String(over.id ?? "m1").slice(1)) || 0) * 1000).toISOString(), ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("receptionOf", () => {
  it("is the visible mentions of this very item, and only for your own post", () => {
    const ms = [mention(), mention({ id: "m2", targetItemId: "other-item" }), mention({ id: "m3", hidden: true }), mention({ id: "m4", status: "failed" }), mention({ id: "m5", status: "gone" })];
    expect(receptionOf(own(), ms).map((m) => m.id)).toEqual(["m1"]);
    expect(receptionOf(own({ own: false }), ms)).toEqual([]);
    expect(receptionTitle(3)).toBe("Reception (3)");
  });
});

describe("the section", () => {
  const draw = (mentions: InboundMention[], post: (m: InboundMention) => ReadingPost | null = () => null) => {
    const col = new El();
    const open = vi.fn();
    const load = vi.fn(async () => undefined);
    const box = drawOwnReception(col as unknown as HTMLElement, own(), { mentions, post, load, open }) as unknown as El | null;
    return { col, box, open, load };
  };
  it("draws nothing when nobody quoted or answered the post", () => {
    expect(draw([]).box).toBeNull();
    expect(draw([mention({ targetItemId: "x" })]).col.children).toEqual([]);
  });
  it("lists who, what they did and when, with a count in the title, and asks for the post's text", () => {
    const { box, load } = draw([mention(), mention({ id: "m2", relation: "stub", sourceAuthorName: null, sourceOrigin: "https://b.example.org/x" })]);
    expect(box?.children[0]?.text).toBe("Reception (2)");
    const text = box?.all() ?? "";
    expect(text).toContain("Ada");
    expect(text).toContain("quoted you");
    expect(text).toContain("3 h ago");
    expect(text).toContain("b.example.org");
    expect(text).toContain("replied to you");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("shows a short excerpt of the mentioning post as plain text, and fills the row in when the lookup answers", async () => {
    let held: ReadingPost | null = null;
    const col = new El();
    const html = `<p>${"word ".repeat(80)}<b>end</b></p><img src="x.png" onerror="alert(1)">`;
    const load = async (): Promise<void> => { held = { ...own(), own: false, authorName: "Ada L.", contentHtml: html }; };
    const box = drawOwnReception(col as unknown as HTMLElement, own(), { mentions: [mention()], post: () => held, load, open: vi.fn() }) as unknown as El;
    expect(box.all()).not.toContain("word");
    await flush();
    const t = box.all();
    expect(t).toContain("Ada L.");
    expect(t).toContain("word");
    expect(t).toContain("…");
    expect(t).not.toContain("<");
    expect(t.length).toBeLessThan(400);
  });
  it("a tap opens the reply; a long list is cut and counted", () => {
    const many = Array.from({ length: RECEPTION_ROWS + 2 }, (_, i) => mention({ id: `m${i}` }));
    const { box, open } = draw(many);
    expect(box?.children).toHaveLength(1 + RECEPTION_ROWS + 1);
    expect(box?.children[box.children.length - 1]?.text).toBe("2 more in Mentions.");
    box?.children[1]?.fire("click");
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toMatchObject({ id: many[0]?.id });
  });
});
