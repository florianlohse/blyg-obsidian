import { describe, expect, it } from "vitest";
import { canonicalDigests, canonicalImage, canonicalizeStudioMedia, findImageRefs, replaceRefs, withStudioAddresses } from "../../src/core/images";

const SHA = "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77";

describe("findImageRefs", () => {
  it("finds Obsidian embeds with and without a description", () => {
    const refs = findImageRefs("a\n![[photo.png]]\nb ![[sub/Pic.JPG|a red door]]");
    expect(refs.map((r) => [r.form, r.target, r.alt, r.line])).toEqual([
      ["wiki", "photo.png", "", 2],
      ["wiki", "sub/Pic.JPG", "a red door", 3],
    ]);
  });

  it("takes |300 and |300x200 as a size, not a description", () => {
    expect(findImageRefs("![[a.png|300]] ![[b.png|300x200]]").map((r) => r.alt)).toEqual(["", ""]);
    expect(findImageRefs("![a|300](a.png)")[0]?.alt).toBe("a");
  });

  it("finds Markdown images of vault files, decoding the path", () => {
    const refs = findImageRefs('![the door](my%20photos/door.webp "title") ![](<dir/a b.gif>)');
    expect(refs.map((r) => [r.form, r.target, r.alt])).toEqual([
      ["markdown", "my photos/door.webp", "the door"],
      ["markdown", "dir/a b.gif", ""],
    ]);
  });

  it("leaves web addresses, notes and anything in code alone", () => {
    const text = ["![x](https://example.com/a.png)", "![[Some note]]", "![[note.md]]", "![x](notes/a.md)", "`![[a.png]]`", "```", "![[b.png]]", "```", "![x](//cdn.example/a.png)", "![x](blyg-media:" + SHA + ")"].join("\n");
    expect(findImageRefs(text)).toEqual([]);
  });

  it("recognises pictures the Studio does not take, so they can be refused with a reason", () => {
    expect(findImageRefs("![[IMG_1.HEIC]] ![[a.bmp]]").map((r) => r.target)).toEqual(["IMG_1.HEIC", "a.bmp"]);
  });

  it("ignores a heading or block part of a target", () => {
    expect(findImageRefs("![[a.png#x]]")[0]?.target).toBe("a.png");
  });
});

describe("canonical form", () => {
  it("replaces refs in place and keeps the rest", () => {
    const text = "x ![[a.png|hi]] y\n![b](b.png) z";
    const refs = findImageRefs(text);
    expect(replaceRefs(text, refs, [canonicalImage("hi", SHA), canonicalImage("b", SHA)])).toBe(`x ![hi](blyg-media:${SHA}) y\n![b](blyg-media:${SHA}) z`);
  });

  it("turns the Studio's addresses into the canonical form, whatever host or mount", () => {
    const a = `![a dot](http://localhost:8787/media/mrmbx13j/${SHA}.png)`;
    const b = `![a dot](https://blyg.example.com/media/abc12345/${SHA}.PNG)`;
    expect(canonicalizeStudioMedia(a)).toBe(`![a dot](blyg-media:${SHA})`);
    expect(canonicalizeStudioMedia(b)).toBe(`![a dot](blyg-media:${SHA})`);
    expect(canonicalizeStudioMedia("![x](https://example.com/media/x/short.png)")).toBe("![x](https://example.com/media/x/short.png)");
  });

  it("lists distinct digests and puts the Studio's addresses back for sending", () => {
    const text = `![a](blyg-media:${SHA})\n![b](blyg-media:${SHA})`;
    expect(canonicalDigests(text)).toEqual([SHA]);
    expect(withStudioAddresses(text, new Map([[SHA, "https://h/media/i/x.png"]]))).toBe("![a](https://h/media/i/x.png)\n![b](https://h/media/i/x.png)");
    expect(withStudioAddresses(text, new Map())).toBe(text);
  });
});
