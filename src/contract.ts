// Constants that come from the plugin ⇄ site contract (docs/CONTRACT.md, version 2), not from a user's setup. The
// contract is the interface: when the canonical copy in the site repo changes, these change with it. A site that
// publishes its own limits (idea C in docs/STATUS.md) would replace them.

export const CONTRACT_VERSION = 2;

/** Fragments are at most this many characters (contract §3.2); the site's CI fails the build above it. */
export const CONTRACT_MAX_FRAGMENT_CAP = 1000;

/** Where Blyg item files live in the site repo (contract §2/§3). */
export const CONTRACT_ITEMS_DIR = "src/content/notes";

/** Where an item's page lives under the blyg's address: `f/{id}/` for a fragment, `t/{id}/` for a thread (contract §4; a withdrawn item keeps its kind's path). */
export function itemPagePath(kind: "fragment" | "thread", id: string): string {
  return `${kind === "thread" ? "t" : "f"}/${id}/`;
}
