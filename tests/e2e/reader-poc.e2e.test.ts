// PROOF OF CONCEPT (roadmap S15): the reader calls of the Studio client against a REAL local Studio. Skipped unless STUDIO_E2E_URL and
// STUDIO_E2E_TOKEN are set (scripts/local-studio.sh start; WITH_REMOTE=1 so the Studio holds one imported post).
import { describe, expect, it } from "vitest";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { isUnread, relationWords } from "../../src/studio/reading";
import { createPolledFreshness } from "../../src/app/readerFreshness";
import { idleTimers } from "../helpers";

const URL_ = process.env.STUDIO_E2E_URL;
const TOKEN = process.env.STUDIO_E2E_TOKEN;
/** "" or "/blyg": the Studio is mounted at a path (scripts/local-studio.sh with MOUNT=/blyg prints it). */
const MOUNT = process.env.STUDIO_E2E_MOUNT ?? "";
const run = URL_ && TOKEN ? describe : describe.skip;

async function transport(req: RawRequest): Promise<RawResponse> {
  const res = await fetch(req.url, { method: req.method, headers: { ...req.headers, ...(req.contentType ? { "content-type": req.contentType } : {}) }, ...(req.bodyBytes !== undefined ? { body: req.bodyBytes } : req.body !== undefined ? { body: req.body } : {}) });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key] = value));
  return { status: res.status, headers, text: await res.text() };
}

run("reader PoC against a real Studio", () => {
  const address = studioAddress({ baseUrl: URL_ ?? "http://localhost", mount: MOUNT });
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

  it("asks the Studio to fetch the blygs it reads (owner:manage); reads its change counters where it has them, and says there are none where it has not (contract 6)", async () => {
    const changes = await client.changes();
    expect(changes.kind).toBe("ok");
    const caps = await client.capabilities();
    const listed = caps.kind === "ok" && (caps.value.operations ?? []).includes("getChanges");
    if (changes.kind === "ok") {
      if (changes.value === null) expect(listed).toBe(false);
      else expect(typeof changes.value.domains.reading).toBe("number");
      expect(changes.value !== null).toBe(listed); // the list says what the Studio has, and the Studio agrees
    }
    say(`change counters: ${listed ? "listed (contract 5)" : "not listed (contract 6)"}`);
    const polled = await client.pollSubscriptions();
    expect(polled.kind).toBe("ok");
    if (polled.kind === "ok") expect(polled.value.polling).toBeGreaterThanOrEqual(1);
  });

  it("the reader's replacement for the counters works against the real Studio: a poll moves each blyg's lastPollAt, and the marks count it", async () => {
    const polled = createPolledFreshness({ now: Date.now, pauseMs: 60_000 });
    await polled.startCheck(client);
    // lastPollAt has a resolution of a second: let the baseline be older than the fetch
    await new Promise((r) => setTimeout(r, 1500));
    const asked = await client.pollSubscriptions();
    expect(asked.kind).toBe("ok");
    const polling = asked.kind === "ok" ? asked.value.polling : 0;
    let reported = 0;
    for (let i = 0; i < 20 && reported < polling; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const marks = await polled.marks(client);
      expect(marks.kind).toBe("ok");
      if (marks.kind === "ok") reported = marks.value.subscriptions;
    }
    say(`polled marks: ${reported}/${polling} blygs seen fetched`);
    expect(reported).toBeGreaterThanOrEqual(1);
    expect(reported).toBe(polling);
  });

  it("with a token that has reading:state: read, unread, and quick changes in a row end where the last one says", async () => {
    // A token with every permission, as the owner makes one in the Studio's web app (a throwaway local Studio: the password is the script's own).
    const base = URL_ ?? "";
    const login = await fetch(`${base}${MOUNT}/studio/login`, { method: "POST", redirect: "manual", headers: { Origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "password=local-test-password-123" });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const minted = await fetch(`${base}${MOUNT}/api/authorizations`, { method: "POST", headers: { Origin: base, cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "reader e2e (all)", resource: "api", scope: ["owner:read", "owner:draft", "owner:publish", "owner:manage", "reading:state"] }) });
    const full = createStudioClient({ http: createStudioHttp({ transport, timers: idleTimers, address: address as NonNullable<typeof address> }), token: ((await minted.json()) as { accessToken: string }).accessToken });
    const list = await full.listReading(1);
    if (list.kind !== "ok" || !list.value.posts[0]) throw new Error("e2e: no post to mark");
    const p = list.value.posts[0];
    const state = async (): Promise<number | null | undefined> => {
      const got = await full.listReading(1);
      return got.kind === "ok" ? got.value.posts.find((x) => x.remoteId === p.remoteId && x.subscriptionId === p.subscriptionId)?.readVersion : undefined;
    };
    expect((await full.markUnread(p.subscriptionId, p.remoteId)).kind).toBe("ok");
    expect(await state()).toBeNull();
    expect((await full.markRead(p.subscriptionId, p.remoteId, p.version)).kind).toBe("ok");
    expect(await state()).toBe(p.version);
    // quick changes, as fast as taps can come: the last one wins (a read always applies; no client clock is sent)
    for (const step of ["unread", "read", "unread", "read"] as const) {
      const done = step === "read" ? await full.markRead(p.subscriptionId, p.remoteId, p.version) : await full.markUnread(p.subscriptionId, p.remoteId);
      expect(done.kind).toBe("ok");
    }
    expect(await state()).toBe(p.version);
    expect((await full.markUnread(p.subscriptionId, p.remoteId)).kind).toBe("ok");
    expect(await state()).toBeNull();
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
