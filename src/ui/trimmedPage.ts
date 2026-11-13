// S15, reader round 3: a post's own web page, trimmed to the post, for the reader's frame (Florian, 2026-11-13, "option 1").
//
// The blyg CSS contract (docs/vendor/blygger-spec/css-contract.md §2) fixes every public page: `div.blyg` holds the header, the masthead, the links, and
// one `article.fragment | article.thread` per item, whose `div.item-content` holds the author's bytes. The reader keeps that article and drops the rest
// (menus, masthead, collections), and keeps the blyg's look by inlining its stylesheets: a document the plugin builds inherits Obsidian's content
// security policy, which refuses stylesheets from other hosts but allows inline styles (measured in Obsidian 1.14.5).
//
// THE ONE EXCEPTION to "foreign HTML reaches the DOM only through sanitizeHTMLToDom": this file builds an HTML document from a fetched page and hands it
// to a frame as an object URL (the lint rule `documentSink` allows it here and nowhere else). It is safe only because that frame is sandboxed WITHOUT
// allow-scripts and WITHOUT allow-same-origin (`READER_FRAME_SANDBOX`): no script runs, and the document gets an opaque origin, so it cannot reach
// Obsidian even though an object URL is created in Obsidian's origin. That is the same protection as framing the author's page itself, which shows
// strictly more of it. Never add allow-same-origin or allow-scripts to this sandbox.

/** The sandbox of every reader frame. Links open outside (popups escape the sandbox); nothing else is allowed. */
export const READER_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

const MAX_ARTICLE = 1_000_000;
const MAX_SHEETS = 3;

/** The page's one item: the first `<article>` … `</article>` (articles do not nest in the contract). Null when there is none. */
export function articleOf(pageHtml: string): string | null {
  const start = pageHtml.search(/<article\b/i);
  if (start < 0) return null;
  const end = pageHtml.indexOf("</article>", start);
  if (end < 0 || end - start > MAX_ARTICLE) return null;
  return pageHtml.slice(start, end + "</article>".length);
}

/** Absolute http(s) addresses of the page's stylesheets (`<link rel="stylesheet" href>`), at most three, resolved against the page. */
export function stylesheetsOf(pageHtml: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const m of pageHtml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i.exec(tag);
    const raw = href?.[1] ?? href?.[2];
    if (!raw) continue;
    try {
      const u = new URL(raw.replace(/&amp;/g, "&"), pageUrl);
      if ((u.protocol === "https:" || u.protocol === "http:") && !out.includes(u.href)) out.push(u.href);
    } catch {
      // not an address: skipped
    }
    if (out.length >= MAX_SHEETS) break;
  }
  return out;
}

const escapeAttr = (t: string): string => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A few lines so the post sits well in a narrow pane; everything else is the blyg's own stylesheet. */
const READER_TWEAKS = "html,body{margin:0}body{padding:12px 16px}.blyg{max-width:none}article{margin-top:0}";

/**
 * The document the frame shows: the page's article, inside the contract's `div.blyg > div.blyg-body > div.blyg-main` so the blyg's own selectors apply,
 * with its stylesheets inline and a base address so the article's links and images resolve against the page (links open outside). Null when the page
 * has no article: the caller then shows the whole page.
 */
export function trimmedDocument(input: { pageHtml: string; pageUrl: string; css: string[] }): string | null {
  const article = articleOf(input.pageHtml);
  if (article === null) return null;
  const lang = /<html\b[^>]*\blang="([A-Za-z-]{1,20})"/i.exec(input.pageHtml)?.[1] ?? "";
  // A stylesheet must not be able to close the style element and start markup of its own.
  const css = input.css.map((c) => c.replace(/<\/style/gi, "<\\/style")).join("\n");
  return [
    `<!doctype html><html${lang ? ` lang="${lang}"` : ""}><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<base href="${escapeAttr(input.pageUrl)}" target="_blank">`,
    `<style>${css}</style><style>${READER_TWEAKS}</style></head>`,
    `<body><div class="blyg"><div class="blyg-body"><div class="blyg-main">${article}</div></div></div></body></html>`,
  ].join("");
}

/** The object URL a reader frame loads. Revoke it (`URL.revokeObjectURL`) when the post is closed. */
export function frameUrlFor(doc: string): string {
  return URL.createObjectURL(new Blob([doc], { type: "text/html" }));
}
