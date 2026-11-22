// The address in a share-sheet note (HK6): one address is taken, none or several are refused, and the result is what the existing address lookup
// (parseItemAddress / lookupAddress) takes. Placeholder hosts and ids only.
import { describe, expect, it } from "vitest";
import { studioAddress } from "../../src/studio/address";
import { extractSharedAddress } from "../../src/studio/sharedAddress";
import { parseItemAddress } from "../../src/studio/stub";

const POST = "https://your-blyg.example.com/t/abc123fakeid/";

describe("one address", () => {
  it("a note that is a single markdown link (URL-only share)", () => {
    expect(extractSharedAddress(`[A post title — your-blyg](${POST})`)).toEqual({ kind: "address", url: POST });
    expect(extractSharedAddress(`[A post title — your-blyg](${POST})\n`)).toEqual({ kind: "address", url: POST });
  });
  it("a bare address, with or without text around it", () => {
    expect(extractSharedAddress(POST)).toEqual({ kind: "address", url: POST });
    expect(extractSharedAddress(`Read this: ${POST}, it is good.`)).toEqual({ kind: "address", url: POST });
    expect(extractSharedAddress(`(${POST})`)).toEqual({ kind: "address", url: POST });
    expect(extractSharedAddress(`<${POST}>`)).toEqual({ kind: "address", url: POST });
  });
  it("the query and the fragment are dropped (share-sheet tracking)", () => {
    expect(extractSharedAddress(`${POST}?utm_source=share#top`)).toEqual({ kind: "address", url: POST });
  });
  it("a markdown link with an angled address or a title", () => {
    expect(extractSharedAddress(`[x](<${POST}>)`)).toEqual({ kind: "address", url: POST });
    expect(extractSharedAddress(`[x](${POST} "A title")`)).toEqual({ kind: "address", url: POST });
  });
  it("the same address named twice, in any form, counts once", () => {
    expect(extractSharedAddress(`[${POST}](${POST})\n\n${POST}?x=1`)).toEqual({ kind: "address", url: POST });
    expect(extractSharedAddress(`---\nurl: "${POST}"\n---\n[t](${POST})`)).toEqual({ kind: "address", url: POST });
  });
  it("a url property in the frontmatter alone", () => {
    expect(extractSharedAddress(`---\ntitle: T\nurl: ${POST}\n---\nBody text without a link.\n`)).toEqual({ kind: "address", url: POST });
    expect(extractSharedAddress(`---\r\nurl: '${POST}'\r\n---\r\n`)).toEqual({ kind: "address", url: POST });
  });
  it("image embeds do not count", () => {
    expect(extractSharedAddress(`![cover](https://cdn.example.com/a.png)\n[t](${POST})`)).toEqual({ kind: "address", url: POST });
  });
  it("what it returns is what the lookup takes: an own item path /t/<id>/ on the Studio's origin", () => {
    const studio = studioAddress({ baseUrl: "https://your-blyg.example.com", mount: "" });
    const got = extractSharedAddress(`[t](${POST})`);
    expect(got.kind === "address" && parseItemAddress(got.url, studio)).toEqual({ kind: "own", id: "abc123fakeid" });
  });
});

describe("fails closed", () => {
  it("no address", () => {
    expect(extractSharedAddress("")).toEqual({ kind: "none" });
    expect(extractSharedAddress("Just the page text, no link at all.")).toEqual({ kind: "none" });
    expect(extractSharedAddress("---\ntitle: T\n---\nBody")).toEqual({ kind: "none" });
    expect(extractSharedAddress("[a link](not-an-address)")).toEqual({ kind: "none" });
    expect(extractSharedAddress("![img](https://cdn.example.com/a.png)")).toEqual({ kind: "none" });
  });
  it("only web addresses count", () => {
    expect(extractSharedAddress("ftp://files.example.com/a and mailto:me@example.com and javascript:alert(1)")).toEqual({ kind: "none" });
    expect(extractSharedAddress("[x](javascript:alert(1))")).toEqual({ kind: "none" });
  });
  it("two different addresses are ambiguous, and none is chosen", () => {
    const other = "https://other-blyg.example.com/f/zzz999fakeid/";
    expect(extractSharedAddress(`[a](${POST}) quoting [b](${other})`)).toEqual({ kind: "ambiguous", count: 2 });
    expect(extractSharedAddress(`${POST}\n${other}`)).toEqual({ kind: "ambiguous", count: 2 });
    expect(extractSharedAddress(`---\nurl: ${other}\n---\n[a](${POST})`)).toEqual({ kind: "ambiguous", count: 2 });
  });
  it("the same item with a different path is a different address", () => {
    expect(extractSharedAddress(`${POST} ${POST.replace("/t/", "/f/")}`)).toEqual({ kind: "ambiguous", count: 2 });
  });
  it("a very long note is read only at its start", () => {
    expect(extractSharedAddress(`${"x ".repeat(15000)}${POST}`)).toEqual({ kind: "none" });
  });
});
