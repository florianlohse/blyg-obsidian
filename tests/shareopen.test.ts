// Opening a post from an address that came from outside (HK6): the share-inbox note or the clipboard. One function, against the fake Studio.
// Placeholder hosts and ids only.
import { describe, expect, it } from "vitest";
import { inShareInbox, openSharedText, shareText } from "../src/app/shareOpen";
import { studioAddress } from "../src/studio/address";
import { createStudioClient } from "../src/studio/client";
import { createStudioHttp } from "../src/studio/http";
import type { ReadingPost } from "../src/studio/reading";
import { idleTimers } from "./helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_ORIGIN, STUDIO_TOKEN } from "./studio/fake-studio";

const ID = "095s4h48j67mnbf6hq8vatc2d4";
function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  const shown: ReadingPost[] = [];
  const own: string[] = [];
  const deps = { client, address, showPost: async (p: ReadingPost) => void shown.push(p), openOwn: async (id: string) => (own.push(id), id !== "missing") };
  return { studio, deps, shown, own };
}
const apiCalls = (studio: FakeStudio): number => studio.seen.filter((s) => s.path.startsWith("/api/")).length;

describe("a shared note or the clipboard names a post", () => {
  it("no address: refused, and the Studio is not asked", async () => {
    const { studio, deps, shown } = setup();
    expect(await openSharedText("Just the page text.", deps)).toEqual({ kind: "refused", message: shareText.none });
    expect(shown).toEqual([]);
    expect(apiCalls(studio)).toBe(0);
  });
  it("two different addresses: refused, nothing opened", async () => {
    const { studio, deps, shown } = setup();
    const text = `[a](https://blog-b.test/f/${ID}/) and https://blog-c.test/t/${ID}/`;
    expect(await openSharedText(text, deps)).toEqual({ kind: "refused", message: shareText.several(2) });
    expect(shown).toEqual([]);
    expect(apiCalls(studio)).toBe(0);
  });
  it("a URL-only share note (one markdown link) of a post of a blyg the Studio does not read opens it, as an unfollowed post", async () => {
    const { studio, deps, shown } = setup();
    studio.peekable.push({ origin: "https://blog-c.test/", id: ID, kind: "fragment", version: 2, content_html: "<p>Their words.</p>" });
    expect(await openSharedText(`[A title — Blog C](https://blog-c.test/f/${ID}/)`, deps, () => 0)).toEqual({ kind: "opened" });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ subscriptionId: "", subscriptionTitle: "blog-c.test", origin: "https://blog-c.test/", remoteId: ID, version: 2, kind: "fragment", withdrawn: false, readVersion: null, contentHtml: "<p>Their words.</p>" });
  });
  it("a post of a blyg the Studio reads opens as a held post, with the blyg's title", async () => {
    const { studio, deps, shown } = setup();
    studio.importItem({ remote_id: ID, content_md: "Held words.", origin: "https://blog-b.test/" });
    expect(await openSharedText(`https://blog-b.test/f/${ID}/?utm_source=share`, deps)).toEqual({ kind: "opened" });
    expect(shown[0]).toMatchObject({ subscriptionId: "sub1", subscriptionTitle: "Blog B", remoteId: ID });
  });
  it("one of your own posts opens its note, or says there is none", async () => {
    const { studio, deps, shown, own } = setup();
    const item = studio.seed({ content_md: "Mine.", status: "public", version: 1 });
    expect(await openSharedText(`${STUDIO_ORIGIN}t/${item.id}/`, deps)).toEqual({ kind: "opened" });
    expect(own).toEqual([item.id]);
    expect(shown).toEqual([]);
    const gone = studio.seed({ content_md: "Mine too.", status: "public", version: 1 });
    deps.openOwn = async () => false;
    expect(await openSharedText(`${STUDIO_ORIGIN}f/${gone.id}/`, deps)).toEqual({ kind: "refused", message: shareText.ownNoNote });
  });
  it("an address the Studio cannot place is refused with the Studio's words, and nothing is opened", async () => {
    const { deps, shown } = setup();
    const out = await openSharedText(`https://blog-z.test/f/${ID}/`, deps);
    expect(out.kind).toBe("refused");
    expect(shown).toEqual([]);
  });
  it("a Studio that cannot be reached is a message, not a throw", async () => {
    const { studio, deps, shown } = setup();
    studio.forced.set("POST /api/peek/links", new Error("offline"));
    expect(await openSharedText(`https://blog-c.test/f/${ID}/`, deps)).toEqual({ kind: "refused", message: shareText.unreachable });
    expect(shown).toEqual([]);
  });
});

describe("the share inbox", () => {
  it("empty folder: off; otherwise a markdown file inside it, not outside, not another file type", () => {
    expect(inShareInbox("Share inbox/A.md", "")).toBe(false);
    expect(inShareInbox("Share inbox/A.md", "Share inbox")).toBe(true);
    expect(inShareInbox("Share inbox/sub/A.md", "/Share inbox/")).toBe(true);
    expect(inShareInbox("Share inbox/A.png", "Share inbox")).toBe(false);
    expect(inShareInbox("Other/A.md", "Share inbox")).toBe(false);
    expect(inShareInbox("Share inbox two/A.md", "Share inbox")).toBe(false);
    expect(inShareInbox("Share inbox.md", "Share inbox")).toBe(false);
  });
});
