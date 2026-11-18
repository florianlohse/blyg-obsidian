// The publish window shows the Studio's rendering of the note. A picture the note embeds has no address on the Studio yet (it is uploaded only after
// the user confirms), so the preview is asked for with a stand-in address on the Studio's own host, which the Studio cannot serve: the window would
// show a broken image. This puts the picture from the vault in its place, after the sanitiser has run, and only for a stand-in the plugin made itself.
// Nothing else is touched: an address that is not exactly one of these stand-ins (a quoted item's image, anything foreign) stays as the sanitiser left it.

export interface LocalImage {
  /** The stand-in address sent to the Studio's preview, as it comes back in the rendered HTML. */
  src: string;
  /** The image file in the vault. */
  path: string;
}

interface ImageLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}
interface Root {
  querySelectorAll(selector: string): ArrayLike<ImageLike>;
}

/** Returns how many pictures were put in. `urlFor` gives the address Obsidian serves a vault file at, or null when the file is gone. */
export function showLocalImages(root: Root, images: readonly LocalImage[], urlFor: (path: string) => string | null): number {
  const byStandIn = new Map(images.map((i) => [i.src, i.path]));
  let count = 0;
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const path = byStandIn.get(img.getAttribute("src") ?? "");
    if (path === undefined) continue;
    const url = urlFor(path);
    if (url === null) continue;
    img.setAttribute("src", url);
    count++;
  }
  return count;
}
