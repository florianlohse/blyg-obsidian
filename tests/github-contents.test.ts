import { describe, expect, it } from "vitest";
import { createContentsClient } from "../src/github/contents";
import { HttpError } from "../src/platform/http";
import { b64 } from "./world";
import { fakeGithub, json, TOKEN } from "./helpers";

const client = (handler: Parameters<typeof fakeGithub>[0]) => {
  const g = fakeGithub(handler);
  return { ...g, client: createContentsClient({ http: g.http, token: TOKEN, owner: "o", repo: "r", nonce: () => "n1" }) };
};

describe("contents client", () => {
  it("getFile decodes the content and returns the sha; the path is encoded per segment and the ref is a query", async () => {
    const { client: c, requests } = client(() => json(200, { sha: "abc", content: b64("Prüfung 🌿\n") + "\n", encoding: "base64", type: "file" }));
    expect(await c.getFile("src/content/essays/Über Äpfel & Co, 1.md", "main")).toEqual({ kind: "found", sha: "abc", text: "Prüfung 🌿\n" });
    expect(requests[0]?.url).toBe("https://api.github.com/repos/o/r/contents/src/content/essays/%C3%9Cber%20%C3%84pfel%20%26%20Co%2C%201.md?ref=main&_=n1");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers["Cache-Control"]).toBe("no-cache");
  });

  it("getFile maps 404, other statuses, folders and unreadable (large) files to typed results", async () => {
    expect(await client(() => json(404, {})).client.getFile("a", "main")).toEqual({ kind: "not-found" });
    expect(await client(() => json(500, { message: "boom" })).client.getFile("a", "main")).toEqual({ kind: "error", status: 500, message: "boom" });
    const folder = await client(() => json(200, [{ name: "x" }])).client.getFile("a", "main");
    expect(folder.kind).toBe("error");
    expect(JSON.stringify(folder)).toMatch(/folder/);
    const large = await client(() => json(200, { sha: "s", content: "", encoding: "none" })).client.getFile("a", "main");
    expect(large.kind).toBe("error");
    expect(JSON.stringify(large)).toMatch(/too large/);
  });

  it("listDir returns the entry names", async () => {
    const { client: c } = client(() => json(200, [{ name: "a.png" }, { name: "b.jpg" }, { nope: 1 }]));
    expect(await c.listDir("public/attachments", "main")).toEqual({ kind: "found", names: ["a.png", "b.jpg"] });
    expect(await client(() => json(404, {})).client.listDir("x", "main")).toEqual({ kind: "not-found" });
    expect(await client(() => json(200, { name: "file" })).client.listDir("x", "main")).toMatchObject({ kind: "error" });
  });

  it("putFile sends message, base64 content, branch and (for updates) the sha", async () => {
    const { client: c, requests } = client(() => json(201, { content: { sha: "new" } }));
    expect(await c.putFile({ path: "a/b.md", text: "ü", message: "m", branch: "preview" })).toEqual({ kind: "ok", created: true, sha: "new" });
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ message: "m", content: "w7w=", branch: "preview" });
    await c.putFile({ path: "a/b.md", text: "x", message: "m", branch: "main", sha: "old" });
    expect(JSON.parse(requests[1]?.body ?? "")).toMatchObject({ sha: "old" });
    expect(requests[1]?.method).toBe("PUT");
  });

  it("putFile maps 200 (update), 409/422 (conflict), 404 and other statuses", async () => {
    expect(await client(() => json(200, { content: { sha: "s" } })).client.putFile({ path: "a", text: "", message: "", branch: "b" })).toMatchObject({ kind: "ok", created: false });
    for (const status of [409, 422]) {
      expect(await client(() => json(status, {})).client.putFile({ path: "a", text: "", message: "", branch: "b" })).toEqual({ kind: "conflict", status });
    }
    expect(await client(() => json(404, {})).client.putFile({ path: "a", text: "", message: "", branch: "b" })).toEqual({ kind: "not-found" });
    expect(await client(() => json(403, { message: "no" })).client.putFile({ path: "a", text: "", message: "", branch: "b" })).toEqual({ kind: "error", status: 403, message: "no" });
  });

  it("never lets the token into a returned message, and lets network failures throw", async () => {
    const leaky = client(() => json(500, { message: `bad credentials ${TOKEN}` }));
    expect(JSON.stringify(await leaky.client.getFile("a", "main"))).not.toContain(TOKEN);
    const down = client(() => new Error("offline"));
    await expect(down.client.getFile("a", "main")).rejects.toBeInstanceOf(HttpError);
  });
});

describe("fresh reads", () => {
  it("every read has its own URL by default; writes are not cache-busted and carry no cache headers", async () => {
    const g = fakeGithub(() => json(200, { sha: "s", content: "", encoding: "base64" }));
    const c = createContentsClient({ http: g.http, token: TOKEN, owner: "o", repo: "r" });
    await c.getFile("a.md", "main");
    await c.getFile("a.md", "main");
    await c.listDir("dir", "main");
    const urls = g.requests.map((r) => r.url);
    expect(new Set(urls).size).toBe(3);
    expect(urls.every((u) => new URL(u).searchParams.get("_"))).toBe(true);
    await c.putFile({ path: "a.md", text: "x", message: "m", branch: "main" });
    const put = g.requests.at(-1);
    expect(new URL(put?.url ?? "").searchParams.get("_")).toBeNull();
    expect(put?.headers["Cache-Control"]).toBeUndefined();
  });
});
