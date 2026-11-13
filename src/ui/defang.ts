// PROOF OF CONCEPT (S15): foreign markup in a post you read. Measured 2026-11-13 (a counting web server, real Obsidian):
//   - `sanitizeHTMLToDom` strips scripts, event handlers and `javascript:` links but KEEPS remote `<img>` and `<iframe>`;
//   - it builds its elements in the live page, so the browser fetches an image AS SOON AS it is created: removing it afterwards is too late;
//   - a Studio hands a reader the author's own image address and lets a post point an image at any server (measured on two local Studios 0.51.0);
//   - a DENY-list of "tags that load" is not enough: `<image>` (the parser turns it into `<img>`), `<input type=image>`, `background=` and CSS `url()` in
//     `style=` all fetched without a tap (review of 2026-11-13).
// So the text is checked against an ALLOW-list before the sanitiser sees it, and the repository's rule stays whole (foreign HTML reaches the DOM only
// through `sanitizeHTMLToDom`; no DOMParser, no innerHTML). Every `<` in the post must open or close a tag the Studio writes (measured on Studio 0.51.0's
// preview), lower case, with only that tag's attributes, each `name="value"` after a single space. That grammar is a strict subset of HTML that a browser
// reads the same way, so nothing the browser would build can hide from the check. Anything else (another tag, attribute, quoting, a comment, upper case,
// extra whitespace) makes the whole post "not drawn here, open it on the web": FAIL-CLOSED, never a guess. Images are rewritten as their tag is read:
//   - an image from the owner's own Studio always loads;
//   - any other http(s) image: mode "click" leaves a button that names the host and loads the image only when tapped; mode "always" lets it load;
//   - an image that is not an absolute http(s) address (relative, data:, file:) is never loaded and is named in words.
export type ImageMode = "click" | "always";

export interface Rendered {
  fragment: DocumentFragment;
  /** Images waiting for a tap. */
  blocked: number;
  /** True when the post was not drawn because it holds markup the reader does not understand (the fragment says so). */
  refused: boolean;
  /** Load every image still waiting. */
  loadAll(): void;
}

const MARK = "data-blyg-wait";

const ANY = (): boolean => true;
/** The tags a Studio writes for a post, and each one's attributes with a check of the value. Measured 2026-11-13 on Studio 0.51.0's preview of a post using
 *  every Markdown feature it renders, and on imported threads and image posts (`tests/fixtures/studio/reader/`); `del`, `sup`, `sub` and `ol start` are added as harmless. */
