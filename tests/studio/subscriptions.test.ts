// "Blygs I follow" at the client (HK7 part 1): list, follow (propose, then confirm), rename, unfollow. Results are ok / forbidden / not-found / rejected / error,
// as pollSubscriptions does. Unfollowing a blyg also drops its imported posts in the Studio; the fake does the same, and the test pins that.
import { describe, expect, it } from "vitest";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { readFollowed, readProposal, UNFOLLOW_EFFECT } from "../../src/studio/subscriptions";
import { idleTimers } from "../helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./fake-studio";

function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return { studio, client };
}
const ADDRESS = "https://blog-b.test/";

describe("following a blyg", () => {
  it("a first call only proposes: nothing is created until confirm", async () => {
    const { studio, client } = setup();
    const proposed = await client.createSubscription(ADDRESS);
    expect(proposed).toMatchObject({ kind: "ok", value: { state: "proposal", proposal: { kind: "blyg", origin: ADDRESS } } });
    expect(studio.followed).toEqual([]);
    expect(studio.seen.find((s) => s.method === "POST")?.body).toEqual({ url: ADDRESS });
  });

  it("confirm creates it, and it is listed", async () => {
    const { client } = setup();
    const made = await client.createSubscription(ADDRESS, { confirm: true });
    expect(made).toMatchObject({ kind: "ok", value: { state: "created", subscription: { origin: ADDRESS, status: "active", titleFollowsSource: true } } });
    const listed = await client.listSubscriptions();
    expect(listed).toMatchObject({ kind: "ok", value: { complete: true, subscriptions: [{ origin: ADDRESS }] } });
  });

  it("following the same blyg twice is refused by the Studio (409, rejected, not a crash)", async () => {
    const { client } = setup();
    await client.createSubscription(ADDRESS, { confirm: true });
    expect(await client.createSubscription(ADDRESS, { confirm: true })).toMatchObject({ kind: "rejected", status: 409, code: "already-subscribed" });
  });

  it("an address the Studio cannot read is rejected with its own words", async () => {
    const { client } = setup();
    expect(await client.createSubscription("not an address")).toMatchObject({ kind: "rejected", status: 422 });
  });

  it("a token without owner:manage gets forbidden on every write, and can still list", async () => {
    const { studio, client } = setup();
    const made = await client.createSubscription(ADDRESS, { confirm: true });
    const id = made.kind === "ok" && made.value.state === "created" ? made.value.subscription.id : "";
    studio.manage = false;
    expect((await client.createSubscription("https://blog-c.test/", { confirm: true })).kind).toBe("forbidden");
    expect((await client.updateSubscription(id, { title: "x" })).kind).toBe("forbidden");
    expect((await client.deleteSubscription(id)).kind).toBe("forbidden");
    expect((await client.listSubscriptions()).kind).toBe("ok");
    expect(studio.followed).toHaveLength(1);
  });

  it("lists past one page", async () => {
    const { studio, client } = setup();
    for (let i = 0; i < 130; i++) studio.followed.push({ id: `s${i}`, origin: `https://b${i}.test/`, kind: "blyg", feedUrl: "", title: `B${i}`, status: "active", lastPollAt: null, failCount: 0, titleFollowsSource: true, hopperFeedUrl: null });
    const listed = await client.listSubscriptions();
    expect(listed.kind === "ok" && listed.value.subscriptions.length).toBe(130);
  });
});

describe("renaming and unfollowing", () => {
  it("a name of your own sticks; null hands it back to the source", async () => {
    const { client } = setup();
    const made = await client.createSubscription(ADDRESS, { confirm: true });
    const id = made.kind === "ok" && made.value.state === "created" ? made.value.subscription.id : "";
    expect(await client.updateSubscription(id, { title: "My name" })).toMatchObject({ kind: "ok", value: { title: "My name", titleFollowsSource: false } });
    expect(await client.updateSubscription(id, { title: null })).toMatchObject({ kind: "ok", value: { titleFollowsSource: true } });
  });

  it("renaming or deleting one the Studio does not have is not-found", async () => {
    const { client } = setup();
    expect((await client.updateSubscription("nope", { title: "x" })).kind).toBe("not-found");
    expect((await client.deleteSubscription("nope")).kind).toBe("not-found");
  });

  it("unfollowing removes the subscription, and its imported posts go with it", async () => {
    const { studio, client } = setup();
    const made = await client.createSubscription(ADDRESS, { confirm: true });
    const id = made.kind === "ok" && made.value.state === "created" ? made.value.subscription.id : "";
    studio.importItem({ remote_id: "095s4h48j67mnbf6hq8vatc2d4", content_md: "Theirs.", origin: ADDRESS, subscription_id: id });
    expect(await client.deleteSubscription(id)).toEqual({ kind: "ok", value: { ok: true } });
    expect(studio.followed).toEqual([]);
    expect(studio.imports).toEqual([]);
  });

  it("the confirmation facts are the ones recorded from the Studio's source", () => {
    expect(UNFOLLOW_EFFECT.removed.join(" ")).toMatch(/imported posts.*hopper memberships/);
    expect(UNFOLLOW_EFFECT.kept).toContain("the owner's own items");
  });
});

describe("reading what the Studio answers", () => {
  it("a row without an id or origin is not a subscription; unknown status reads as active", () => {
    expect(readFollowed({ origin: "https://x.test/" })).toBeNull();
    expect(readFollowed({ id: "a" })).toBeNull();
    expect(readFollowed({ id: "a", origin: "https://x.test/", status: "weird" })?.status).toBe("active");
    expect(readFollowed({ id: "a", origin: "https://x.test/", status: "degraded", failCount: 3 })).toMatchObject({ status: "degraded", failCount: 3 });
  });
  it("a proposal needs needsConfirm and a title; a hopper proposal keeps both names", () => {
    expect(readProposal({ kind: "blyg", title: "T" })).toBeNull();
    expect(readProposal({ needsConfirm: true, kind: "blyg" })).toBeNull();
    expect(readProposal({ needsConfirm: true, kind: "hopper", title: "H", blygTitle: "Whole", hopper: { title: "Reading", page: "p", feedUrl: "f" } })).toMatchObject({ kind: "hopper", blygTitle: "Whole", hopperTitle: "Reading" });
  });
  it("an answer that is not the expected form is an error, never a guess", async () => {
    const { studio, client } = setup();
    studio.forced.set("POST /api/subscriptions", { status: 201, text: JSON.stringify({ nope: true }), headers: { "content-type": "application/json" } });
    expect((await client.createSubscription(ADDRESS, { confirm: true })).kind).toBe("error");
  });
});
