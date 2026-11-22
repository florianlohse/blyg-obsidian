import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogProblems, htmlProblems, readmeProblems } from "../../scripts/check-readme.mjs";

const has = new Set(["images/a.png", "images/b.png", "docs/x.md", "other/a.png"]);
const exists = (p: string) => has.has(p);
const GOOD = `# Tool

Opening paragraph with a [guide](docs/x.md).

<p><img src="images/a.png" width="300" alt="A screenshot"></p>

## One

![Another](images/b.png)

| a | b |
|---|---|
| <img src="images/a.png" alt="again"> | text |

### Sub

Text with \`<div>\` in code and <https://example.com>.

\`\`\`html
<p>not checked</p>
\`\`\`
`;
const msgs = (text: string) => readmeProblems(text, exists).map((p) => p.message);

describe("check-readme: the README is website-ready", () => {
  it("accepts a good README (img in <p>, in a table cell, Markdown images, code and autolinks)", () => {
    expect(readmeProblems(GOOD, exists)).toEqual([]);
  });

  it("an image without alt text is refused, in both forms (the phase's done-when)", () => {
    expect(msgs(GOOD.replace(' alt="A screenshot"', ""))).toEqual(["the image images/a.png has no alt text"]);
    expect(msgs(GOOD.replace("![Another]", "![]"))).toEqual(["the image images/b.png has no alt text"]);
    expect(msgs(GOOD.replace('alt="again"', 'alt=" "'))).toEqual(["the image images/a.png has no alt text"]);
  });

  it("a missing image file, a missing linked file, and two images with one file name are refused", () => {
    expect(msgs(GOOD.replace("images/b.png", "images/gone.png"))).toEqual(["the image images/gone.png does not exist"]);
    expect(msgs(GOOD.replace("docs/x.md", "docs/gone.md"))).toEqual(["the link docs/gone.md points at a file that does not exist"]);
    expect(msgs(GOOD + "\n![Dup](other/a.png)\n")[0]).toMatch(/share the file name a\.png/);
  });

  it("web addresses and anchors are not looked up on disk", () => {
    expect(msgs(GOOD + "\n[a](https://example.com/x.md) [b](#one) ![c](https://example.com/c.png)\n")).toEqual([]);
  });

  it("a skipped heading level, a second title, a first heading that is not the title, an empty heading", () => {
    expect(msgs(GOOD.replace("### Sub", "#### Sub"))).toEqual(["the heading level jumps from 2 to 4"]);
    expect(msgs(GOOD + "\n# Again\n")).toEqual(["a second `#` title (one per page)"]);
    expect(msgs("## Early\n\n" + GOOD)).toContain("the first heading must be the `#` title");
    expect(msgs(GOOD + "\n## \n")).toEqual(["an empty heading"]);
    expect(msgs("Just text.\n")).toContain("there is no `#` title");
  });

  it("the title needs an opening paragraph (an image or a quote alone is not one)", () => {
    expect(msgs("# T\n\n<p><img src=\"images/a.png\" alt=\"x\"></p>\n\n> note\n\n## One\n\ntext\n")).toEqual(["the title is not followed by an opening paragraph"]);
  });

  it("raw HTML other than <img> is refused; so are extra attributes and comments", () => {
    expect(msgs(GOOD + "\n<details><summary>x</summary></details>\n")[0]).toMatch(/raw HTML is not allowed/);
    expect(msgs(GOOD + "\n<!-- note -->\n")[0]).toMatch(/raw HTML is not allowed/);
    expect(msgs(GOOD.replace('width="300"', 'style="x"'))).toEqual(['<img style="…"> is not allowed (src, alt, width and height only)']);
    expect(msgs(GOOD.replace("<p><img", "<div><img").replace("></p>", "></div>")).length).toBeGreaterThan(0);
  });

  it("reports the line of each problem", () => {
    const p = readmeProblems(GOOD.replace(' alt="A screenshot"', ""), exists);
    expect(p[0]?.line).toBe(5);
  });

  it("CHANGELOG: only the raw-HTML rule", () => {
    expect(changelogProblems("## [1.0.0] — 2026-01-01\n\nText `<b>` and <https://example.com>.\n")).toEqual([]);
    expect(changelogProblems("## [1.0.0]\n\n<b>bold</b>\n")).toHaveLength(1);
    expect(htmlProblems("")).toEqual([]);
  });
});

describe("check-readme: this repository", () => {
  it("the real README.md and CHANGELOG.md are website-ready", () => {
    expect(readmeProblems(readFileSync("README.md", "utf8"), (p) => existsSync(p))).toEqual([]);
    expect(changelogProblems(readFileSync("CHANGELOG.md", "utf8"))).toEqual([]);
  });

  it("the command line exits 0 on this repository", () => {
    expect(execFileSync("node", ["scripts/check-readme.mjs"], { encoding: "utf8" })).toMatch(/^Website-ready/);
  });
});
