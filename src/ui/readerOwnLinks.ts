// A link in an open post that points at one of the reader's OWN items opens the vault note that holds that item (the note whose frontmatter carries its id), not the web viewer.
// The id is read from the link's path (a published item lives at `<site>/t/<id>/` or similar); whether a note holds it is the host's call (`open` resolves false when none does), and
// then the link is opened as before. Pure string reading plus one click listener; text only.

/** The 26-character item id in a link's path, or null (no id, not a web link). */
export function ownItemIdOf(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.pathname.split("/").find((seg) => /^[0-9a-z]{26}$/i.test(seg)) ?? null;
}

/**
 * Route own-item links inside `body`. `open(id)` resolves true when a vault note was opened; on false the link goes to `fallback(url)` (the web, as it did before), so nothing is lost
 * when no published record maps the id to a note.
 */
export function routeOwnLinks(body: HTMLElement, open: (id: string) => Promise<boolean>, fallback: (url: string) => void): void {
  body.addEventListener("click", (e) => {
    const target = e.target;
    const a = target instanceof Element ? target.closest("a[href]") : null;
    const href = a?.getAttribute("href") ?? "";
    const id = ownItemIdOf(href);
    if (id === null) return;
    e.preventDefault();
    e.stopPropagation();
    void open(id).then((ok) => ok || fallback(href), () => fallback(href));
  });
}
