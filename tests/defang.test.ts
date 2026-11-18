// S15: the reader's rebuild of foreign HTML. Pure string logic. The loading behaviour itself (no request until a tap; the bypasses below really fetch
// when let through) is measured in real Obsidian by tests/e2e/obsidian/scenarios/reader-poc.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plainText, rewriteImages } from "../src/ui/defang";

const own = "http://localhost:8787";
const BASE = "http://localhost:8788/f/abc/";
const click = { trustedOrigin: own, mode: "click" as const, baseUrl: BASE };
const always = { trustedOrigin: own, mode: "always" as const, baseUrl: BASE };
const FIX = new URL("./fixtures/studio/reader/", import.meta.url);
const fixtures = readdirSync(FIX).filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(new URL(f, FIX), "utf8")] as const);
const text = (html: string, o = click): string | null => rewriteImages(html, o).text;

describe("what a Studio 0.51.0 really writes passes through unchanged", () => {
  it("has the fixtures (full-feature preview, imported fragment, threads with whole and partial quotes, image post)", () => {
    expect(fixtures.map(([f]) => f).sort()).toEqual(["imported-fragment-0.51.0.html", "imported-image-0.51.0.html", "imported-thread-partial-0.51.0.html", "imported-thread-whole-0.51.0.html", "preview-vocabulary-0.51.0.html"]);
  });
  it.each(fixtures.filter(([f]) => !f.includes("image") && !f.includes("preview")))("%s", (_f, html) => {
    expect(rewriteImages(html, click)).toEqual({ text: html, reason: null, waiting: [], left: [] });
  });
  it("the full-feature preview: only its one image changes", () => {
    const html = fixtures.find(([f]) => f.includes("preview"))?.[1] ?? "";
    const r = rewriteImages(html, click);
    expect(r.waiting.map((w) => w.host)).toEqual(["img.example"]);
    expect(r.text).toBe(html.replace(/<img [^>]*>/, '<span data-blyg-wait="0"></span>'));
  });
  it("the image post: on click the image waits behind a marker and is not in the text at all", () => {
    const html = fixtures.find(([f]) => f.includes("image"))?.[1] ?? "";
    const r = rewriteImages(html, click);
    expect(r.text).not.toMatch(/<img/i);
    expect(r.text).not.toContain("localhost:8788");
    expect(r.waiting.map((w) => [w.host, w.alt, w.src.startsWith("http://localhost:8788/media/")])).toEqual([["localhost:8788", "a red dot", true]]);
  });
  it("the image post: always load keeps the image, its title, and asks for no referrer", () => {
    const html = fixtures.find(([f]) => f.includes("image"))?.[1] ?? "";
    expect(rewriteImages(html, always).text).toMatch(/<img src="http:\/\/localhost:8788\/media\/[^"]+" alt="a red dot" title="a title" referrerpolicy="no-referrer">/);
  });
});

describe("harmless differences are tolerated: the tag is written out again in the one canonical form", () => {
  it.each([
    ["upper case", "<P>x</P><EM>y</EM>", "<p>x</p><em>y</em>"],
    ["single and unquoted values", "<a href='https://a.example/x' title=hello>l</a>", '<a href="https://a.example/x" title="hello">l</a>'],
    ["whitespace and newlines inside a tag", '<a\n  href="https://a.example/x"\n>l</a>', '<a href="https://a.example/x">l</a>'],
    ["self-closing void tags", "<br/><hr /><br>", "<br><hr><br>"],
    ["a slash on a non-void tag is ignored, as browsers do", "<p/>x", "<p>x"],
    ["ids, random classes, rel, target, aria and data attributes are dropped", '<p id="a" class="x y" data-x="1" aria-label="z" lang="fr" onclick="alert(1)">t</p>', "<p>t</p>"],
    ["footnote markup (sup, a, section) is drawn", '<p>x<sup><a href="#fn1" id="r1" rel="footnote">1</a></sup></p><section class="footnotes"><ol><li id="fn1">n</li></ol></section>', null],
    ["figure and details", "<figure><figcaption>c</figcaption></figure><details open><summary>s</summary>d</details>", "<figure><figcaption>c</figcaption></figure><details open=\"\"><summary>s</summary>d</details>"],
    ["a stray < is text", "<p>1 < 2 and 3 <4</p>", "<p>1 &lt; 2 and 3 &lt;4</p>"],
    ["a duplicate attribute: the first wins, as in a browser", '<a href="https://a.example/1" href="https://evil.example/2">l</a>', '<a href="https://a.example/1">l</a>'],
    ["table cells keep span and a canonical alignment", '<table><tbody><tr><td colspan="2" style="TEXT-ALIGN: Center;">x</td></tr></tbody></table>', '<table><tbody><tr><td colspan="2" style="text-align:center">x</td></tr></tbody></table>'],
  ])("%s", (_name, input, want) => {
    const got = text(input);
    expect(got).not.toBeNull();
    if (want !== null) expect(got).toBe(want);
  });
});

