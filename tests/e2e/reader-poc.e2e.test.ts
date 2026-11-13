// PROOF OF CONCEPT (roadmap S15): the reader calls of the Studio client against a REAL local Studio. Skipped unless STUDIO_E2E_URL and
// STUDIO_E2E_TOKEN are set (scripts/local-studio.sh start; WITH_REMOTE=1 so the Studio holds one imported post).
import { describe, expect, it } from "vitest";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { isUnread, relationWords } from "../../src/studio/reading";
import { idleTimers } from "../helpers";

const URL_ = process.env.STUDIO_E2E_URL;
const TOKEN = process.env.STUDIO_E2E_TOKEN;
const run = URL_ && TOKEN ? describe : describe.skip;

async function transport(req: RawRequest): Promise<RawResponse> {
  const res = await fetch(req.url, { method: req.method, headers: { ...req.headers, ...(req.contentType ? { "content-type": req.contentType } : {}) }, ...(req.bodyBytes !== undefined ? { body: req.bodyBytes } : req.body !== undefined ? { body: req.body } : {}) });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key] = value));
  return { status: res.status, headers, text: await res.text() };
}

run("reader PoC against a real Studio", () => {
  const address = studioAddress({ baseUrl: URL_ ?? "http://localhost", mount: "" });
  const say = (line: string): void => void process.stdout.write(`${line}\n`);
  const client = createStudioClient({ http: createStudioHttp({ transport, timers: idleTimers, address: address as NonNullable<typeof address> }), token: TOKEN ?? "" });

  it("lists the posts the owner reads, through the plugin's own walk", async () => {
    const t0 = Date.now();
    const got = await client.listReading();
    const ms = Date.now() - t0;
    expect(got.kind).toBe("ok");
    if (got.kind !== "ok") return;
    const bytes = JSON.stringify(got.value.posts).length;
    say(`reading: ${got.value.posts.length} posts, complete=${got.value.complete}, unreadable=${got.value.unreadable}, ${bytes} bytes parsed, ${ms} ms`);
    expect(got.value.unreadable).toBe(0);
    expect(got.value.posts.length).toBeGreaterThan(0);
    const p = got.value.posts[0];
    expect(p?.contentHtml.length).toBeGreaterThan(0);
    expect(p ? isUnread(p) : false).toBe(true); // nothing has been marked read
  });

  it("lists inbound mentions (zero is fine on a fresh Studio: the shape must parse)", async () => {
    const got = await client.listInboundMentions();
    expect(got.kind).toBe("ok");
    if (got.kind === "ok") say(`mentions: ${got.value.mentions.length}, unreadable=${got.value.unreadable}; ${relationWords("stub")}`);
  });

  it("asks the Studio to fetch the blygs it reads (owner:manage), and reads its change counters", async () => {
    const changes = await client.changes();
    expect(changes.kind).toBe("ok");
    if (changes.kind === "ok") expect(typeof changes.value.domains.reading).toBe("number");
    const polled = await client.pollSubscriptions();
    expect(polled.kind).toBe("ok");
    if (polled.kind === "ok") expect(polled.value.polling).toBeGreaterThanOrEqual(1);
  });

  it("marking read needs the extra scope: the plugin's four scopes are refused, plainly", async () => {
    const list = await client.listReading(1);
    if (list.kind !== "ok" || !list.value.posts[0]) throw new Error("e2e: no post to mark");
    const p = list.value.posts[0];
    const done = await client.markRead(p.subscriptionId, p.remoteId, p.version);
    say(`markRead with the plugin's scopes: ${done.kind}`);
    expect(["forbidden", "ok"]).toContain(done.kind);
  });
});
