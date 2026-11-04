import type { Route } from "../settings/schema";

/** First route whose prefix the vault path starts with, or null. A path matching no route is refused (fail closed). */
export function routeFor(routes: readonly Route[], path: string): Route | null {
  return routes.find((r) => r.vaultPrefix !== "" && path.startsWith(r.vaultPrefix)) ?? null;
}

/**
 * The folder a new item is made in: the active note's own Blyg or Studio folder if it is in one (you write where you are), else the first
 * Studio folder (the Studio is where publishing is heading, and a test folder must not land in the live blyg), else the first Blyg folder.
 */
export function newItemRoute(routes: readonly Route[], activePath: string | null): Route | null {
  const usable = routes.filter((r) => (r.mode === "blyg" || r.mode === "studio") && r.vaultPrefix !== "");
  const own = activePath === null ? null : routeFor(routes, activePath);
  if (own && usable.includes(own)) return own;
  return usable.find((r) => r.mode === "studio") ?? usable[0] ?? null;
}

export type PlainTarget =
  | { ok: true; rel: string; destPath: string }
  | { ok: false; reason: "not-markdown" | "unusable-path" | "no-destination" | "inside-blyg-folder" };

/** Where a plain-route note goes in the repo, or why it must be refused. */
export function resolvePlainTarget(
  route: Route,
  note: { path: string; extension: string },
  notesDir: string,
): PlainTarget {
  if (note.extension !== "md") return { ok: false, reason: "not-markdown" };
  const rel = note.path.slice(route.vaultPrefix.length);
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return { ok: false, reason: "unusable-path" };
  }
  if (!route.dest) return { ok: false, reason: "no-destination" };
  const destPath = `${route.dest}${rel}`;
  // Belt and braces: a plain route can never write into the Blyg folder.
  if (destPath.startsWith(`${notesDir}/`)) return { ok: false, reason: "inside-blyg-folder" };
  return { ok: true, rel, destPath };
}
