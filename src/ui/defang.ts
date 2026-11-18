// S15: foreign markup in a post you read. Measured 2026-11-13 (a counting web server, real Obsidian):
//   - `sanitizeHTMLToDom` strips scripts, event handlers and `javascript:` links but KEEPS remote `<img>` and `<iframe>`;
//   - it builds its elements in the live page, so the browser fetches an image AS SOON AS it is created: removing it afterwards is too late;
//   - a Studio hands a reader the author's own image address and lets a post point an image at any server (measured on two local Studios 0.51.0);
//   - a DENY-list of "tags that load" is not enough (`<image>`, `<input type=image>`, `background=`, CSS `url()` in `style=` all fetched), and an
//     "exact form" allow-list refused real posts that only differed in harmless details (review 2026-11-13; the maintainer's device test 2026-11-14).
// So the text is REBUILT before the sanitiser sees it, and the repository's rule stays whole (foreign HTML reaches the DOM only through
// `sanitizeHTMLToDom`; no DOMParser, no innerHTML):
//   - every `<` is read as a tag with HTML's rules (any case, any quoting, any whitespace). Parse loosely, emit strictly (decision of 2026-11-14,
//     replacing the earlier fail-closed rule that refused a whole post over one unknown tag): a tag from the fixed list of harmless text and
//     structure tags is written out again; any other tag is dropped and its text kept; the contents of script, style and the like are dropped with
//     them; comments and declarations vanish; a malformed "<" is plain text. What was left out is reported, so the reader can say so;
//   - each tag is then WRITTEN OUT AGAIN from what was parsed, with only the few attributes that tag may carry (each value checked and escaped);
//     every other attribute is dropped, never passed on. Nothing the browser will read comes from the raw input, so a difference between this
//     parser and the browser's cannot smuggle anything through, and no address-carrying attribute (src, srcset, background, poster, style with
//     url(), …) survives except a link's `href` and an image's `src`;
//   - images are decided as their tag is read: from the owner's own Studio they load; any other http(s) image waits behind a button (mode "click")
//     or loads (mode "always"); anything else is never loaded and is named in words.
export type ImageMode = "click" | "always";

export interface Rendered {
  fragment: DocumentFragment;
  /** Images waiting for a tap. */
  blocked: number;
  /** True when the post was not drawn because it holds markup the reader does not draw (the fragment says why). */
  refused: boolean;
  /** Load every image still waiting. */
  loadAll(): void;
}

