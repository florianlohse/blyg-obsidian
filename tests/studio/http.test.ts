import { describe, expect, it } from "vitest";
import { HttpError, type RawRequest, type RawResponse } from "../../src/platform/http";
import { studioAddress } from "../../src/studio/address";
import { createStudioHttp, MAX_RESPONSE_CHARS } from "../../src/studio/http";
import { idleTimers, instantTimers } from "../helpers";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2ln";
const address = (mount = "") => {
  const a = studioAddress({ baseUrl: "https://blyg.example.com", mount });
  if (!a) throw new Error("address");
  return a;
};

function scripted(answers: Array<Partial<RawResponse> | Error>) {
  const requests: RawRequest[] = [];
  const left = [...answers];
  const transport = (req: RawRequest): Promise<RawResponse> => {
    requests.push(req);
    const next = left.shift() ?? { status: 200, text: "{}" };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ status: 200, headers: {}, text: "", ...next });
  };
  return { transport, requests };
}

describe("studio http: where the token goes", () => {
  it("sends it in the Authorization header to {host}/api, and nowhere else", async () => {
    const t = scripted([{ text: '{"ok":true}' }]);
    const http = createStudioHttp({ transport: t.transport, timers: idleTimers, address: address("/blyg") });
    const res = await http.send(TOKEN, { method: "POST", area: "api", path: "/items", body: { a: 1 } });
    expect(res).toMatchObject({ status: 200, json: { ok: true } });
    expect(t.requests[0]).toMatchObject({ url: "https://blyg.example.com/api/items", method: "POST", body: '{"a":1}', contentType: "application/json" });
    expect(t.requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(t.requests[0]?.url).not.toContain(TOKEN);
  });

  it("the public manifest is read below the mount and without any credentials", async () => {
    const t = scripted([{ text: '{"blyg":"0.4"}' }]);
    const http = createStudioHttp({ transport: t.transport, timers: idleTimers, address: address("/blyg") });
    await http.send(TOKEN, { area: "public", path: "/blyg.json" });
    expect(t.requests[0]?.url).toBe("https://blyg.example.com/blyg/blyg.json");
    expect(t.requests[0]?.headers.Authorization).toBeUndefined();
  });

  it("reads are never answered from a cache", async () => {
    const t = scripted([{}]);
    await createStudioHttp({ transport: t.transport, timers: idleTimers, address: address() }).send(TOKEN, { area: "api", path: "/items/x" });
    expect(t.requests[0]?.headers["Cache-Control"]).toBe("no-cache");
  });

  it("refuses a missing, empty or spaced token for the API before any request", async () => {
    const t = scripted([]);
    const http = createStudioHttp({ transport: t.transport, timers: idleTimers, address: address() });
    for (const bad of [null, "", "   ", "two words"]) {
      await expect(http.send(bad, { area: "api", path: "/items" })).rejects.toThrow(/token is empty or contains spaces/);
    }
    expect(t.requests).toEqual([]);
  });

  it("refuses paths that could leave the Studio or smuggle a query", async () => {
    const t = scripted([]);
    const http = createStudioHttp({ transport: t.transport, timers: idleTimers, address: address() });
    for (const path of ["items", "//evil.example/x", "/a/../b", "/x?y=1", "/x#y", "/http://evil.example", "/a\\b", "/./x"]) {
      await expect(http.send(TOKEN, { area: "api", path })).rejects.toThrow(HttpError);
    }
    expect(t.requests).toEqual([]);
  });

  it("refuses to send the token when it would end up in the URL", async () => {
    const t = scripted([]);
    const http = createStudioHttp({ transport: t.transport, timers: idleTimers, address: address() });
    await expect(http.send(TOKEN, { area: "api", path: "/items", query: { q: TOKEN } })).rejects.toThrow(/never be part of a URL/);
  });
});

describe("studio http: trouble", () => {
  it("a timeout is an HttpError that names the Studio", async () => {
    const never = (): Promise<RawResponse> => new Promise(() => {});
    const http = createStudioHttp({ transport: never, timers: instantTimers, address: address(), timeoutMs: 5000 });
    await expect(http.send(TOKEN, { area: "api", path: "/items" })).rejects.toThrow("The Studio did not answer within 5 seconds.");
  });

  it("a network error is reported without the token", async () => {
    const t = scripted([new Error(`connect failed for Bearer ${TOKEN}`)]);
    const http = createStudioHttp({ transport: t.transport, timers: idleTimers, address: address() });
    const err = await http.send(TOKEN, { area: "api", path: "/items" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("ignores an answer far larger than any Studio answer", async () => {
    const t = scripted([{ text: "x".repeat(MAX_RESPONSE_CHARS + 1) }]);
    const http = createStudioHttp({ transport: t.transport, timers: idleTimers, address: address() });
    await expect(http.send(TOKEN, { area: "api", path: "/items" })).rejects.toThrow(/far larger than expected/);
  });

  it("waits as told on a 429 and tries again (the request was not processed), at most twice", async () => {
    const waits: number[] = [];
    const timers = { after: (ms: number, fn: () => void) => (ms !== 20_000 && waits.push(ms), ms !== 20_000 && queueMicrotask(fn), () => {}) };
    const t = scripted([{ status: 429, headers: { "Retry-After": "3" } }, { status: 429, headers: { "retry-after": "1" } }, { status: 200, text: '{"ok":true}' }]);
    const res = await createStudioHttp({ transport: t.transport, timers, address: address() }).send(TOKEN, { method: "POST", area: "api", path: "/items/x/publish", body: {} });
    expect(res.status).toBe(200);
    expect(t.requests).toHaveLength(3);
    expect(waits).toEqual([3000, 1000]);
  });

  it("gives up after three tries, and does not wait longer than 30 seconds", async () => {
    const timers = { after: (ms: number, fn: () => void) => (ms !== 20_000 && queueMicrotask(fn), () => {}) };
    const three = scripted([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200 }]);
    expect((await createStudioHttp({ transport: three.transport, timers, address: address() }).send(TOKEN, { area: "api", path: "/items" })).status).toBe(429);
    expect(three.requests).toHaveLength(3);
    const long = scripted([{ status: 429, headers: { "retry-after": "600" } }, { status: 200 }]);
    expect((await createStudioHttp({ transport: long.transport, timers, address: address() }).send(TOKEN, { area: "api", path: "/items" })).status).toBe(429);
    expect(long.requests).toHaveLength(1);
  });
});
