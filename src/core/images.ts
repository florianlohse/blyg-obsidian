// Images in a note, for a Studio publish (roadmap S6). Pure: no vault, no network.
//
// A note embeds a vault image as `![[photo.png]]`, `![[photo.png|alt text]]` or `![alt text](photo.png)`. The Studio keeps uploaded media
// under an address that contains the file's SHA-256 (`…/media/<id>/<sha256>.<ext>`), so a note and the Studio's copy of it can be compared
// without asking the Studio anything: both are written in one *canonical* form, `![alt](blyg-media:<sha256>)`, before they are hashed.
// What goes over the wire is the same text with each canonical address replaced by the address the Studio gave the upload.
import { maskCode } from "./links";

/** What the Studio's media endpoint accepts (checked against Studio 0.58.0: png, jpeg, gif, webp, svg; at most 5 MB). */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Extensions that are plainly meant as pictures: the ones the Studio takes, and the usual ones it does not (refused with a reason). */
const PICTURE_EXTENSIONS = new Set([...Object.keys(IMAGE_MIME), "bmp", "heic", "heif", "avif", "tif", "tiff", "ico", "jfif"]);
export const MEDIA_SCHEME = "blyg-media:";

export interface ImageRef {
  /** Offsets of the whole embed in the text. */
  start: number;
  end: number;
  /** 1-based line. */
  line: number;
  form: "wiki" | "markdown";
  /** What the note calls the file: a link target (`photo.png`, `folder/photo.png`) or a relative path. */
  target: string;
  /** The text for readers who cannot see the image; empty when the note gave none. */
  alt: string;
}

const SIZE_ALIAS = /^\d+(?:x\d+)?$/;
const WIKI_EMBED = /!\[\[([^[\]\n]+?)\]\]/g;
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export const extensionOf = (path: string): string => {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** Alt text goes between `[` and `]` on one line. */
export const cleanAlt = (text: string): string => text.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();

/** Obsidian's `|300` or `|300x200` after an image name is a size, not a description (sizes are not carried over yet). */
const altFrom = (alias: string): string => (SIZE_ALIAS.test(alias.trim()) ? "" : cleanAlt(alias));

/** The destination of `![alt](dest "title")`: the path, without angle brackets and title, percent-decoded; null when it is not a file path. */
function markdownTarget(raw: string): string | null {
  let dest = raw.trim();
  if (dest.startsWith("<")) {
    const close = dest.indexOf(">");
    if (close < 0) return null;
    dest = dest.slice(1, close);
  } else {
    dest = dest.replace(/\s+(?:"[^"]*"|'[^']*')$/, "");
    if (/\s/.test(dest)) return null;
  }
  if (dest === "" || HAS_SCHEME.test(dest)) return null;
  try {
    return decodeURIComponent(dest);
  } catch {
    return dest;
  }
}

/** Every picture the note embeds from the vault, outside code, in order. Web addresses and embeds of notes are not pictures here. */
export function findImageRefs(text: string): ImageRef[] {
  const masked = maskCode(text);
  const lineOf = (offset: number): number => {
    let line = 1;
    for (let i = masked.indexOf("\n"); i !== -1 && i < offset; i = masked.indexOf("\n", i + 1)) line++;
    return line;
  };
  const found: ImageRef[] = [];
  for (const m of masked.matchAll(WIKI_EMBED)) {
    const start = m.index ?? 0;
    const inner = text.slice(start + 3, start + m[0].length - 2);
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).split("#")[0]?.trim() ?? "";
    if (!PICTURE_EXTENSIONS.has(extensionOf(target))) continue;
    found.push({ start, end: start + m[0].length, line: lineOf(start), form: "wiki", target, alt: bar < 0 ? "" : altFrom(inner.slice(bar + 1)) });
  }
  for (const m of masked.matchAll(MARKDOWN_IMAGE)) {
    const start = m.index ?? 0;
    // The masked text hides code; the real text is read at the same place.
    const whole = text.slice(start, start + m[0].length);
    const parts = /^!\[([^\]\n]*)\]\(([^)\n]+)\)$/.exec(whole);
    if (!parts) continue;
    const target = markdownTarget(parts[2] ?? "");
    if (target === null || !PICTURE_EXTENSIONS.has(extensionOf(target))) continue;
    const alt = (parts[1] ?? "").replace(/\|\s*\d+(?:x\d+)?\s*$/, "");
    found.push({ start, end: start + m[0].length, line: lineOf(start), form: "markdown", target, alt: cleanAlt(alt) });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `![alt](blyg-media:<sha256>)`: the form a picture is hashed in. */
export const canonicalImage = (alt: string, sha256: string): string => `![${alt}](${MEDIA_SCHEME}${sha256})`;

/** Replace each ref's text (`replacements[i]` for `refs[i]`, which are in order and do not overlap). */
export function replaceRefs(text: string, refs: ImageRef[], replacements: string[]): string {
  let out = "";
  let from = 0;
  refs.forEach((ref, i) => {
    out += text.slice(from, ref.start) + (replacements[i] ?? "");
    from = ref.end;
  });
  return out + text.slice(from);
}

const CANONICAL = new RegExp(`\\]\\(${MEDIA_SCHEME}([0-9a-f]{64})\\)`, "g");
/** An address the Studio gave an upload: `https://host/…/media/<id>/<sha256>.<ext>`. */
const STUDIO_MEDIA = /\]\(\s*https?:\/\/[^\s)]+\/media\/[0-9a-z]+\/([0-9a-f]{64})\.(?:png|jpg|jpeg|gif|webp|svg)\s*\)/gi;

/** Turn the Studio's media addresses into the canonical form, so the Studio's text and the note's text hash alike. */
export const canonicalizeStudioMedia = (text: string): string => text.replace(STUDIO_MEDIA, (_whole, sha: string) => `](${MEDIA_SCHEME}${sha.toLowerCase()})`);

/** The digests of the canonical pictures in a text, in order of first use. */
export function canonicalDigests(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(CANONICAL)) if (!seen.includes(m[1] ?? "")) seen.push(m[1] ?? "");
  return seen;
}

/** The text to send: each canonical picture gets the address the Studio gave its upload (`urls`: digest → address). */
export const withStudioAddresses = (text: string, urls: ReadonlyMap<string, string>): string =>
  text.replace(CANONICAL, (whole, sha: string) => {
    const url = urls.get(sha);
    return url === undefined ? whole : `](${url})`;
  });