const MARK = "data-blyg-wait";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(text: string): string {
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

/** The visible text of a post for a list, taken from the string (never inserted as markup, so an imperfect strip can only look odd). */
export function plainText(html: string): string {
  // Inline tags join their words to the text around them ("a <a>link</a>." stays "a link."); every other tag separates words.
  const INLINE = /<\/?(?:a|em|strong|b|i|s|del|code|sup|sub|span|mark|abbr|small)(?:\s[^>]*)?>/gi;
  return decode(html.replace(INLINE, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

const hostOf = (src: string): string | null => {
  try {
    const u = new URL(src);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
};

// ---- the tags a post may use: text and structure that load nothing and run nothing ------------------------------------------------------------
const TEXT_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "section", "address", "blockquote", "pre", "hr", "br", "wbr",
  "em", "strong", "b", "i", "u", "s", "del", "ins", "mark", "small", "sup", "sub", "abbr", "cite", "q", "dfn", "kbd", "samp", "var", "code", "time", "bdi", "bdo",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  "figure", "figcaption", "details", "summary", "a", "img",
]);
const VOID = new Set(["br", "hr", "wbr", "img"]);

/** What to write for an attribute, or null to drop it. The value is decoded; it is escaped when written. `base`: the post's own address. */
type AttrRule = (value: string, base: string | null) => string | null;
const textRule: AttrRule = (v) => (v.length <= 300 ? v : v.slice(0, 300));
const digitsRule = (max: number): AttrRule => (v) => (new RegExp(`^\\d{1,${max}}$`).test(v.trim()) ? v.trim() : null);
const alignRule: AttrRule = (v) => {
  const m = /^\s*text-align\s*:\s*(left|center|right)\s*;?\s*$/i.exec(v);
  return m ? `text-align:${(m[1] ?? "").toLowerCase()}` : null;
};
/** A link: http(s) or mailto, resolved against the post's address when it is relative; anything else (javascript:, data:, …) is dropped. */
const linkRule: AttrRule = (v, base) => {
  const raw = v.trim();
  if (raw === "") return null;
  try {
    const u = new URL(raw, base ?? undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return null;
    return /^(https?|mailto):/i.test(raw) ? raw : u.href;
  } catch {
    return null;
  }
};
const ATTRS: Record<string, Record<string, AttrRule>> = {
  a: { href: linkRule, title: textRule },
  img: { src: (v) => v, alt: textRule, title: textRule },
  abbr: { title: textRule },
  ol: { start: digitsRule(6) },
  code: { class: (v) => (/^language-[A-Za-z0-9_+#-]{1,40}$/.test(v.trim()) ? v.trim() : null) },
  th: { colspan: digitsRule(3), rowspan: digitsRule(3), style: alignRule },
  td: { colspan: digitsRule(3), rowspan: digitsRule(3), style: alignRule },
  time: { datetime: (v) => (/^[0-9TZ:+.\- ]{4,40}$/.test(v.trim()) ? v.trim() : null) },
  details: { open: () => "" },
  // A thread's quote (spec 0.4 §10; measured on an imported thread, whole and partial).
  blockquote: {
    class: (v) => (/^blyg-transclusion( blyg-partial)?$/.test(v.trim().replace(/\s+/g, " ")) ? v.trim().replace(/\s+/g, " ") : null),
    "data-blyg-id": (v) => (/^[a-z0-9]{1,64}$/.test(v.trim()) ? v.trim() : null),
    "data-blyg-version": digitsRule(9),
    // A remote source's origin (§10.2) and the author's own label for the quoted item (§10.1): data only, never an address the reader loads.
    "data-blyg-origin": (v) => (/^https?:\/\/[^\s"'<>]{1,300}$/i.test(v.trim()) ? v.trim() : null),
    "data-blyg-label": textRule,
  },
  // Generated text, disclosed by the publisher (§5.7): the class is a permanent wire token.
  div: { class: (v) => (v.trim() === "blyg-tk-gen" ? "blyg-tk-gen" : null) },
  span: { class: (v) => (v.trim() === "blyg-tk-gen" ? "blyg-tk-gen" : null) },
};
const TK_GEN_NOTE = "Marked by the publisher as generated text (their own disclosure, not verified)";

interface ParsedTag {
  closing: boolean;
  name: string;
  attrs: Map<string, string>;
  end: number;
}

/** One tag at the `<` at `lt`, parsed the way HTML parses it. Linear in the input; `error` says in words what was wrong. */
function readTag(html: string, lt: number): ParsedTag | { error: string } {
  const bad = { error: "a malformed tag" };
  let i = lt + 1;
  const closing = html[i] === "/";
  if (closing) i++;
  const nm = /[A-Za-z][^\s/>]*/y; // a browser's tag name runs to whitespace, "/" or ">" (custom elements have hyphens; "p=x" is a tag called "p=x")
  nm.lastIndex = i;
  const found = nm.exec(html);
  if (!found) return bad;
  const name = found[0].toLowerCase();
  i += found[0].length;
  if (i >= html.length) return bad;
  const attrs = new Map<string, string>();
  const ws = /\s*/y;
  const an = /[^\s"'<>/=]+/y;
  const unq = /[^\s"'=<>`]+/y;
  for (let n = 0; n < 60; n++) {
    ws.lastIndex = i;
    ws.exec(html);
    i = ws.lastIndex;
    const c = html[i];
    if (c === undefined) return bad;
    if (c === ">") return { closing, name, attrs, end: i + 1 };
    if (c === "/") {
      if (html[i + 1] === ">") return { closing, name, attrs, end: i + 2 };
      i++;
      continue;
    }
    an.lastIndex = i;
    const a = an.exec(html);
    if (!a) return bad;
    const key = a[0].toLowerCase();
    i += a[0].length;
    ws.lastIndex = i;
    ws.exec(html);
    i = ws.lastIndex;
    let value = "";
    if (html[i] === "=") {
      i++;
      ws.lastIndex = i;
      ws.exec(html);
      i = ws.lastIndex;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close < 0) return bad;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        unq.lastIndex = i;
        const u = unq.exec(html);
        if (!u) return bad;
        value = u[0];
        i += u[0].length;
      }
    }
    if (!attrs.has(key)) attrs.set(key, value);
  }
  return bad;
}

/** A tag written out again from what was parsed: its name and only the attributes it may carry, checked and escaped. */
function writeTag(name: string, attrs: Map<string, string>, base: string | null): string {
  const rules = ATTRS[name] ?? {};
  let out = `<${name}`;
  for (const [key, rule] of Object.entries(rules)) {
    const raw = attrs.get(key);
    if (raw === undefined) continue;
    const v = rule(decode(raw), base);
    if (v !== null) out += ` ${key}="${escapeHtml(v)}"`;
  }
  if (out.endsWith(' class="blyg-tk-gen"')) out += ` title="${TK_GEN_NOTE}"`;
  return `${out}>`;
}

export interface Rewrite {
  /** The text to hand to the sanitiser, or null when the post is too large (or too broken) to draw. */
  text: string | null;
  /** Why it was refused, in words (null when it was not). */
  reason: string | null;
  /** The tags that were left out (their text kept), by name, without repeats: so the reader can say that formatting was left out. */
  left: string[];
  /** Images left waiting for a tap, in the order of their markers. */
  waiting: Array<{ src: string; alt: string; host: string }>;
}

const MAX_POST = 2_000_000;
/** More malformed "<" than this in one post, and it is not a post worth drawing (and each costs a scan). */
const MAX_BROKEN = 2000;
/** Tags whose CONTENT goes with them: it is code, style, a template or text a browser would not read as tags, and nothing of it is for a reader. */
const DROP_CONTENT = new Set(["script", "style", "template", "noscript", "iframe", "object", "applet", "textarea", "title", "svg", "math", "xmp", "noembed", "noframes", "plaintext", "audio", "video", "canvas"]);

/** The pure part: what the text becomes before the sanitiser sees it (see the header). `baseUrl`: the post's own address, for relative links. */
export function rewriteImages(html: string, opts: { trustedOrigin: string | null; mode: ImageMode; baseUrl?: string | null }): Rewrite {
  const refuse = (reason: string): Rewrite => ({ text: null, reason, waiting: [], left: [] });
  if (html.length > MAX_POST) return refuse("a post larger than the reader draws");
  const base = opts.baseUrl ?? null;
  const trusted = opts.trustedOrigin === null ? null : `${opts.trustedOrigin.replace(/\/$/, "")}/`;
  const waiting: Rewrite["waiting"] = [];
  const left = new Set<string>();
  let broken = 0;
  let out = "";
  let at = 0;
  /** From `from` to just after the end of the next closing tag `</name…>` (any case), or to the end when there is none. `name` is one of DROP_CONTENT. */
  const skipClose = (from: number, name: string): number => {
    const re = new RegExp(`</${name}`, "gi");
    re.lastIndex = from;
    const m = re.exec(html);
    if (!m) return html.length;
    const end = html.indexOf(">", m.index);
    return end < 0 ? html.length : end + 1;
  };
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, lt);
    const next = html[lt + 1] ?? "";
    if (next === "!" || next === "?" || (next === "/" && !/[A-Za-z]/.test(html[lt + 2] ?? ""))) {
      // A comment, a declaration or what a browser takes for a hidden comment: gone, without a trace.
      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 4);
        at = end < 0 ? html.length : end + 3;
      } else {
        const end = html.indexOf(">", lt + 1);
        at = end < 0 ? html.length : end + 1;
      }
      continue;
    }
    if (!/[A-Za-z]/.test(next) && next !== "/") {
      out += "&lt;"; // "<" followed by a space, a digit or the like is plain text to a browser too
      at = lt + 1;
      continue;
    }
    const tag = readTag(html, lt);
    if ("error" in tag) {
      if (++broken > MAX_BROKEN) return refuse("too many malformed tags");
      out += "&lt;"; // a "<" that does not open a tag we can read is text
      at = lt + 1;
      continue;
    }
    at = tag.end;
    if (!TEXT_TAGS.has(tag.name)) {
      // Not a tag the reader draws: the tag goes, its text stays; code-like contents go with it.
      left.add(/^[a-z0-9-]{1,24}$/.test(tag.name) ? tag.name : "other"); // the name is shown to the reader: only a plain one, never the page's own text
      if (!tag.closing && DROP_CONTENT.has(tag.name) && !html.slice(lt, tag.end).endsWith("/>")) at = skipClose(tag.end, tag.name);
      continue;
    }
    if (tag.closing) {
      if (!VOID.has(tag.name)) out += `</${tag.name}>`; // "</br>" and "</img>" are nothing
      continue;
    }
    if (tag.name !== "img") {
      out += writeTag(tag.name, tag.attrs, base);
      continue;
    }
    let src = decode(tag.attrs.get("src") ?? "").trim();
    try {
      if (src !== "" && base !== null) src = new URL(src, base).href;
    } catch {
      // not an address: handled below as "not shown"
    }
    const alt = decode(tag.attrs.get("alt") ?? "").trim();
    const title = tag.attrs.get("title");
    const keep = (extra: string): string => `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title !== undefined ? ` title="${escapeHtml(textRule(decode(title), null) ?? "")}"` : ""}${extra}>`;
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
  return { text: out, reason: null, waiting, left: [...left].slice(0, 8) };
}

export function renderForeign(html: string, opts: { trustedOrigin: string | null; mode: ImageMode; baseUrl?: string | null }, sanitize: (html: string) => DocumentFragment): Rendered {
  const { text, reason, waiting, left } = rewriteImages(html, opts);
  if (text === null) {
    const fragment = createFragment((f) => f.createEl("p", { cls: "blyg-reader-blocked", text: `This post is not drawn here (${reason ?? "unknown"}). Open it in the browser.` }));
    return { fragment, blocked: 0, refused: true, loadAll: () => undefined };
  }
  const fragment = sanitize(text);
  if (left.length > 0) fragment.appendChild(createEl("p", { cls: "blyg-reader-formatnote", text: `Some formatting was left out (${left.map((n) => `<${n}>`).join(", ")}).` }));
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
