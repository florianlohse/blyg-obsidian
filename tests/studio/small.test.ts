import { describe, expect, it } from "vitest";
import { studioAddress, studioBaseProblem, studioItemUrl, studioMountProblem } from "../../src/studio/address";
import { expiryVerdict, tokenExpiry, tokenScopes } from "../../src/studio/jwt";
import { createPendingDrafts, MAX_PENDING, readPending, withPending, type PendingDraft } from "../../src/studio/pending";
import { readStudioRecord, sameOrigin } from "../../src/studio/record";
import { CONTRACT_TEXT, contractVerdict, MIN_STUDIO_VERSION, studioVersionVerdict } from "../../src/studio/version";
import { makeToken } from "./fake-studio";

describe("address", () => {
  it("accepts a host, https, or http on this machine only", () => {
    expect(studioBaseProblem("https://blyg.example.com")).toBeNull();
    expect(studioBaseProblem("https://blyg.example.com/")).toBeNull();
    expect(studioBaseProblem("http://localhost:8787")).toBeNull();
    expect(studioBaseProblem("http://127.0.0.1:8787")).toBeNull();
    expect(studioBaseProblem("http://blyg.example.com")).toMatch(/https/);
    expect(studioBaseProblem("blyg.example.com")).toMatch(/address like/);
    expect(studioBaseProblem("https://user:pw@blyg.example.com")).toMatch(/user name/);
    expect(studioBaseProblem("https://blyg.example.com/blyg")).toMatch(/Only the host/);
    expect(studioBaseProblem("https://blyg.example.com/?x=1")).toMatch(/query/);
  });
  it("accepts an empty mount or a path", () => {
    for (const ok of ["", "/blyg", "/a/b", "/my-blyg_2"]) expect(studioMountProblem(ok)).toBeNull();
    for (const bad of ["blyg", "/blyg/", "/", "//x", "/a/../b", "/a b"]) expect(studioMountProblem(bad)).not.toBeNull();
  });
  it("derives the identity, the API base and item pages", () => {
    const a = studioAddress({ baseUrl: "https://blyg.example.com/", mount: "/blyg" });
    expect(a).toEqual({ host: "https://blyg.example.com", mount: "/blyg", origin: "https://blyg.example.com/blyg/", apiBase: "https://blyg.example.com/api" });
    if (a) {
      expect(studioItemUrl(a, "fragment", "abc")).toBe("https://blyg.example.com/blyg/f/abc/");
      expect(studioItemUrl(a, "thread", "abc")).toBe("https://blyg.example.com/blyg/t/abc/");
    }
    expect(studioAddress({ baseUrl: "", mount: "" })).toBeNull();
    expect(studioAddress({ baseUrl: "https://x.example", mount: "bad" })).toBeNull();
  });
});

describe("token expiry and scopes (read from the token itself, never verified)", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  const at = (days: number): number => Math.floor(now.getTime() / 1000) + days * 86400 + 60;
  it("reads exp and scope", () => {
    const t = makeToken({ expSeconds: at(30), scope: "owner:read owner:publish" });
    expect(tokenExpiry(t)?.toISOString()).toBe("2026-11-21T00:01:00.000Z");
    expect(tokenScopes(t)).toEqual(["owner:read", "owner:publish"]);
  });
  it("says ok, soon (from five days before), expired, or unknown", () => {
    expect(expiryVerdict(makeToken({ expSeconds: at(30) }), now)).toEqual({ kind: "ok", days: 30 });
    expect(expiryVerdict(makeToken({ expSeconds: at(5) }), now)).toEqual({ kind: "soon", days: 5 });
    expect(expiryVerdict(makeToken({ expSeconds: at(1) }), now)).toEqual({ kind: "soon", days: 1 });
    expect(expiryVerdict(makeToken({ expSeconds: at(-1) }), now)).toEqual({ kind: "expired" });
    expect(expiryVerdict("not-a-jwt", now)).toEqual({ kind: "unknown" });
  });
  it("junk is null, never a throw", () => {
    for (const junk of ["", "a.b", "a.b.c", "a.!!!.c", `a.${btoa("[]")}.c`, `a.${btoa('{"exp":"soon"}')}.c`]) {
      expect(tokenExpiry(junk)).toBeNull();
    }
    expect(tokenScopes(`a.${btoa('{"scope":3}')}.c`)).toBeNull();
  });
});

describe("the manifest's generator", () => {
  it("names a stock Studio by its release, anything else is an unknown client", () => {
    expect(studioVersionVerdict("blygger-studio/0.51.0")).toEqual({ kind: "stock", version: "0.51.0" });
    expect(studioVersionVerdict("blygger-studio/1.0.0-rc.1")).toEqual({ kind: "stock", version: "1.0.0" });
    expect(studioVersionVerdict("some-fork/1.0")).toEqual({ kind: "unknown-client", generator: "some-fork/1.0" });
    expect(studioVersionVerdict("")).toEqual({ kind: "unknown-client", generator: "" });
  });
});

