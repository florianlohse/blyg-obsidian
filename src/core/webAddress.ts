// "Open on web" for plain routes (essays, pages): a route's web address is a template the user fills in once, because the
// plugin cannot know where a site shows a file or how it turns a file name into a URL. Blyg items need none (contract §3.5: `/f/{id}/`).
//
//   {site}  the site's origin for the active target, taken from the Blyg address (https://example.com/blyg/ → https://example.com)
//   {slug}  the file name lowercased, punctuation dropped, spaces to hyphens (github-slugger's rule: "Wrestling With Eels" → "wrestling-with-eels")
//   {name}  the file name as it is, without ".md"
//   {path}  the path below the route's vault folder, without ".md" (slashes kept)
//
// Only https addresses are ever opened: a hand-edited settings file cannot make the button open anything else.

const PLACEHOLDER = /\{([a-z]+)\}/g;
const KNOWN = new Set(["site", "slug", "name", "path"]);

/** github-slugger's rule, without the library: lowercase, keep letters, digits, marks, "-", "_" and spaces, then spaces → "-". */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** The site's origin from a Blyg address, or undefined when there is none: "https://example.com/blyg/" → "https://example.com". */
export function siteOrigin(blygAddress: string): string | undefined {
  try {
    const url = new URL(blygAddress);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export interface WebAddressContext {
  site: string | undefined;
  /** File name without extension, e.g. "Wrestling With Eels". */
  name: string;
  /** Path below the route's vault folder without extension, e.g. "series/Wrestling With Eels". */
  path: string;
}

/** The address for one note, or undefined when the template is empty, uses a placeholder it cannot fill, or does not end up https. */
export function expandWebAddress(template: string, ctx: WebAddressContext): string | undefined {
  const t = template.trim();
  if (t === "") return undefined;
  let usable = true;
  const result = t.replace(PLACEHOLDER, (_all, key: string) => {
    switch (key) {
      case "site":
        if (ctx.site === undefined) usable = false;
        return ctx.site ?? "";
      case "slug":
        return encodeURIComponent(slugOf(ctx.name));
      case "name":
        return encodeURIComponent(ctx.name);
      case "path":
        return ctx.path.split("/").map(encodeURIComponent).join("/");
      default:
        usable = false;
        return "";
    }
  });
  if (!usable) return undefined;
  try {
    const url = new URL(result);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A message for the settings screen when the template cannot work, or null. Empty is fine (the button is then not shown). */
export function checkWebAddress(template: string): string | null {
  const t = template.trim();
  if (t === "") return null;
  const unknown = [...t.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "").filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) return `Unknown placeholder {${unknown[0]}}. Use {site}, {slug}, {name} or {path}.`;
  if (expandWebAddress(t, { site: "https://example.com", name: "Name", path: "Name" }) === undefined) {
    return "Must become an https:// address, e.g. {site}/essays/{slug}/.";
  }
  return null;
}
