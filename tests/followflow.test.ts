// "Blygs I follow" (HK7): the steps behind the modal and the post's "Follow this blyg" row, against the fake Studio. Placeholder hosts only.
import { describe, expect, it } from "vitest";
import { followAddress, followBlyg, followedName, followFailure, followText, loadFollowed, proposeFollow, confirmFollow, renameFollowed, statusLine, unfollow, unfollowQuestion } from "../src/app/followFlow";
import { studioAddress } from "../src/studio/address";
import { createStudioClient } from "../src/studio/client";
import { createStudioHttp } from "../src/studio/http";
import type { StudioFollowed } from "../src/studio/subscriptions";
import { isUnfollowedPost } from "../src/ui/readerFollow";
import { idleTimers } from "./helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./studio/fake-studio";

function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return { studio, client };
}
const BLYG = "https://your-blyg.example.com/";
const posts = (studio: FakeStudio): number => studio.seen.filter((s) => s.method === "POST").length;
const sub = (over: Partial<StudioFollowed> = {}): StudioFollowed => ({ id: "s1", kind: "blyg", origin: BLYG, feedUrl: `${BLYG}feed.xml`, title: "Your Blyg", status: "active", lastPollAt: null, failCount: 0, titleFollowsSource: true, hopperFeedUrl: null, ...over });

describe("the words", () => {
  it("a 403 says which permission is missing", () => {
    expect(followFailure({ kind: "forbidden", message: "x" }, "owner:manage")).toContain("the token needs owner:manage");
    expect(followFailure({ kind: "forbidden", message: "x" }, "owner:read")).toContain("the token needs owner:read");
  });
  it("the unfollow question says what the Studio deletes and what stays", () => {
    const q = unfollowQuestion("Your Blyg");
    expect(q.title).toBe("Unfollow Your Blyg?");
    for (const part of ["posts it imported", "hopper memberships", "thumbs", "read marks", "Your own posts", "not those memberships and marks"]) expect(q.body).toContain(part);
  });
  it("an address is taken as pasted, and only a web address", () => {
    expect(followAddress(`  <${BLYG}?utm=x> `)).toBe(`${BLYG}?utm=x`);
    expect(followAddress("your blyg")).toBeNull();
    expect(followAddress("ftp://x.example.com/")).toBeNull();
  });
  it("a subscription is named by its title, else its host; the status is the Studio's", () => {
    expect(followedName(sub())).toBe("Your Blyg");
    expect(followedName(sub({ title: " " }))).toBe("your-blyg.example.com");
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(statusLine(sub(), now)).toBe("Active · not fetched yet");
    expect(statusLine(sub({ lastPollAt: "2026-11-20T10:00:00Z" }), now)).toBe("Active · fetched 2 h ago");
    expect(statusLine(sub({ status: "paused" }), now)).toBe("Paused: the Studio fetches nothing");
    expect(statusLine(sub({ status: "degraded", failCount: 3 }), now)).toBe("Trouble: the last 3 fetches failed");
    expect(statusLine(sub({ kind: "rss" }), now)).toContain("feed");
    expect(statusLine(sub({ hopperFeedUrl: `${BLYG}h.xml` }), now)).toContain("one hopper only");
  });
});

