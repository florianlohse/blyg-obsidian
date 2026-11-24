import { describe, expect, it } from "vitest";
import { LONG_PRESS_MS, LongPress, postEntries, storyEntries, type Timers } from "../../src/ui/quickActions";
import { unfollowedReplyTitle } from "../../src/ui/readerFollow";
import type { ReadingPost } from "../../src/studio/reading";

/** A fake clock: timers fire only when time is advanced. */
class Clock implements Timers {
  now = 0;
  private next = 1;
  private jobs = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): number {
    const id = this.next++;
    this.jobs.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(id: number): void {
    this.jobs.delete(id);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, j] of [...this.jobs]) if (j.at <= this.now) { this.jobs.delete(id); j.fn(); }
  }
}

const rig = () => {
  const clock = new Clock();
  const presses: Array<[number, number]> = [];
  return { clock, presses, lp: new LongPress(clock, (x, y) => presses.push([x, y])) };
};

describe("long press detector", () => {
  it("fires once after 450 ms of holding still, at the touch point", () => {
    const { clock, presses, lp } = rig();
    lp.start(1, 10, 20);
    clock.advance(LONG_PRESS_MS - 1);
    expect(presses).toHaveLength(0);
    clock.advance(1);
    expect(presses).toEqual([[10, 20]]);
    clock.advance(2000);
    expect(presses).toHaveLength(1);
  });
  it("a release before the time is a tap: nothing fires, and end() says so", () => {
    const { clock, presses, lp } = rig();
    lp.start(1, 0, 0);
    clock.advance(300);
    expect(lp.end()).toBe(false);
    clock.advance(1000);
    expect(presses).toHaveLength(0);
  });
  it("a release after the press says it fired (the click must be swallowed), once", () => {
    const { clock, lp } = rig();
    lp.start(1, 0, 0);
    clock.advance(500);
    expect(lp.end()).toBe(true);
    expect(lp.end()).toBe(false);
  });
  it("movement beyond the slop cancels; a small tremor does not", () => {
    const a = rig();
    a.lp.start(1, 0, 0);
    a.lp.move(1, 4, 4);
    a.clock.advance(450);
    expect(a.presses).toHaveLength(1);
    const b = rig();
    b.lp.start(1, 0, 0);
    b.clock.advance(200);
    b.lp.move(1, 0, 30);
    b.clock.advance(1000);
    expect(b.presses).toHaveLength(0);
    expect(b.lp.end()).toBe(false);
  });
  it("a scroll cancels", () => {
    const { clock, presses, lp } = rig();
    lp.start(1, 0, 0);
    clock.advance(100);
    lp.scroll();
    clock.advance(1000);
    expect(presses).toHaveLength(0);
  });
  it("a second finger, at the start or later, cancels", () => {
    const a = rig();
    a.lp.start(2, 0, 0);
    a.clock.advance(1000);
    expect(a.presses).toHaveLength(0);
    const b = rig();
    b.lp.start(1, 0, 0);
    b.lp.move(2, 0, 0);
    b.clock.advance(1000);
    expect(b.presses).toHaveLength(0);
  });
  it("a new touch starts afresh", () => {
    const { clock, presses, lp } = rig();
    lp.start(1, 0, 0);
    clock.advance(400);
    lp.start(1, 5, 5);
    clock.advance(400);
    expect(presses).toHaveLength(0);
    clock.advance(50);
    expect(presses).toEqual([[5, 5]]);
  });
});

