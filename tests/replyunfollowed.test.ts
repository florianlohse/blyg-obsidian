// Reply on a post of a blyg the Studio does not read (HK7/HK6): a plain reply (a link, no quote), and never a quote passage. Held posts are unchanged.
import { describe, expect, it } from "vitest";
import { followText } from "../src/app/followFlow";
import { replyPlan } from "../src/app/replyToPost";
import { studioAddress } from "../src/studio/address";
import { createStudioClient } from "../src/studio/client";
import { createStudioHttp } from "../src/studio/http";
import { stubTargetOf } from "../src/studio/lookup";
import type { ReadingPost } from "../src/studio/reading";
import { selectionNotQuoted, unfollowedReplyTitle } from "../src/ui/readerFollow";
import { idleTimers } from "./helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./studio/fake-studio";

const BLYG = "https://your-blyg.example.com/";
const post = (over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "", subscriptionTitle: "", origin: BLYG, remoteId: "abc123fakeid", kind: "fragment", withdrawn: false, version: 3, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "<p>Their words.</p>", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });

describe("replyPlan", () => {
  it("a post of an unfollowed blyg: no subscription, not quotable, and the selection is dropped", () => {
    const plan = replyPlan(post(), "Their words", "Their words.");
    expect(plan.selection).toBeUndefined();
    expect(plan.pick).toMatchObject({ subscriptionId: null, quotable: false, origin: BLYG, id: "abc123fakeid", version: 3 });
    expect(plan.pick.label).toBe("your-blyg.example.com: Their words.");
  });
  it("a held post keeps its subscription, stays quotable and keeps the selection", () => {
    const plan = replyPlan(post({ subscriptionId: "s1", subscriptionTitle: "Your Blyg" }), "Their words", "Their words.");
    expect(plan.selection).toBe("Their words");
    expect(plan.pick).toMatchObject({ subscriptionId: "s1", quotable: true, label: "Your Blyg" });
  });
  it("the words the reader shows say what Reply does and that a selection is not quoted", () => {
    expect(followText.unfollowedNote).toContain("Reply sends a link without a quote");
    expect(followText.unfollowedNote).toContain("Not followed"); // was "…Follow it to reply with a quote": the row is one line now, the Follow link says the rest
    expect(unfollowedReplyTitle).toContain("without a quote");
    expect(selectionNotQuoted).toContain("not quoted");
  });
});

describe("the reply target of such a post", () => {
  it("is made from what the post carries, with no question to the Studio about a subscription", async () => {
    const studio = new FakeStudio();
    const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
    if (!address) throw new Error("address");
    const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
    const { pick } = replyPlan(post(), undefined, "Their words.");
    const got = await stubTargetOf(client, address, pick);
    expect(got).toEqual({ ok: true, target: { origin: BLYG, id: "abc123fakeid", version: 3, label: pick.label } });
    expect(studio.seen.filter((s) => s.path.startsWith("/api/"))).toEqual([]);
  });
});