describe("attributes that load or run are dropped, never passed on (the 2026-11-13 bypasses, now harmless)", () => {
  it.each([
    ["table background", '<table background="https://t.example/p.png"><tbody><tr><td>x</td></tr></tbody></table>', "background"],
    ["td background", '<table><tbody><tr><td background="https://t.example/p.png">x</td></tr></tbody></table>', "background"],
    ["style url() on p", '<p style="background-image:url(https://t.example/p.png)">x</p>', "style"],
    ["style url() on a list", '<ul style="list-style-image:url(https://t.example/p.png)"><li>x</li></ul>', "style"],
    ["td style that is not just an alignment", '<table><tbody><tr><td style="text-align:left;background:url(x)">x</td></tr></tbody></table>', "style"],
    ["onerror and onload", '<p onload="alert(1)" onerror="alert(2)" onmouseover="alert(3)">x</p>', "on"],
    ["srcset", '<p srcset="https://t.example/p.png 2x">x</p>', "srcset"],
    ["a ping", '<a href="https://a.example/" ping="https://t.example/p">l</a>', "ping"],
    ["a blockquote cite", '<blockquote cite="https://t.example/c">q</blockquote>', "cite"],
    ["a ping on a quoted address", '<a href="https://a.example/" PING=https://t.example/p>l</a>', "t.example"],
  ])("%s", (_n, input, forbidden) => {
    const got = text(input);
    expect(got).not.toBeNull();
    expect(got?.toLowerCase()).not.toContain(forbidden.toLowerCase());
    expect(got).not.toContain("t.example");
  });
  it("an image keeps only src, alt and title (srcset, onerror, width, loading are dropped)", () => {
    const r = rewriteImages('<img src="https://t.example/p.png" srcset="https://t.example/q.png 2x" onerror="x()" width="10" loading="eager" alt="a">', always);
    expect(r.text).toBe('<img src="https://t.example/p.png" alt="a" referrerpolicy="no-referrer">');
  });
});

describe("links", () => {
  it.each([
    ["https://a.example/x", "https://a.example/x"], ["http://a.example/x?a=1&amp;b=2", "http://a.example/x?a=1&amp;b=2"], ["mailto:me@a.example", "mailto:me@a.example"],
    ["/other/", "http://localhost:8788/other/"], ["../up/", "http://localhost:8788/f/up/"], ["#fn1", "http://localhost:8788/f/abc/#fn1"],
  ])("%s is kept as %s", (href, want) => expect(text(`<a href="${href}">l</a>`)).toBe(`<a href="${want}">l</a>`));
  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "java&#x09;script:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "app://obsidian.md/x", ""])(
    "%j is dropped",
    (href) => expect(text(`<a href="${href}">l</a>`)).toBe("<a>l</a>"),
  );
  it("a relative link with no known address to resolve against is dropped (it would resolve against Obsidian itself)", () => {
    expect(rewriteImages('<a href="/x">l</a>', { trustedOrigin: null, mode: "click" }).text).toBe("<a>l</a>");
  });
});