const post = (o: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s1", remoteId: "a", version: 1, readVersion: null, own: false, withdrawn: false, origin: "https://example.com", subscriptionTitle: "Example", ...o }) as ReadingPost;
const ids = (e: Array<{ id: string }>): string[] => e.map((x) => x.id);

describe("entries per context", () => {
  it("a feed card or digest post: Open, Reply, Mark read (unread post)", () => {
    const e = postEntries(post());
    expect(e.map((x) => x.title)).toEqual(["Open", "Reply", "Mark read"]);
    expect(e.every((x) => x.icon !== "")).toBe(true);
    expect(e[1]?.disabled).toBeUndefined();
  });
  it("a read post offers Mark unread", () => {
    expect(postEntries(post({ readVersion: 1 })).map((x) => x.title)).toEqual(["Open", "Reply", "Mark unread"]);
  });
  it("a blyg you do not follow: plain reply with the detail view's tooltip, no mark", () => {
    const e = postEntries(post({ subscriptionId: "" }));
    expect(ids(e)).toEqual(["open", "reply"]);
    expect(e[1]?.disabled).toBeUndefined();
    expect(e[1]?.tooltip).toBe(unfollowedReplyTitle);
  });
  it("own and withdrawn posts: no mark; Reply disabled with its reason", () => {
    const own = postEntries(post({ own: true, subscriptionId: "" }));
    expect(ids(own)).toEqual(["open", "reply"]);
    expect(own[1]?.disabled).toBe(true);
    expect(own[1]?.tooltip).toMatch(/own post/);
    expect(postEntries(post({ withdrawn: true }))[1]?.disabled).toBe(true);
  });
  it("a post the Studio has not fetched: no mark, Reply disabled", () => {
    const e = postEntries(post(), { fetched: false });
    expect(ids(e)).toEqual(["open", "reply"]);
    expect(e[1]?.disabled).toBe(true);
  });
  it("a surface without the write path has no Mark or Reply", () => {
    expect(ids(postEntries(post(), { canMark: false, canReply: false }))).toEqual(["open"]);
  });
  // Changed on purpose (SH1). This test used to pin "no Bookmark entry exists (the plugin has no save path)": a save was left out because a PUT of a stale list could undo another
  // client's change. The save path now exists (studio/shelf.ts: read-modify-write of one change, sent with the revision, retried on a 409 from the Studio's own answer, bounded),
  // so the menu may hold "Save for later". What stays pinned: the entry exists only where the host has a shelf, never for a post no subscription holds, and never as a second kind of save.
  it("a Save entry exists only where the host has a shelf (SH1)", () => {
    expect(postEntries(post()).some((x) => /bookmark|save|shelf/i.test(x.title + x.id))).toBe(false); // a surface without a shelf: none
    expect(postEntries(post(), { shelf: { saved: false, full: false } }).find((x) => x.id === "save")).toEqual({ id: "save", title: "Save for later", icon: "bookmark" });
    const saved = postEntries(post(), { shelf: { saved: true, full: true } }).find((x) => /save/.test(x.id));
    expect(saved).toEqual({ id: "unsave", title: "Remove from saved", icon: "bookmark-minus" }); // removing is always possible, even on a full shelf
  });
  it("a full shelf shows Save disabled with the reason; the entry is not removed", () => {
    const entry = postEntries(post(), { shelf: { saved: false, full: true } }).find((x) => x.id === "save");
    expect(entry?.disabled).toBe(true);
    expect(entry?.tooltip).toMatch(/shelf is full \(50 posts\)/);
  });
  it("no Save for a post the Studio does not hold, an unfetched one, or a withdrawn one that is not saved; an unfollowed blyg's post has none", () => {
    const shelf = { saved: false, full: false };
    expect(postEntries(post({ subscriptionId: "", origin: "https://other.example.com/" }), { shelf }).some((x) => x.id === "save")).toBe(false);
    expect(postEntries(post(), { shelf, fetched: false }).some((x) => x.id === "save")).toBe(false);
    expect(postEntries(post({ withdrawn: true }), { shelf }).some((x) => x.id === "save")).toBe(false);
    expect(postEntries(post({ withdrawn: true }), { shelf: { saved: true, full: false } }).some((x) => x.id === "unsave")).toBe(true);
    expect(postEntries(post({ own: true, subscriptionId: "" }), { shelf }).some((x) => x.id === "save")).toBe(true); // your own post can be saved (it is `~own` on the shelf)
  });
  it("a story: Open first post, Mark story read; all read: Mark story unread", () => {
    const posts = [post({ remoteId: "a" }), post({ remoteId: "b" })];
    expect(storyEntries(posts).map((x) => x.title)).toEqual(["Open first post", "Mark story read"]);
    expect(storyEntries(posts.map((p) => post({ ...p, readVersion: 1 }))).map((x) => x.title)).toEqual(["Open first post", "Mark story unread"]);
    expect(ids(storyEntries(posts, { canMark: false }))).toEqual(["open"]);
    expect(storyEntries([])).toEqual([]);
  });
});
