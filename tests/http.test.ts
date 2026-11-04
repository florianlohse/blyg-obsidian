import { describe, expect, it } from "vitest";
import { createGithubHttp, encodePath, headerValue, HttpError, type RawRequest } from "../src/platform/http";
import { fakeGithub, idleTimers, instantTimers, json, TOKEN } from "./helpers";

describe("GitHub http adapter", () => {
  it("sends only to api.github.com, with the token in the Authorization header and nowhere else", async () => {
    const { http, requests } = fakeGithub(() => json(200, { ok: true }));
    const res = await http.send(TOKEN, { path: "/repos/o/r", query: { ref: "main" } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    const req = requests[0] as RawRequest;
    expect(new URL(req.url).origin).toBe("https://api.github.com");
    expect(req.url).toBe("https://api.github.com/repos/o/r?ref=main");
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.url).not.toContain(TOKEN);
    expect(req.body ?? "").not.toContain(TOKEN);
  });

  it("serialises bodies as JSON", async () => {
    const { http, requests } = fakeGithub(() => json(200, {}));
    await http.send(TOKEN, { method: "PUT", path: "/repos/o/r/contents/a.md", body: { message: "m" } });
    expect(requests[0]).toMatchObject({ method: "PUT", body: '{"message":"m"}', contentType: "application/json" });
  });

  it("refuses paths that could redirect the token to another host or smuggle a query", async () => {
    const { http, requests } = fakeGithub(() => json(200, {}));
    for (const path of ["https://evil.example/x", "//evil.example/x", "repos/o/r", "/repos/o/r?x=1", "/repos/o/r#frag", "/a://b", "/repos/../user", "/repos/./o", "/repos\\o"]) {
      await expect(http.send(TOKEN, { path })).rejects.toBeInstanceOf(HttpError);
    }
    expect(requests).toHaveLength(0);
  });

  it("refuses a token that would end up in the URL", async () => {
    const { http, requests } = fakeGithub(() => json(200, {}));
    await expect(http.send(TOKEN, { path: `/repos/o/${TOKEN}` })).rejects.toThrow(/never be part of a URL/);
    await expect(http.send(TOKEN, { path: "/repos/o/r", query: { leak: TOKEN } })).rejects.toThrow(/never be part of a URL/);
    expect(requests).toHaveLength(0);
  });

  it("refuses an empty token or one with spaces or line breaks (a bad paste)", async () => {
    const { http } = fakeGithub(() => json(200, {}));
    await expect(http.send("", { path: "/repos/o/r" })).rejects.toBeInstanceOf(HttpError);
    await expect(http.send("abc def", { path: "/repos/o/r" })).rejects.toBeInstanceOf(HttpError);
    await expect(http.send("abc\ndef", { path: "/repos/o/r" })).rejects.toBeInstanceOf(HttpError);
  });

  it("trims whitespace around an otherwise valid token", async () => {
    const { http, requests } = fakeGithub(() => json(200, {}));
    await http.send(`  ${TOKEN}\n`, { path: "/repos/o/r" });
    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns error statuses as responses, not exceptions", async () => {
    const { http } = fakeGithub(() => json(404, { message: "Not Found" }));
    expect((await http.send(TOKEN, { path: "/repos/o/r" })).status).toBe(404);
  });

  it("wraps network failures in an HttpError that does not contain the token", async () => {
    const { http } = fakeGithub(() => new Error(`connect failed for Bearer ${TOKEN}`));
    const err = await http.send(TOKEN, { path: "/repos/o/r" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toContain("Network error");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("times out when GitHub does not answer", async () => {
    const http = createGithubHttp({ transport: () => new Promise(() => {}), timers: instantTimers, timeoutMs: 5000 });
    await expect(http.send(TOKEN, { path: "/repos/o/r" })).rejects.toThrow(/did not answer within 5 seconds/);
  });

  it("cancels the timeout once the request has finished", async () => {
    let cancelled = 0;
    const http = createGithubHttp({
      transport: () => Promise.resolve({ status: 200, headers: {}, text: "{}" }),
      timers: { after: () => () => void cancelled++ },
    });
    await http.send(TOKEN, { path: "/repos/o/r" });
    expect(cancelled).toBe(1);
  });

  it("logs method, host, path and status but never the token", async () => {
    const lines: string[] = [];
    const http = createGithubHttp({
      transport: () => Promise.resolve({ status: 200, headers: {}, text: "{}" }),
      timers: idleTimers,
      logger: { debug: (m) => lines.push(m), warn: (m) => lines.push(m) },
    });
    await http.send(TOKEN, { path: "/repos/o/r" });
    expect(lines).toEqual(["GET api.github.com/repos/o/r", "GET api.github.com/repos/o/r → 200"]);
  });

  it("reads response headers case-insensitively", () => {
    expect(headerValue({ "X-RateLimit-Remaining": "0" }, "x-ratelimit-remaining")).toBe("0");
    expect(headerValue({}, "x")).toBeUndefined();
  });

  it("encodes repo paths per segment, keeping slashes", () => {
    expect(encodePath("src/content/essays/a b&c,d.md")).toBe("src/content/essays/a%20b%26c%2Cd.md");
    expect(encodePath("src/Ünï/ö.md")).toBe("src/%C3%9Cn%C3%AF/%C3%B6.md");
  });
});
