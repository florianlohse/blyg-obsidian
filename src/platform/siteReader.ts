// Reads a published item document from the blyg's own site (docs/SECURITY.md §3). A separate path from the GitHub client on
// purpose: this one never has a token, so a request to the site can never carry it; the GitHub client refuses every host but
// api.github.com, so a request to GitHub can never go to the site.
import { DEFAULT_TIMEOUT_MS, HttpError, type RawTransport } from "./http";
import type { Logger, SiteReader, Timers } from "./ports";

/** An item document is a few kilobytes; a megabyte means something is wrong (docs/SECURITY.md §3). */
export const MAX_BODY_CHARS = 1_000_000;

/** Name endings that mean "this machine or a local network" (checked on the name only: a public name can still point at a private address, which no check in the plugin can see). */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".corp", ".home"];

/** `https:` only, no credentials in the URL, and not a NAME that stands for this machine or a local network (names are checked, not the network behind them: docs/SECURITY.md §3). */
export function publicHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  // A trailing dot is the same name ("localhost." is localhost): strip it before the checks, or it walks round every one of them.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host.includes(".")) return null; // one label ("router", "nas"): a name that only a local network resolves
  if (PRIVATE_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return null;
  if (/^\[/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null; // IP literals, v4 and v6: a blyg has a name
  return url;
}

export function createSiteReader(deps: { transport: RawTransport; timers: Timers; logger?: Logger; timeoutMs?: number; nonce?: () => string }): SiteReader {
  const { transport, timers, logger } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let counter = 0;
  const nonce = deps.nonce ?? ((): string => `${Date.now().toString(36)}${(counter++).toString(36)}`);

  return {
    async getJson(rawUrl) {
      const url = publicHttpsUrl(rawUrl);
      if (!url) throw new HttpError("Refused: the site address must be a plain https address of a public site.");
      // Like the repository reads: this decides what is written, so no cache may answer it.
      url.searchParams.set("_", nonce());
      logger?.debug(`GET ${url.host}${url.pathname}`);

      let cancel = (): void => {};
      const timedOut = new Promise<never>((_, reject) => {
        cancel = timers.after(timeoutMs, () => reject(new HttpError(`The site did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
      });
      try {
        const res = await Promise.race([
          transport({ url: url.href, method: "GET", headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" } }),
          timedOut,
        ]);
        logger?.debug(`GET ${url.host}${url.pathname} → ${res.status}`);
        if (res.text.length > MAX_BODY_CHARS) throw new HttpError("The site's answer is unreasonably large; not reading it.");
        let json: unknown;
        try {
          json = res.text === "" ? undefined : (JSON.parse(res.text) as unknown);
        } catch {
          json = undefined;
        }
        return { status: res.status, json };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        cancel();
      }
    },
  };
}
