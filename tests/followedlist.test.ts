// The "Sources" list (app/followedList.ts): the kept list is shown first, one silent read per opening replaces it, a failed read keeps it, and a follow, an
// unfollow or a rename update it from the Studio's answer without another read. Invented names only.
import { describe, expect, it, vi } from "vitest";
import { FollowedList, FOLLOWED_ROWS, followedCacheOf, parseFollowedCache, type FollowedCache, type FollowedStore } from "../src/app/followedList";
import type { StudioFollowed } from "../src/studio/subscriptions";
import type { StudioClient } from "../src/studio/client";

const ORIGIN = "https://studio.example.com";
const sub = (id: string, over: Partial<StudioFollowed> = {}): StudioFollowed => ({ id, kind: "blyg", origin: `https://${id}.example.com/`, feedUrl: `https://${id}.example.com/feed.xml`, title: `Blyg ${id}`, status: "active", lastPollAt: "2030-01-01T00:00:00Z", failCount: 0, titleFollowsSource: true, hopperFeedUrl: null, ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(kept: FollowedCache | null, answerOrFn: unknown) {
  const answer = (): unknown => (typeof answerOrFn === "function" ? (answerOrFn as () => unknown)() : answerOrFn);
  const writes: Array<{ ids: string[]; complete: boolean }> = [];
  const store: FollowedStore = { read: async () => kept, write: (s, complete) => void writes.push({ ids: s.map((x) => x.id), complete }) };
  const listSubscriptions = vi.fn(async () => answer());
  const client = { listSubscriptions } as unknown as StudioClient;
  const changes: string[] = [];
  let list!: FollowedList;
  list = new FollowedList({ store, build: () => ({ ok: true, studio: { client } }), now: () => 1_000_000, onChange: () => changes.push(`${list.fresh.kind}:${(list.subs ?? []).map((s) => s.id).join(",")}`) });
  return { list, listSubscriptions, writes, changes };
}
const ok = (...ids: string[]) => ({ kind: "ok", value: { subscriptions: ids.map((i) => sub(i)), complete: true } });

describe("the Sources list", () => {
  it("shows the kept list first, then replaces it with the one read", async () => {
    let release!: (v: unknown) => void;
    const t = setup({ subscriptions: [sub("a")], complete: true, savedAt: 940_000 }, () => new Promise((r) => (release = r)));
    const opened = t.list.open();
    await flush();
    expect(t.list.subs?.map((s) => s.id)).toEqual(["a"]); // at once, before the answer
    expect(t.list.fresh).toEqual({ kind: "updating", savedAt: 940_000 });
    expect(t.listSubscriptions).toHaveBeenCalledTimes(1);
    release(ok("a", "b"));
    await opened;
    expect(t.list.subs?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(t.list.fresh).toEqual({ kind: "updated", at: 1_000_000 });
    expect(t.writes.at(-1)).toEqual({ ids: ["a", "b"], complete: true });
  });
  it("with nothing kept the list stays empty (null) until the answer", async () => {
    const t = setup(null, ok("a"));
    await t.list.open();
    expect(t.changes[0]).toBe("updating:");
    expect(t.list.subs?.map((s) => s.id)).toEqual(["a"]);
  });
  it("a failed read keeps the kept list and says it could not update; there is no second request", async () => {
    const t = setup({ subscriptions: [sub("a")], complete: true, savedAt: 940_000 }, () => ({ kind: "error", status: 503, message: "" }));
    await t.list.open();
    expect(t.list.subs?.map((s) => s.id)).toEqual(["a"]);
    expect(t.list.fresh).toMatchObject({ kind: "failed", savedAt: 940_000 });
    await flush();
    expect(t.listSubscriptions).toHaveBeenCalledTimes(1);
    expect(t.writes).toEqual([]); // the kept file is not overwritten by a failure
  });
  it("a read that throws (offline) is the same as a failure", async () => {
    const t = setup(null, () => Promise.reject(new Error("offline")));
    await t.list.open();
    expect(t.list.subs).toBeNull();
    expect(t.list.fresh.kind).toBe("failed");
  });
  it("one request per opening: opening again does nothing, and a list that is closed asks nothing", async () => {
    const t = setup(null, ok("a"));
    await t.list.open();
    await t.list.open();
    expect(t.listSubscriptions).toHaveBeenCalledTimes(1);
    const closed = setup(null, ok("a"));
    closed.list.close();
    await closed.list.open();
    expect(closed.listSubscriptions).not.toHaveBeenCalled();
  });
  it("nothing is asked before the screen is opened", () => {
    const t = setup(null, ok("a"));
    expect(t.listSubscriptions).not.toHaveBeenCalled();
    expect(t.list.subs).toBeNull();
  });
  it("follow, rename and unfollow update the list and the kept file at once, with no read", async () => {
    const t = setup({ subscriptions: [sub("a"), sub("b")], complete: true, savedAt: 1 }, ok("a", "b"));
    await t.list.open();
    t.listSubscriptions.mockClear();
    t.list.upsert(sub("c"));
    expect(t.list.subs?.map((s) => s.id)).toEqual(["a", "b", "c"]);
    t.list.upsert(sub("a", { title: "New name", titleFollowsSource: false }));
    expect(t.list.subs?.[0]?.title).toBe("New name");
    t.list.remove("b");
    expect(t.list.subs?.map((s) => s.id)).toEqual(["a", "c"]);
    expect(t.writes.at(-1)?.ids).toEqual(["a", "c"]);
    expect(t.listSubscriptions).not.toHaveBeenCalled();
  });
  it("an unfollow made while the read is on its way is not undone by its answer", async () => {
    let release!: (v: unknown) => void;
    const t = setup({ subscriptions: [sub("a"), sub("b")], complete: true, savedAt: 1 }, () => new Promise((r) => (release = r)));
    const opened = t.list.open();
    await flush();
    t.list.remove("b");
    release(ok("a", "b")); // the older answer still has b
    await opened;
    expect(t.list.subs?.map((s) => s.id)).toEqual(["a"]);
  });
  it("an answer that arrives after the screen was closed is kept, and nothing is drawn", async () => {
    let release!: (v: unknown) => void;
    const t = setup(null, () => new Promise((r) => (release = r)));
    const opened = t.list.open();
    await flush();
    const drawn = t.changes.length;
    t.list.close();
    release(ok("a"));
    await opened;
    expect(t.writes.at(-1)?.ids).toEqual(["a"]);
    expect(t.changes.length).toBe(drawn);
  });
});

describe("the kept file", () => {
  it("is only used for the Studio it came from", () => {
    const file = followedCacheOf([sub("a")], true, ORIGIN, 5);
    expect(parseFollowedCache(file, ORIGIN)?.subscriptions.map((s) => s.id)).toEqual(["a"]);
    expect(parseFollowedCache(file, "https://other.example.com")).toBeNull();
    expect(parseFollowedCache({ v: 2 }, ORIGIN)).toBeNull();
    expect(parseFollowedCache("nope", ORIGIN)).toBeNull();
  });
  it("caps the rows and the words, and rebuilds every field", () => {
    const many = Array.from({ length: FOLLOWED_ROWS + 20 }, (_, i) => sub(`s${i}`));
    expect(followedCacheOf(many, true, ORIGIN, 1).subscriptions).toHaveLength(FOLLOWED_ROWS);
    const long = followedCacheOf([sub("a", { title: "x".repeat(5000) })], true, ORIGIN, 1);
    expect(long.subscriptions[0]?.title).toHaveLength(200);
    const raw = { v: 1, origin: ORIGIN, savedAt: 1, complete: false, subscriptions: [{ id: "a", origin: "https://a.example.com/", title: 7, status: "weird", extra: "<b>" }, { origin: "no id" }, null] };
    const got = parseFollowedCache(raw, ORIGIN);
    expect(got?.complete).toBe(false);
    expect(got?.subscriptions).toEqual([expect.objectContaining({ id: "a", title: "", status: "active", kind: "blyg", hopperFeedUrl: null })]);
    expect(got?.subscriptions[0]).not.toHaveProperty("extra");
  });
});