const ALLOWED: Record<string, Record<string, (value: string) => boolean>> = {
  h1: {}, h2: {}, h3: {}, h4: {}, h5: {}, h6: {}, p: {}, em: {}, strong: {}, s: {}, del: {}, sup: {}, sub: {}, br: {}, hr: {}, pre: {},
  ul: {}, li: {}, table: {}, thead: {}, tbody: {}, tr: {},
  // A quote in a thread (spec 0.4 §10): measured on an imported thread, whole and partial.
  blockquote: {
    class: (v) => /^blyg-transclusion( blyg-partial)?$/.test(v),
    "data-blyg-id": (v) => /^[a-z0-9]{1,64}$/.test(v),
    "data-blyg-version": (v) => /^\d{1,9}$/.test(v),
  },
  ol: { start: (v) => /^\d{1,6}$/.test(v) },
  code: { class: (v) => /^language-[A-Za-z0-9_+#-]{1,40}$/.test(v) },
  th: { style: (v) => /^text-align:(left|center|right)$/.test(v) },
  td: { style: (v) => /^text-align:(left|center|right)$/.test(v) },
  a: { href: ANY, title: ANY },
  img: { src: ANY, alt: ANY, title: ANY },
};
const VOID = new Set(["br", "hr", "img"]);
/** One tag at the position of a `<`: `<name>`, `<name a="v" b="w">`, `</name>`, or `<name />` for a void tag. Nothing looser. */
const TAG = /<(\/?)([a-z][a-z0-9]*)((?: [a-z]+(?:-[a-z]+)*="[^"]*")*)( ?\/)?>/y;
const ATTR = / ([a-z]+(?:-[a-z]+)*)="([^"]*)"/g;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
/** Escapes for text and for a double- or single-quoted attribute value alike. */
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const hostOf = (src: string): string | null => {
  try {
    const u = new URL(src);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
};

/** The visible text of a post for a list, taken from the string (never inserted as markup, so an imperfect strip can only look odd). */
export function plainText(html: string): string {
  // Inline tags join their words to the text around them ("a <a>link</a>." stays "a link."); every other tag separates words.
  const INLINE = /<\/?(?:a|em|strong|b|i|s|del|code|sup|sub|span|mark|abbr|small)(?:\s[^>]*)?>/gi;
  return decode(html.replace(INLINE, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export interface Rewrite {
  /** The text to hand to the sanitiser, or null when the post holds markup the reader does not understand. */
  text: string | null;
  /** Images left waiting for a tap, in the order of their markers. */
  waiting: Array<{ src: string; alt: string; host: string }>;
}

/** The pure part: what the text becomes before the sanitiser sees it. Fail-closed (see the header): `text` is null for anything not on the allow-list. */
export function rewriteImages(html: string, opts: { trustedOrigin: string | null; mode: ImageMode }): Rewrite {
  const refused: Rewrite = { text: null, waiting: [] };
  const trusted = opts.trustedOrigin === null ? null : `${opts.trustedOrigin.replace(/\/$/, "")}/`;
  const waiting: Rewrite["waiting"] = [];
  let out = "";
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, lt);
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) return refused;
    const [whole, closing, name = "", attrText = "", selfClosing] = m;
    const allowed = ALLOWED[name];
    if (!allowed) return refused;
    if (closing && (attrText !== "" || selfClosing || VOID.has(name))) return refused;
    if (selfClosing && !VOID.has(name)) return refused;
    const attrs = new Map<string, string>();
    for (const [, key = "", value = ""] of attrText.matchAll(ATTR)) {
      const check = allowed[key];
      if (!check || attrs.has(key) || !check(decode(value))) return refused;
      attrs.set(key, decode(value));
    }
    at = lt + whole.length;
    if (name !== "img") {
      out += whole;
      continue;
    }
    const src = (attrs.get("src") ?? "").trim();
    const alt = (attrs.get("alt") ?? "").trim();
    const title = attrs.get("title");
    const keep = (extra: string): string => `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title !== undefined ? ` title="${escapeHtml(title)}"` : ""}${extra}>`;
    if (trusted !== null && src.startsWith(trusted)) {
      out += keep("");
      continue;
    }
    const host = hostOf(src);
    if (host === null) out += escapeHtml(`[image not shown${alt ? `: ${alt}` : ""}]`);
    else if (opts.mode === "always") out += keep(' referrerpolicy="no-referrer"');
    else {
      waiting.push({ src, alt, host });
      out += `<span ${MARK}="${waiting.length - 1}"></span>`;
    }
  }
  return { text: out, waiting };
}

export function renderForeign(html: string, opts: { trustedOrigin: string | null; mode: ImageMode }, sanitize: (html: string) => DocumentFragment): Rendered {
  const { text, waiting } = rewriteImages(html, opts);
  if (text === null) {
    const fragment = createFragment((f) => f.createEl("p", { cls: "blyg-reader-blocked", text: "This post has markup the reader does not draw. Open it on the web." }));
    return { fragment, blocked: 0, refused: true, loadAll: () => undefined };
  }
  const fragment = sanitize(text);
  const loaders: Array<() => void> = [];
  for (const marker of Array.from(fragment.querySelectorAll(`[${MARK}]`))) {
    const w = waiting[Number(marker.getAttribute(MARK))];
    if (!w) continue;
    const button = createEl("button", { cls: "blyg-reader-btn blyg-reader-image", text: `Load image${w.alt ? `: ${w.alt}` : ""} (${w.host})` });
    const load = (): void => button.replaceWith(createEl("img", { attr: { src: w.src, alt: w.alt, referrerpolicy: "no-referrer" } }));
    button.addEventListener("click", load);
    loaders.push(() => {
      if (button.isConnected) load();
    });
    marker.replaceWith(button);
  }
  return { fragment, blocked: loaders.length, refused: false, loadAll: () => loaders.forEach((load) => load()) };
}
