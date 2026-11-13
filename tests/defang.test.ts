// PROOF OF CONCEPT (S15): the reader's allow-list for foreign HTML. Pure string logic. The loading behaviour itself (no request until a tap; the bypasses
// below really fetch when let through) is measured in real Obsidian by tests/e2e/obsidian/scenarios/reader-poc.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plainText, rewriteImages } from "../src/ui/defang";

const own = "http://localhost:8787";
const click = { trustedOrigin: own, mode: "click" as const };
const always = { trustedOrigin: own, mode: "always" as const };
const FIX = new URL("./fixtures/studio/reader/", import.meta.url);
const fixtures = readdirSync(FIX).filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(new URL(f, FIX), "utf8")] as const);

describe("what a Studio 0.51.0 really writes is accepted", () => {
  it("has the fixtures (full-feature preview, imported fragment, threads with whole and partial quotes, image post)", () => {
    expect(fixtures.map(([f]) => f).sort()).toEqual(["imported-fragment-0.51.0.html", "imported-image-0.51.0.html", "imported-thread-partial-0.51.0.html", "imported-thread-whole-0.51.0.html", "preview-vocabulary-0.51.0.html"]);
  });
  it.each(fixtures.filter(([f]) => !f.includes("image") && !f.includes("preview")))("%s passes through unchanged", (_f, html) => {
    expect(rewriteImages(html, click)).toEqual({ text: html, waiting: [] });
  });
  it("the full-feature preview is accepted, and only its one image changes (headings, lists, a table with alignment, code with a language, a quote, a link with a title, escaped raw HTML)", () => {
    const html = fixtures.find(([f]) => f.includes("preview"))?.[1] ?? "";
    const r = rewriteImages(html, click);
    expect(r.waiting.map((w) => w.host)).toEqual(["img.example"]);
    expect(r.text).toBe(html.replace(/<img [^>]*>/, '<span data-blyg-wait="0"></span>'));
  });
  it("the image post: on click the image waits behind a marker and is not in the text at all", () => {
    const html = fixtures.find(([f]) => f.includes("image"))![1];
    const r = rewriteImages(html, click);
    expect(r.text).not.toMatch(/<img/i);
    expect(r.text).not.toContain("localhost:8788");
    expect(r.waiting.map((w) => [w.host, w.alt, w.src.startsWith("http://localhost:8788/media/")])).toEqual([["localhost:8788", "a red dot", true]]);
  });
  it("the image post: always load keeps the image, its title, and asks for no referrer", () => {
    const html = fixtures.find(([f]) => f.includes("image"))![1];
    expect(rewriteImages(html, always).text).toMatch(/<img src="http:\/\/localhost:8788\/media\/[^"]+" alt="a red dot" title="a title" referrerpolicy="no-referrer">/);
  });
});

describe("images", () => {
  const img = (src: string, alt = "a door") => `<p><img src="${src}" alt="${alt}"></p>`;
  it("an image from the owner's own Studio loads in either mode", () => {
    for (const o of [click, always]) expect(rewriteImages(img("http://localhost:8787/media/a/b.png"), o)).toEqual({ text: img("http://localhost:8787/media/a/b.png"), waiting: [] });
  });
  it("a foreign image waits; entities in its address are read as the browser would", () => {
    expect(rewriteImages(img("https://tracker.example/p.png?x=1&amp;y=2"), click).waiting).toEqual([{ src: "https://tracker.example/p.png?x=1&y=2", alt: "a door", host: "tracker.example" }]);
  });
  it("numbers several waiting images in order", () => {
    const r = rewriteImages(`${img("https://a.example/1.png")}${img("https://b.example/2.png")}`, click);
    expect(r.waiting.map((w) => w.host)).toEqual(["a.example", "b.example"]);
    expect(r.text).toContain('data-blyg-wait="1"');
  });
  it("an image that is not an absolute http(s) address never loads, in either mode, and is named in words", () => {
    for (const src of ["x.png", "/media/a.png", "data:image/png;base64,AAAA", "file:///etc/passwd", "javascript:alert(1)", "//tracker.example/p.png", ""]) {
      for (const o of [click, always]) {
        const r = rewriteImages(img(src, "pic"), o);
        expect(r.text, src).not.toMatch(/<img/i);
        expect(r.text, src).toContain("[image not shown: pic]");
      }
    }
  });
  it("what it writes back is escaped for any quoting, apostrophes included", () => {
    const r = rewriteImages('<p><img src="http://localhost:8787/x&#39;y" alt="a &quot;b&quot; &lt;c&gt; d&#39;e" title="t&#39;"></p>', click);
    expect(r.text).toBe('<p><img src="http://localhost:8787/x&#39;y" alt="a &quot;b&quot; &lt;c&gt; d&#39;e" title="t&#39;"></p>');
  });
  it("the own-Studio path cannot be used to smuggle an attribute (the 2026-11-13 breakout)", () => {
    const r = rewriteImages('<p><img src="http://localhost:8787/x&#39; style=&#39;background-image:url(https://t.example/p.png)" alt="y"></p>', click);
    // One img element with src and alt only: the would-be attribute stays inside the quoted src, its apostrophes escaped.
    expect(r.text).toBe('<p><img src="http://localhost:8787/x&#39; style=&#39;background-image:url(https://t.example/p.png)" alt="y"></p>');
  });
});