describe("images", () => {
  const img = (src: string, alt = "a door") => `<p><img src="${src}" alt="${alt}"></p>`;
  it("an image from the owner's own Studio loads in either mode", () => {
    for (const o of [click, always]) expect(rewriteImages(img("http://localhost:8787/media/a/b.png"), o)).toEqual({ text: img("http://localhost:8787/media/a/b.png"), reason: null, waiting: [], left: [] });
  });
  it("a foreign image waits; entities in its address are read as the browser would", () => {
    expect(rewriteImages(img("https://tracker.example/p.png?x=1&amp;y=2"), click).waiting).toEqual([{ src: "https://tracker.example/p.png?x=1&y=2", alt: "a door", host: "tracker.example" }]);
  });
  it("a relative address is resolved against the post's address, and then it is a foreign image like any other", () => {
    expect(rewriteImages(img("/media/a.png"), click).waiting.map((w) => w.src)).toEqual(["http://localhost:8788/media/a.png"]);
  });
  it("numbers several waiting images in order", () => {
    const r = rewriteImages(`${img("https://a.example/1.png")}${img("https://b.example/2.png")}`, click);
    expect(r.waiting.map((w) => w.host)).toEqual(["a.example", "b.example"]);
    expect(r.text).toContain('data-blyg-wait="1"');
  });
  it("an image that is not an absolute http(s) address never loads, in either mode, and is named in words", () => {
    for (const src of ["data:image/png;base64,AAAA", "file:///etc/passwd", "javascript:alert(1)", "", "ftp://x.example/a.png"]) {
      for (const o of [click, always]) {
        const r = rewriteImages(img(src, "pic"), o);
        expect(r.text, src).not.toMatch(/<img/i);
        expect(r.text, src).toContain("[image not shown: pic]");
      }
    }
  });
  it("what it writes back is escaped for any quoting, apostrophes included; the own-Studio path cannot smuggle an attribute", () => {
    const r = rewriteImages('<p><img src="http://localhost:8787/x&#39; style=&#39;background-image:url(https://t.example/p.png)" alt="y"></p>', click);
    // One img with src and alt only: the would-be attribute stays inside the quoted src (the address is normalised, the quotes and the space encoded).
    expect(r.text).toMatch(/^<p><img src="http:\/\/localhost:8787\/x[^"]*" alt="y"><\/p>$/);
    expect(r.text?.match(/ [a-z-]+="/g)).toEqual([' src="', ' alt="']);
  });
  it("a title with markup in it stays text", () => {
    const got = text('<a href="https://a.example/" title=\'<img src="http://localhost:8787/x" onerror="x()">\'>z</a>');
    expect(got).toBe('<a href="https://a.example/" title="&lt;img src=&quot;http://localhost:8787/x&quot; onerror=&quot;x()&quot;&gt;">z</a>');
  });
  it("our own marker cannot be spoofed: a span with that attribute loses it", () => {
    expect(text('<span data-blyg-wait="0">x</span>')).toBe("<span>x</span>");
  });
});

describe("LEFT OUT, its text kept (parse loosely, emit strictly): anything that could load or run something is not a tag the reader writes", () => {
  // input → [what comes out, the tag names reported as left out]
  const out: Record<string, [string, string, string[]]> = {
    "<image> alias": ['<p>a</p><image src="https://t.example/p.png">', "<p>a</p>", ["image"]],
    "<input type=image>": ['<input type="image" src="https://t.example/p.png">', "", ["input"]],
    iframe: ['<p>a</p><iframe src="https://t.example/f">fallback</iframe><p>b</p>', "<p>a</p><p>b</p>", ["iframe"]],
    object: ['<object data="https://t.example/o">x</object>y', "y", ["object"]],
    embed: ["<embed src=x>after", "after", ["embed"]],
    video: ['<video src="https://t.example/v.mp4">no video</video>z', "z", ["video"]], audio: ["<audio src=x></audio>z", "z", ["audio"]],
    picture: ['<picture><source srcset=x><img src="https://t.example/p.png" alt="p"></picture>', '<span data-blyg-wait="0"></span>', ["picture", "source"]],
    svg: ['a<svg><image href="https://t.example/p.png"/><text>t</text></svg>b', "ab", ["svg"]], math: ["a<math><mi>x</mi></math>b", "ab", ["math"]],
    script: ["a<script>alert(1)</script>b", "ab", ["script"]], "script, upper case": ["a<SCRIPT>x</SCRIPT >b", "ab", ["script"]],
    "style element": ["a<style>@import url(https://t.example/s.css)</style>b", "ab", ["style"]], link: ['<link rel="stylesheet" href="https://t.example/s.css">x', "x", ["link"]],
    "meta refresh": ['<meta http-equiv="refresh" content="0;url=https://t.example">x', "x", ["meta"]], base: ['<base href="https://t.example/">x', "x", ["base"]],
    form: ["<form action=x>name <b>bold</b></form>", "name <b>bold</b>", ["form"]], textarea: ["a<textarea><img src=x></textarea>b", "ab", ["textarea"]],
    template: ["a<template><p>t</p></template>b", "ab", ["template"]], noscript: ["a<noscript>n</noscript>b", "ab", ["noscript"]],
    button: ["<button>x</button>", "x", ["button"]], select: ["<select><option>o</option></select>", "o", ["select", "option"]], canvas: ["a<canvas>c</canvas>b", "ab", ["canvas"]],
    map: ['<map><area href="x"></map>', "", ["map", "area"]], body: ['<body background="https://t.example/p.png">x', "x", ["body"]], html: ["<html>x", "x", ["html"]],
    head: ["<head>x", "x", ["head"]], font: ['<font face="x">y</font>', "y", ["font"]], "custom element": ["<foo-bar>x</foo-bar>", "x", ["foo-bar"]],
    "a tag called p=x": ["<p=x>y", "y", ["other"]],
    "unclosed script": ["a<script>b<p>c", "a", ["script"]],
    comment: ["a<!-- <img src=x> -->b", "ab", []], "unterminated comment": ["a<!-- b", "a", []], doctype: ["<!DOCTYPE html>x", "x", []], "processing instruction": ["<?xml?>x", "x", []],
    "closing tag with a non-letter (a hidden comment to a browser)": ["<p>x</ p>y", "<p>xy", []], "closing tag with an attribute": ['<p>x</p class="x">', "<p>x</p>", []],
    "closing void": ["<p>x</br></p>", "<p>x</p>", []], "closing img": ["<img src=x></img>", "[image not shown]", []],
  };
  it.each(Object.entries(out))("%s", (_name, [html, want, names]) => {
    for (const o of [click, always]) {
      const r = rewriteImages(html, o);
      if (html.includes("<img src=x>")) continue; // the image's own wording is tested with the images
      if (want.includes("data-blyg-wait") && o === always) continue; // the same image loads in the other mode (tested with the images)
      expect(r.text, html).toBe(want);
      expect(r.left, html).toEqual(names);
      expect(r.reason).toBeNull();
    }
  });
  it("a malformed \"<\" is plain text, shown as such, and never starts a tag", () => {
    expect(text('<p>x<a href="y"')).toBe('<p>x&lt;a href="y"');
    expect(text('<a href="y>x</a>')).toBe('&lt;a href="y>x</a>');
    expect(text("1 < 2 and <3")).toBe("1 &lt; 2 and &lt;3");
    expect(text(`<p ${"a=1 ".repeat(200)}>x</p>`)).toBe(`&lt;p ${"a=1 ".repeat(200)}>x</p>`);
  });
  it("what the spec's own markup needs passes: generated text, a quote's origin and label (and nothing else on those tags)", () => {
    expect(text('<div class="blyg-tk-gen">block</div><p>a <span class="blyg-tk-gen">inline</span></p>')).toBe(
      '<div class="blyg-tk-gen" title="Marked by the publisher as generated text (their own disclosure, not verified)">block</div><p>a <span class="blyg-tk-gen" title="Marked by the publisher as generated text (their own disclosure, not verified)">inline</span></p>',
    );
    expect(text('<div class="other" onclick="x()">d</div><span class="blyg-tk-gen other">s</span>')).toBe("<div>d</div><span>s</span>");
    expect(text('<blockquote class="blyg-transclusion" data-blyg-id="abc123" data-blyg-version="2" data-blyg-origin="https://blyg.example/" data-blyg-label="my &quot;name&quot;"><p>q</p></blockquote>')).toBe(
      '<blockquote class="blyg-transclusion" data-blyg-id="abc123" data-blyg-version="2" data-blyg-origin="https://blyg.example/" data-blyg-label="my &quot;name&quot;"><p>q</p></blockquote>',
    );
    expect(text('<blockquote data-blyg-origin="javascript:alert(1)" data-blyg-label="' + "x".repeat(500) + '">q</blockquote>')).toBe(`<blockquote data-blyg-label="${"x".repeat(300)}">q</blockquote>`);
  });
  it("renders the tags it keeps around the text of the ones it dropped, in order", () => {
    expect(text("<p>one <foo>two <b>three</b></foo> four</p>")).toBe("<p>one two <b>three</b> four</p>");
  });
  it("an enormous post is refused, and quickly; so is one full of broken tags; a large one within the cap is drawn", () => {
    const t0 = Date.now();
    expect(text("<a ".repeat(100_000))).toBeNull();
    expect(rewriteImages("<a ".repeat(100_000), click).reason).toContain("malformed");
    expect(text("<p>".repeat(800_000))).toBeNull(); // over the 2 MB cap
    expect(text("<p>".repeat(200_000))).not.toBeNull();
    expect(text("<script>".repeat(50_000) + "x")).not.toBeNull(); // each unclosed script drops to the end: one scan, not fifty thousand
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

/** mulberry32: a small seeded generator (the repository's tests do not use a multiplicative LCG). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("whatever goes in, nothing outside the allowed set comes out (randomised, seeded)", () => {
  const PIECES = ["<", ">", "/", "=", '"', "'", " ", "\n", "\t", "img", "a", "p", "src", "href", "onerror", "onclick", "script", "image", "input", "javascript:", "https://t.example/p.png", "&amp;", "&#x3c;", "&lt;",
    "x", "style", "url(", "background", "srcset", "title", "alt", "class", "id", "svg", "iframe", "td", "table", "!--", "?", "`", "data-blyg-wait", "blockquote", "code", "language-js"];
  const OUT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "section", "address", "blockquote", "pre", "hr", "br", "wbr", "em", "strong", "b", "i", "u", "s", "del", "ins", "mark", "small", "sup", "sub", "abbr", "cite", "q", "dfn", "kbd", "samp", "var", "code", "time", "bdi", "bdo", "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "details", "summary", "a", "img"]);
  const OUT_ATTRS = new Set(["href", "title", "src", "alt", "start", "class", "colspan", "rowspan", "style", "datetime", "open", "data-blyg-id", "data-blyg-version", "data-blyg-origin", "data-blyg-label", "referrerpolicy", "data-blyg-wait"]);
  it("every output is made only of allowed tags with allowed attributes, all double-quoted and escaped, and no loadable address outside href and src", () => {
    const rnd = mulberry32(20261113);
    let kept = 0;
    for (let n = 0; n < 6000; n++) {
      const len = 1 + Math.floor(rnd() * 14);
      let input = "";
      for (let i = 0; i < len; i++) input += PIECES[Math.floor(rnd() * PIECES.length)] ?? "";
      for (const mode of ["click", "always"] as const) {
        const out = rewriteImages(input, { trustedOrigin: own, mode, baseUrl: BASE }).text;
        if (out === null) continue;
        kept++;
        let rest = out;
        // Every "<" begins a tag we wrote: <name or </name followed by attributes written as ` name="value"`, then ">".
        for (const m of out.matchAll(/<(\/?)([a-z0-9]+)((?: [a-z-]+(?:="[^"<>]*")?)*)>/g)) {
          expect(OUT_TAGS.has(m[2] ?? ""), `${JSON.stringify(input)} → ${out}`).toBe(true);
          for (const a of (m[3] ?? "").matchAll(/ ([a-z-]+)/g)) expect(OUT_ATTRS.has(a[1] ?? ""), `${JSON.stringify(input)} → ${out}`).toBe(true);
          rest = rest.replace(m[0], "");
        }
        expect(rest.includes("<"), `a "<" outside a tag we wrote: ${JSON.stringify(input)} → ${out}`).toBe(false);
        // An address that loads can only sit in an img src, and a style can only be an alignment.
        for (const m of out.matchAll(/<([a-z0-9]+)[^>]*\ssrc="/g)) expect(m[1]).toBe("img");
        for (const m of out.matchAll(/ style="([^"]*)"/g)) expect(m[1]).toMatch(/^text-align:(left|center|right)$/);
      }
    }
    expect(kept).toBeGreaterThan(500); // the generator reaches accepted inputs too, not only refusals
  });
});

describe("plainText", () => {
  it("takes the words out of a post without creating any element", () => {
    expect(plainText('<p>Hello <em>there</em> &amp; welcome</p>\n<p><img src="https://t.example/p.png" alt="x"> end</p>')).toBe("Hello there & welcome end");
  });
  it("only ever yields text: a malformed tag cannot survive as markup to the caller that sets it as text", () => {
    expect(plainText("<p>a</p><scr<script>ipt>b")).not.toContain("<");
  });
});