describe("following, renaming, unfollowing", () => {
  it("not an address: nothing is sent", async () => {
    const { studio, client } = setup();
    expect(await proposeFollow(client, "your blyg")).toEqual({ ok: false, message: followText.notAnAddress });
    expect(studio.seen.filter((s) => s.path.startsWith("/api/subscriptions"))).toEqual([]);
  });
  it("propose creates nothing; confirm creates; the list shows it", async () => {
    const { studio, client } = setup();
    const asked = await proposeFollow(client, BLYG);
    expect(asked).toMatchObject({ ok: true, value: { url: BLYG, proposal: { kind: "blyg" } } });
    expect(studio.followed).toEqual([]);
    expect(await confirmFollow(client, BLYG)).toMatchObject({ ok: true, value: { origin: BLYG } });
    expect(await loadFollowed(client)).toMatchObject({ ok: true, value: { subscriptions: [{ origin: BLYG }] } });
  });
  it("following one already followed says so", async () => {
    const { client } = setup();
    await confirmFollow(client, BLYG);
    expect(await proposeFollow(client, BLYG)).toEqual({ ok: false, message: followText.already });
  });
  it("rename: an empty name is refused before any request; null hands the name back", async () => {
    const { studio, client } = setup();
    const made = await confirmFollow(client, BLYG);
    const id = made.ok ? made.value.id : "";
    const before = studio.seen.length;
    expect(await renameFollowed(client, id, "  ")).toEqual({ ok: false, message: followText.emptyName });
    expect(studio.seen.length).toBe(before);
    expect(await renameFollowed(client, id, " Mine ")).toMatchObject({ ok: true, value: { title: "Mine", titleFollowsSource: false } });
    expect(await renameFollowed(client, id, null)).toMatchObject({ ok: true, value: { titleFollowsSource: true } });
  });
  it("unfollow removes it; one that is gone is said to be gone", async () => {
    const { studio, client } = setup();
    const made = await confirmFollow(client, BLYG);
    const id = made.ok ? made.value.id : "";
    expect(await unfollow(client, id)).toEqual({ ok: true, value: null });
    expect(studio.followed).toEqual([]);
    expect(await unfollow(client, id)).toEqual({ ok: false, message: followText.gone });
  });
  it("without owner:manage every change says so, and listing still works", async () => {
    const { studio, client } = setup();
    const made = await confirmFollow(client, BLYG);
    const id = made.ok ? made.value.id : "";
    studio.manage = false;
    for (const got of [await confirmFollow(client, "https://other.example.com/"), await renameFollowed(client, id, "x"), await unfollow(client, id)]) {
      expect(got.ok).toBe(false);
      expect(got.ok ? "" : got.message).toContain("the token needs owner:manage");
    }
    expect((await loadFollowed(client)).ok).toBe(true);
  });
  it("a network failure is a message, not a throw", async () => {
    const { studio, client } = setup();
    studio.forced.set("DELETE /api/subscriptions/s1", new Error("offline"));
    expect(await unfollow(client, "s1")).toEqual({ ok: false, message: followText.unreachable });
  });
});

describe("Follow this blyg on a post", () => {
  it("a plain blyg is followed at once, by its own address", async () => {
    const { studio, client } = setup();
    expect(await followBlyg(client, BLYG)).toEqual({ kind: "followed", title: "Proposed blyg" });
    expect(studio.followed).toHaveLength(1);
    expect(posts(studio)).toBe(2); // the proposal, then the confirmation
  });
  it("one already followed is said to be", async () => {
    const { client } = setup();
    await followBlyg(client, BLYG);
    expect(await followBlyg(client, BLYG)).toEqual({ kind: "already" });
  });
  it("a hopper, a feed or an address of another site is not followed by the tap: the full screen shows it first", async () => {
    for (const proposal of [{ kind: "hopper", hopper: { title: "H", page: "p", feedUrl: "f" }, blygTitle: "B" }, { kind: "rss" }, { kind: "blyg", siteMismatch: { asserted: "https://a.example.com/", actual: "https://b.example.com/" } }]) {
      const { studio, client } = setup();
      studio.forced.set("POST /api/subscriptions", { status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify({ needsConfirm: true, origin: BLYG, feedUrl: `${BLYG}feed.xml`, title: "T", ...proposal }) });
      expect(await followBlyg(client, BLYG)).toEqual({ kind: "modal", url: BLYG });
      expect(posts(studio)).toBe(1);
      expect(studio.followed).toEqual([]);
    }
  });
  it("a 403 is a problem that names owner:manage; nothing is created", async () => {
    const { studio, client } = setup();
    studio.manage = false;
    const out = await followBlyg(client, BLYG);
    expect(out.kind === "problem" && out.message).toContain("the token needs owner:manage");
    expect(studio.followed).toEqual([]);
  });
  it("only a post of a blyg that nothing holds, and that is not yours, gets the row", () => {
    expect(isUnfollowedPost({ subscriptionId: "", origin: BLYG })).toBe(true);
    expect(isUnfollowedPost({ subscriptionId: "s1", origin: BLYG })).toBe(false);
    expect(isUnfollowedPost({ subscriptionId: "", origin: BLYG, own: true })).toBe(false);
    expect(isUnfollowedPost({ subscriptionId: "", origin: null })).toBe(false);
  });
});
