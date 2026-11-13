// S15 round 3: a post's own page trimmed to the post, for the reader's sandboxed frame. Pure string functions, tested on real Studio 0.51.0 pages.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { articleOf, READER_FRAME_SANDBOX, stylesheetsOf, trimmedDocument } from "../src/ui/trimmedPage";

const page = (name: string): string => readFileSync(new URL(`./fixtures/studio/pages/${name}-0.51.0.html`, import.meta.url), "utf8");
const URL_ = "http://localhost:8788/f/abc/";

describe("articleOf", () => {
  it.each(["fragment", "thread"])("keeps the %s's article and nothing of the page around it", (name) => {
    const a = articleOf(page(name));
    expect(a).toMatch(/^<article class="(fragment|thread)">/);
    expect(a).toMatch(/<\/article>$/);
    expect(a).toContain('class="item-content"');
    for (const chrome of ["masthead", "blyg-links", "blyg-header", "Made with Blygger", "Find more blygs"]) expect(a).not.toContain(chrome);
  });
  it("a page without an article: null (the reader then shows the whole page)", () => {
    expect(articleOf("<html><body><p>no item here</p></body></html>")).toBeNull();
    expect(articleOf("<article class=\"fragment\"><p>never closed")).toBeNull();
  });
});

describe("stylesheetsOf", () => {
  it("resolves the Studio's /style.css against the page", () => {
    expect(stylesheetsOf(page("fragment"), URL_)).toEqual(["http://localhost:8788/style.css"]);
  });
  it("only http(s) stylesheets, at most three, each once", () => {
    const html = ['<link rel="stylesheet" href="a.css">', '<link href="b.css" rel="stylesheet">', "<link rel='stylesheet' href='a.css'>", '<link rel="icon" href="i.png">',
      '<link rel="stylesheet" href="javascript:alert(1)">', '<link rel="stylesheet" href="https://cdn.example/c.css">', '<link rel="stylesheet" href="d.css">'].join("");
    expect(stylesheetsOf(html, "https://blyg.example/f/x/")).toEqual(["https://blyg.example/f/x/a.css", "https://blyg.example/f/x/b.css", "https://cdn.example/c.css"]);
  });
});

describe("trimmedDocument", () => {
  const doc = trimmedDocument({ pageHtml: page("fragment"), pageUrl: URL_, css: ["body{color:red}"] }) ?? "";
  it("wraps the article in the contract's structure, with the blyg's CSS inline and links opening outside", () => {
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('<div class="blyg"><div class="blyg-body"><div class="blyg-main"><article class="fragment">');
    expect(doc).toContain("<style>body{color:red}</style>");
    expect(doc).toContain(`<base href="${URL_}" target="_blank">`);
    expect(doc).toContain('<html lang="en">');
    expect(doc).not.toContain("Made with Blygger");
  });
  it("a stylesheet cannot close its style element and start markup of its own", () => {
    const d = trimmedDocument({ pageHtml: page("fragment"), pageUrl: URL_, css: ["a{}</style><img src=https://t.example/p.png></STYLE x>"] }) ?? "";
    expect(d).not.toMatch(/<\/style><img/i);
    expect(d.match(/<\/style>/gi)?.length).toBe(2); // only the reader's own two style elements close
  });
  it("the page address cannot break out of the base element", () => {
    const d = trimmedDocument({ pageHtml: page("fragment"), pageUrl: 'https://x.example/"><script>alert(1)</script>', css: [] }) ?? "";
    expect(d).not.toContain("<script>");
  });
  it("no article: null", () => {
    expect(trimmedDocument({ pageHtml: "<p>x</p>", pageUrl: URL_, css: [] })).toBeNull();
  });
});

describe("READER_FRAME_SANDBOX", () => {
  it("never lets a frame run scripts or keep an origin (it may hold a document the plugin built from a stranger's page)", () => {
    expect(READER_FRAME_SANDBOX).not.toMatch(/allow-scripts|allow-same-origin|allow-top-navigation|allow-forms/);
  });
});