describe("REFUSED as a whole (text null): anything not on the allow-list", () => {
  const bad: Record<string, string> = {
    // the bypasses the review measured fetching in real Obsidian, 2026-11-13
    "<image> alias": '<p>a</p><image src="https://t.example/p.png">',
    "<input type=image>": '<p>a</p><input type="image" src="https://t.example/p.png">',
    "table background": '<table background="https://t.example/p.png"><tbody><tr><td>x</td></tr></tbody></table>',
    "td background": '<table><tbody><tr><td background="https://t.example/p.png">x</td></tr></tbody></table>',
    "style url on p": '<p style="background-image:url(https://t.example/p.png)">x</p>',
    "style url on ul": '<ul style="list-style-image:url(https://t.example/p.png)"><li>x</li></ul>',
    "quote breakout in a single-quoted title": `<p><a href="https://example.com/" title='<img src="http://localhost:8787/x&#39; style=&#39;background:url(https://t.example/p.png)" alt="y">'>z</a></p>`,
    // other tags and attributes
    "iframe": '<iframe src="https://t.example/f"></iframe>', "object": '<object data="https://t.example/o"></object>', "embed": "<embed src=x>",
    "video": '<video src="https://t.example/v.mp4"></video>', "video poster": '<video poster="https://t.example/p.png"></video>', "audio": "<audio src=x></audio>",
    "picture": "<picture><source srcset=x></picture>", "svg": '<svg><image href="https://t.example/p.png"/></svg>', "math": "<math></math>",
    "script": "<script>alert(1)</script>", "style element": "<style>@import url(https://t.example/s.css)</style>", "link": '<link rel="stylesheet" href="https://t.example/s.css">',
    "meta refresh": '<meta http-equiv="refresh" content="0;url=https://t.example">', "base": '<base href="https://t.example/">', "form": "<form action=x></form>",
    "textarea": "<textarea></textarea>", "template": "<template></template>", "noscript": "<noscript></noscript>", "span": "<span>x</span>", "div": "<div>x</div>",
    "body background": '<body background="https://t.example/p.png">', "event handler": '<p onclick="alert(1)">x</p>', "id": '<p id="x">x</p>',
    "img srcset": '<img src="https://t.example/p.png" alt="x" srcset="https://t.example/q.png 2x">', "img onerror": '<img src="x" alt="y" onerror="alert(1)">',
    "img width": '<img src="https://t.example/p.png" alt="x" width="10">', "a target": '<a href="x" target="_blank">x</a>',
    "td style not text-align": '<table><tbody><tr><td style="text-align:left;background:url(x)">x</td></tr></tbody></table>',
    "code class not language": '<pre><code class="language-js x">x</code></pre>', "code class with url": '<pre><code class="url(x)">x</code></pre>',
    "blockquote other class": '<blockquote class="evil">x</blockquote>', "blockquote id with url": '<blockquote class="blyg-transclusion" data-blyg-id="https://t.example">x</blockquote>',
    "our own marker, spoofed": '<p><span data-blyg-wait="0"></span></p><img src="https://t.example/p.png" alt="z">', "data attribute on p": '<p data-blyg-wait="0">x</p>',
    // form and spelling of tags
    "upper case tag": '<IMG SRC="https://t.example/p.png" ALT="x">', "upper case attribute": '<p><a HREF="x">x</a></p>', "single quotes": "<p><a href='x'>x</a></p>",
    "unquoted value": "<p><a href=x>x</a></p>", "newline in tag": '<img\nsrc="https://t.example/p.png" alt="x">', "tab in tag": '<a\thref="x">x</a>',
    "two spaces": '<a  href="x">x</a>', "space before >": '<p >x</p>', "duplicate attribute": '<a href="x" href="y">x</a>', "comment": "<!-- <img src=x> -->",
    "doctype": "<!DOCTYPE html>", "processing instruction": "<?xml?>", "stray <": "<p>1 < 2</p>", "spaced tag": "< iframe src=x>", "closing void": "<p>x</br></p>",
    "self-closing non-void": "<p/>", "closing tag with attribute": '<p>x</p class="x">', "unterminated tag": '<p>x<a href="y"',
  };
  it.each(Object.entries(bad))("%s", (_name, html) => {
    expect(rewriteImages(html, click).text).toBeNull();
    expect(rewriteImages(html, always).text).toBeNull();
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
