// Where a Studio is: its host, its optional mount, and the addresses derived from them. Pure; shared by the settings
// validation, the http adapter and the publish service, so they cannot disagree about what a usable address is.

import { devStudioProblem, LOOPBACK_HOSTS } from "./devLock";

export interface StudioAddress {
  /** "https://blyg.example.com" — scheme and host (and port), nothing else. The token is only ever sent here. */
  host: string;
  /** "" or "/blyg". */
  mount: string;
  /** The blyg's identity as the plugin stamps it into notes: host + mount + "/" ("https://blyg.example.com/"). */
  origin: string;
  /** Where the owner API lives: always at the host root, whatever the mount. */
  apiBase: string;
}

/** The reason an address is unusable, or null. Plain http is accepted for the local machine only (a Studio under test); the token must never cross a network in clear. */
export function studioBaseProblem(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "Must be an address like https://blyg.example.com";
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return "Must be an https:// address (plain http is accepted for localhost only).";
  }
  if (url.username !== "" || url.password !== "") return "Must not contain a user name or password.";
  if (url.search !== "" || url.hash !== "") return "Must not contain a query or fragment.";
  if (url.pathname !== "/") return "Only the host: put a path in “Mount” instead.";
  // The development build only talks to test Studios (devLock.ts); a no-op for the release build.
  return devStudioProblem(baseUrl);
}

/** The reason a mount is unusable, or null. Empty is fine (the Studio has its own host). */
export function studioMountProblem(mount: string): string | null {
  if (mount === "") return null;
  if (!/^(?:\/[A-Za-z0-9._~-]+)+$/.test(mount)) return "Empty, or a path like /blyg: leading “/”, no trailing “/”.";
  if (mount.split("/").some((s) => s === "." || s === "..")) return "No “.” or “..” segments.";
  return null;
}

/** The derived addresses, or null when the settings do not give a usable one. */
export function studioAddress(settings: { baseUrl: string; mount: string }): StudioAddress | null {
  if (studioBaseProblem(settings.baseUrl) !== null || studioMountProblem(settings.mount) !== null) return null;
  const host = new URL(settings.baseUrl).origin;
  return { host, mount: settings.mount, origin: `${host}${settings.mount}/`, apiBase: `${host}/api` };
}

/** A note's page on the Studio: `f/{id}/` for a fragment, `t/{id}/` for a thread. */
export function studioItemUrl(address: StudioAddress, kind: "fragment" | "thread", id: string): string {
  return `${address.origin}${kind === "thread" ? "t" : "f"}/${id}/`;
}
