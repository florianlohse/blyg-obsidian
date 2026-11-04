import { describe, expect, it } from "vitest";
import { checkWebAddress, expandWebAddress, siteOrigin, slugOf } from "../src/core/webAddress";

const ctx = { site: "https://example.com", name: "Wrestling With Eels", path: "Wrestling With Eels" };

describe("slugOf (github-slugger's rule)", () => {
  it("lowercases, drops punctuation, turns spaces into hyphens", () => {
    expect(slugOf("Wrestling With Eels")).toBe("wrestling-with-eels");
    expect(slugOf("What's new? (2026)")).toBe("whats-new-2026");
    expect(slugOf("Already-hyphenated_name")).toBe("already-hyphenated_name");
  });
  it("keeps letters of other alphabets and umlauts", () => {
    expect(slugOf("Über Café")).toBe("über-café");
  });
});

describe("siteOrigin", () => {
  it("is the origin of the Blyg address; only https counts", () => {
    expect(siteOrigin("https://example.com/blyg/")).toBe("https://example.com");
    expect(siteOrigin("http://example.com/blyg/")).toBeUndefined();
    expect(siteOrigin("")).toBeUndefined();
    expect(siteOrigin("not a url")).toBeUndefined();
  });
});

describe("expandWebAddress", () => {
  it("fills {site}, {slug}, {name} and {path}", () => {
    expect(expandWebAddress("{site}/essays/{slug}/", ctx)).toBe("https://example.com/essays/wrestling-with-eels/");
    expect(expandWebAddress("{site}/e/{name}", ctx)).toBe("https://example.com/e/Wrestling%20With%20Eels");
    expect(expandWebAddress("{site}/{path}/", { ...ctx, path: "series/Part 1" })).toBe("https://example.com/series/Part%201/");
  });
  it("a literal https address works without any placeholder", () => {
    expect(expandWebAddress("https://other.example/essays/", ctx)).toBe("https://other.example/essays/");
  });
  it("is undefined for an empty template, a missing site, an unknown placeholder, or anything that is not https", () => {
    expect(expandWebAddress("", ctx)).toBeUndefined();
    expect(expandWebAddress("   ", ctx)).toBeUndefined();
    expect(expandWebAddress("{site}/x/", { ...ctx, site: undefined })).toBeUndefined();
    expect(expandWebAddress("{site}/{title}/", ctx)).toBeUndefined();
    expect(expandWebAddress("http://example.com/{slug}", ctx)).toBeUndefined();
    expect(expandWebAddress("javascript:alert(1)//{slug}", ctx)).toBeUndefined();
    expect(expandWebAddress("/essays/{slug}/", ctx)).toBeUndefined();
  });
  it("a note name cannot break out of the address", () => {
    const hostile = { ...ctx, name: "../../x?y=1#z", path: "../../x?y=1#z" };
    const url = expandWebAddress("{site}/essays/{name}/", hostile) ?? "";
    expect(new URL(url).origin).toBe("https://example.com");
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe("");
  });
});

describe("checkWebAddress (the settings screen's message)", () => {
  it("empty and good templates pass", () => {
    expect(checkWebAddress("")).toBeNull();
    expect(checkWebAddress("{site}/essays/{slug}/")).toBeNull();
    expect(checkWebAddress("https://example.com/essays/{name}/")).toBeNull();
  });
  it("says what is wrong", () => {
    expect(checkWebAddress("{site}/{title}/")).toContain("Unknown placeholder {title}");
    expect(checkWebAddress("essays/{slug}")).toContain("https://");
    expect(checkWebAddress("http://example.com/{slug}")).toContain("https://");
  });
});
