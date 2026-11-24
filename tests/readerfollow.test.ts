// The row under a post of an unfollowed blyg (HK7), drawn onto a tiny fake DOM: what it says, what the button does with each answer.
import { describe, expect, it, vi } from "vitest";
import { followText, type FollowOutcome } from "../src/app/followFlow";
import { drawFollowNote, type FollowHost } from "../src/ui/readerFollow";
import type { ReadingPost } from "../src/studio/reading";

class El {
  text = "";
  disabled = false;
  removed = false;
  children: El[] = [];
  handlers: Array<() => void> = [];
  constructor(public tag = "div", o?: { text?: string }) {
    this.text = o?.text ?? "";
  }
  createDiv(o?: { text?: string }) { return this.add(new El("div", o)); }
  createSpan(o?: { text?: string }) { return this.add(new El("span", o)); }
  createEl(tag: string, o?: { text?: string }) { return this.add(new El(tag, o)); }
  private add(e: El) { this.children.push(e); return e; }
  setText(t: string) { this.text = t; }
  remove() { this.removed = true; }
  addEventListener(_: string, h: () => void) { this.handlers.push(h); }
  click() { this.handlers.forEach((h) => h()); }
}
const BLYG = "https://your-blyg.example.com/";
const post = (over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "", subscriptionTitle: "", origin: BLYG, remoteId: "r1", kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });
const draw = (p: ReadingPost, out: FollowOutcome) => {
  const opened = vi.fn<(prefill?: string) => void>();
  const followed = vi.fn<(origin: string) => Promise<FollowOutcome>>(async () => out);
  const host: FollowHost = { openFollowed: (prefill) => opened(prefill), followBlyg: (origin) => followed(origin) };
  const parent = new El();
  const note = drawFollowNote(parent as unknown as HTMLElement, p, host) as unknown as El | null;
  return { opened, followed, parent, note };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the follow row", () => {
  it("is drawn for a post of an unfollowed blyg, with the line and the button", () => {
    const { note } = draw(post(), { kind: "already" });
    expect(note?.children[0]?.text).toContain(followText.unfollowedNote);
    expect(note?.children[1]?.text).toBe("Follow"); // was "Follow this blyg": a small link at the end of one muted line now
    expect(followText.followButtonLabel).toBe("Follow this blyg"); // the accessible name keeps the full words
  });
  it("is not drawn for a post that is held, or your own", () => {
    expect(draw(post({ subscriptionId: "s1" }), { kind: "already" }).note).toBeNull();
    expect(draw(post({ own: true }), { kind: "already" }).note).toBeNull();
  });
  it("after a follow the line says so and the button goes", async () => {
    const { note, followed } = draw(post(), { kind: "followed", title: "Your Blyg" });
    note?.children[1]?.click();
    await flush();
    expect(followed).toHaveBeenCalledWith(BLYG);
    expect(note?.children[0]?.text).toBe(followText.followingRow);
    expect(note?.children[1]?.removed).toBe(true);
  });
  it("a post that needs a look opens the full screen with its address; the button stays", async () => {
    const { note, opened } = draw(post(), { kind: "modal", url: BLYG });
    note?.children[1]?.click();
    await flush();
    expect(opened).toHaveBeenCalledWith(BLYG);
    expect(note?.children[1]?.removed).toBe(false);
    expect(note?.children[1]?.disabled).toBe(false);
  });
  it("a problem is said in the row and the button can be tapped again", async () => {
    const { note } = draw(post(), { kind: "problem", message: "Your token cannot follow or change blygs: the token needs owner:manage." });
    note?.children[1]?.click();
    await flush();
    expect(note?.children[0]?.text).toContain("the token needs owner:manage");
    expect(note?.children[1]?.disabled).toBe(false);
  });
});