describe("the contract gate's verdict (contractVersion, not the release number)", () => {
  it("supports major 5; the tested minors (5.2 to 5.4: Studio 0.51.0 to 0.53.0) give no notice, a higher minor is accepted and flagged", () => {
    for (const v of ["5.1.0", "5.2.0", "5.3.0", "5.3.1", "5.4.0", "5.4.9"]) expect(contractVerdict(v), v).toEqual({ kind: "ok", contract: v, newerMinor: false });
    expect(contractVerdict("5.5.0")).toEqual({ kind: "ok", contract: "5.5.0", newerMinor: true });
    expect(contractVerdict("5.12.0")).toEqual({ kind: "ok", contract: "5.12.0", newerMinor: true });
    expect(CONTRACT_TEXT).toBe("5.4");
    expect(MIN_STUDIO_VERSION).toBe("0.51.0");
  });
  it("a lower major still refuses, whatever its minor", () => {
    expect(contractVerdict("4.99.0")).toEqual({ kind: "studio-older", contract: "4.99.0" });
  });
  it("an older major, or anything that is not major.minor.patch, means the Studio is older", () => {
    expect(contractVerdict("4.9.0")).toEqual({ kind: "studio-older", contract: "4.9.0" });
    for (const bad of [null, "", "5", "5.2", "five", "5.2.0-rc1", "v5.2.0"]) expect(contractVerdict(bad)).toEqual({ kind: "studio-older", contract: null });
  });
  it("a newer major means the plugin is older", () => {
    expect(contractVerdict("6.0.0")).toEqual({ kind: "plugin-older", contract: "6.0.0" });
  });
});

describe("origins", () => {
  it("compare as addresses", () => {
    expect(sameOrigin("https://x.example/", "https://X.example")).toBe(true);
    expect(sameOrigin("https://x.example/blyg/", "https://x.example/")).toBe(false);
    expect(sameOrigin("junk", "junk ")).toBe(true);
  });
  it("a record needs an id and an origin that match", () => {
    const vault = (fm: Record<string, unknown>) => ({ blygId: () => fm.blyg_id, frontmatterValue: (_n: unknown, k: string) => fm[k] });
    const note = { path: "a.md", name: "a.md", extension: "md" };
    const id = "a0000000000000000000000001";
    expect(readStudioRecord(vault({}), note, "https://x.example/")).toEqual({ kind: "none" });
    expect(readStudioRecord(vault({ blyg_id: id, blyg_origin: "https://x.example", blyg_version: 3, blyg_sent: "sha256:a", blyg_withdrawn: true }), note, "https://x.example/")).toEqual({ kind: "this", id, version: 3, sent: "sha256:a", withdrawn: true });
    expect(readStudioRecord(vault({ blyg_id: id }), note, "https://x.example/")).toEqual({ kind: "other", id, origin: null });
    expect(readStudioRecord(vault({ blyg_id: id, blyg_origin: "https://y.example/" }), note, "https://x.example/")).toEqual({ kind: "other", id, origin: "https://y.example/" });
    expect(readStudioRecord(vault({ blyg_origin: "https://x.example/" }), note, "https://x.example/").kind).toBe("invalid");
    expect(readStudioRecord(vault({ blyg_id: 12, blyg_origin: "https://x.example/" }), note, "https://x.example/").kind).toBe("invalid");
    expect(readStudioRecord(vault({ blyg_id: id, blyg_origin: "https://x.example/", blyg_version: "2" }), note, "https://x.example/")).toMatchObject({ kind: "this", version: null, sent: null });
  });
});

describe("pending drafts", () => {
  const draft = (n: number): PendingDraft => ({ origin: "https://x.example/", id: `a${n}`, kind: "fragment", at: `2026-10-22T08:${String(n % 60).padStart(2, "0")}:00Z` });
  it("ignores junk and keeps only well-formed entries", () => {
    expect(readPending(null)).toEqual({});
    expect(readPending([draft(1)])).toEqual({});
    expect(readPending({ "a.md": draft(1), "b.md": { id: 3 }, "c.md": "x" })).toEqual({ "a.md": draft(1) });
  });
  it("drops the oldest beyond the limit", () => {
    let map: Record<string, PendingDraft> = {};
    for (let i = 0; i < MAX_PENDING + 5; i++) map = withPending(map, `n${i}.md`, { ...draft(1), at: new Date(Date.UTC(2026, 9, 22, 8, 0, i)).toISOString() });
    expect(Object.keys(map)).toHaveLength(MAX_PENDING);
    expect(map["n0.md"]).toBeUndefined();
    expect(map[`n${MAX_PENDING + 4}.md`]).toBeDefined();
  });
  it("reads and writes through the data file without touching other keys", async () => {
    let data: Record<string, unknown> = { published: { keep: true } };
    const store = createPendingDrafts({
      read: () => Promise.resolve(data.studioDrafts),
      change: (edit) => {
        const copy = { ...data };
        edit(copy);
        data = copy;
        return Promise.resolve();
      },
    });
    expect(await store.get("a.md")).toBeNull();
    await store.set("a.md", draft(1));
    expect(await store.get("a.md")).toEqual(draft(1));
    await store.clear("a.md");
    expect(await store.get("a.md")).toBeNull();
    expect(data.published).toEqual({ keep: true });
  });
});
