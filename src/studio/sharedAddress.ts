// The blyg address in a note made by the share sheet (HK6): the one web address the note names, or why there is none. Pure text in, text out: no
// network, no vault access. The caller hands the result to the existing address lookup (lookup.ts), which asks the Studio and no other site.
// Fails closed: no address, or two different ones, is never guessed at.
//
// What counts as an address: a markdown link `[label](https://…)`, a bare `https://…`, and a `url:` property in the note's frontmatter. Image
// embeds (`![alt](https://…)`) do not count (a template's `{{image}}` must not make a note ambiguous). The query and the fragment are dropped, as
// in `parseItemAddress` (a link from a share sheet carries tracking), and the same address named twice counts once.

export type SharedAddress =
  | { kind: "address"; url: string }
  /** No web address in the note. */
  | { kind: "none" }
  /** More than one distinct address; `count` of them. Nothing is chosen for the person. */
  | { kind: "ambiguous"; count: number };

/** A note longer than this is not a share-sheet note; only its start is read. */
const MAX_CHARS = 20000;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MD_LINK = /(!?)\[[^\]]*\]\(\s*(?:<([^>\s]*)>|([^)\s]*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const BARE = /https?:\/\/[^\s<>"'`\])}]+/gi;

/** One candidate made comparable: only http(s), no query, no fragment; null when it is not a usable address. */
function normalise(raw: string): string | null {
  const text = raw.trim().replace(/[.,;:!?]+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.hostname === "") return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** The `url` property of the frontmatter block (plain or quoted); the rest of the properties are ignored. */
function frontmatterUrl(block: string): string | null {
  const line = /^url\s*:\s*(.+?)\s*$/im.exec(block);
  if (!line) return null;
  return (line[1] ?? "").replace(/^["']|["']$/g, "");
}

export function extractSharedAddress(noteText: string): SharedAddress {
  let text = noteText.slice(0, MAX_CHARS);
  const found: string[] = [];
  const add = (raw: string | null | undefined): void => {
    const url = raw ? normalise(raw) : null;
    if (url !== null && !found.includes(url)) found.push(url);
  };
  const fm = FRONTMATTER.exec(text);
  if (fm) {
    add(frontmatterUrl(fm[1] ?? ""));
    text = text.slice(fm[0].length);
  }
  // Markdown links first, and cut out, so that the address inside one is not counted again as a bare one. An image embed is cut out and not counted.
  const rest = text.replace(MD_LINK, (_all, bang: string, angled: string | undefined, plain: string | undefined) => {
    if (bang === "") add(angled ?? plain);
    return " ";
  });
  for (const m of rest.matchAll(BARE)) add(m[0]);
  if (found.length === 0) return { kind: "none" };
  if (found.length > 1) return { kind: "ambiguous", count: found.length };
  return { kind: "address", url: found[0] ?? "" };
}
