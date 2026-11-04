// The reader of the site's item documents (docs/SECURITY.md §3): public https only, no credentials, never cached, bounded.
import { describe, expect, it } from "vitest";
import { HttpError, type RawRequest, type RawResponse } from "../src/platform/http";
import { createSiteReader, MAX_BODY_CHARS, publicHttpsUrl } from "../src/platform/siteReader";
import { idleTimers, instantTimers } from "./helpers";

const reader = (answer: Partial<RawResponse> | Error, requests: RawRequest[] = [], timers = idleTimers) =>
  createSiteReader({
    transport: (req) => {
      requests.push(req);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ status: 200, headers: {}, text: "", ...answer });
    },
    timers,
    nonce: () => "n1",
  });

describe("publicHttpsUrl", () => {
  it("accepts a public https address", () => {
    expect(publicHttpsUrl("https://example.com/blyg/items/x.json")?.href).toBe("https://example.com/blyg/items/x.json");
    // near misses stay public: only the exact private suffixes count
    for (const ok of ["https://homey.example/", "https://lan.example.org/", "https://corporate.example/", "https://my.home.example/"]) expect(publicHttpsUrl(ok), ok).not.toBeNull();
  });
  it.each([
    "http://example.com/",
    "ftp://example.com/",
    "https://user:pw@example.com/",
    "https://localhost/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://192.168.1.10/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost./",
    "https://printer.local./",
    "https://db.internal./",
    "https://LocalHost../",
    "https://[::ffff:127.0.0.1]/",
    // names that only mean something on a local network (review P7)
    "https://router/",
    "https://router./",
    "https://nas.lan/",
    "https://host.home.arpa/",
    "https://box.localdomain/",
    "https://wiki.corp/",
    "https://tv.home/",
    "https://wiki.corp./",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://169.254.169.254/",
    "not a url",
    "",
  ])("refuses %s", (url) => expect(publicHttpsUrl(url)).toBeNull());
});

describe("the site reader", () => {
  it("sends no credentials, asks every cache for a fresh answer, and makes the URL unique", async () => {
    const requests: RawRequest[] = [];
    const res = await reader({ text: '{"a":1}' }, requests).getJson("https://example.com/blyg/items/x.json");
    expect(res).toEqual({ status: 200, json: { a: 1 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.com/blyg/items/x.json?_=n1");
    expect(requests[0]?.method).toBe("GET");
    const headers = Object.keys(requests[0]?.headers ?? {}).map((h) => h.toLowerCase());
    expect(headers).not.toContain("authorization");
    expect(requests[0]?.headers["Cache-Control"]).toBe("no-cache");
  });

  it("refuses an address that is not a public https one, without a request", async () => {
    const requests: RawRequest[] = [];
    await expect(reader({}, requests).getJson("http://example.com/x.json")).rejects.toThrow(HttpError);
    await expect(reader({}, requests).getJson("https://10.0.0.1/x.json")).rejects.toThrow(/public site/);
    expect(requests).toEqual([]);
  });

  it("hands back a status and no JSON for a non-JSON answer, rather than throwing", async () => {
    expect(await reader({ status: 404, text: "<html>nope</html>" }).getJson("https://example.com/x.json")).toEqual({ status: 404, json: undefined });
  });

  it("will not read an unreasonably large answer", async () => {
    await expect(reader({ text: "x".repeat(MAX_BODY_CHARS + 1) }).getJson("https://example.com/x.json")).rejects.toThrow(/unreasonably large/);
  });

  it("turns a network failure and a timeout into an HttpError", async () => {
    await expect(reader(new Error("offline")).getJson("https://example.com/x.json")).rejects.toThrow(/Network error: offline/);
    const slow = createSiteReader({ transport: () => new Promise(() => {}), timers: instantTimers });
    await expect(slow.getJson("https://example.com/x.json")).rejects.toThrow(/did not answer/);
  });
});
