// The only way the plugin talks to GitHub (docs/SECURITY.md §1, §3). Requests are built from a path on
// https://api.github.com, so a token can never be sent to another host; the token is put into a header here and
// nowhere else; nothing it logs or throws contains it.
import type { Logger, Timers } from "./ports";
import { redact } from "./redact";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface RawRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** A binary body (an upload): sent instead of `body`. */
  bodyBytes?: ArrayBuffer;
  contentType?: string;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Performs one HTTP request and returns non-2xx statuses as normal responses; rejects only on network failure. */
export type RawTransport = (request: RawRequest) => Promise<RawResponse>;

export interface GithubRequest {
  method?: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  /** Path below the API origin, starting with "/", e.g. "/repos/o/r/contents/a%20b.md". Already percent-encoded. */
  path: string;
  query?: Record<string, string>;
  /** Serialised as JSON. */
  body?: unknown;
  /** Ask every cache between here and GitHub for a fresh answer (reads that decide what to write). */
  noCache?: boolean;
}

export interface GithubResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** Parsed body, or undefined when it is not JSON. */
  json: unknown;
}

export interface GithubHttp {
  send(token: string, request: GithubRequest): Promise<GithubResponse>;
}

/** A failure to get any response (network, timeout) or a refused request. The message is safe to show. */
export class HttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Percent-encode each segment of a repo path, keeping "/" (the macro does the same). */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createGithubHttp(deps: {
  transport: RawTransport;
  timers: Timers;
  logger?: Logger;
  timeoutMs?: number;
}): GithubHttp {
  const { transport, timers, logger } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(token, request) {
      const cleanToken = token.trim();
      if (cleanToken === "" || /\s/.test(cleanToken)) {
        throw new HttpError("The token is empty or contains spaces or line breaks. Paste it again in the keychain entry.");
      }
      const badPath =
        !request.path.startsWith("/") ||
        request.path.startsWith("//") ||
        request.path.includes("://") ||
        /[?#\\]/.test(request.path) ||
        request.path.split("/").some((segment) => segment === "." || segment === "..");
      if (badPath) {
        throw new HttpError("Refused: the request path is not a plain GitHub API path.");
      }

      const url = new URL(GITHUB_API_ORIGIN + request.path);
      for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
      if (url.origin !== GITHUB_API_ORIGIN) throw new HttpError("Refused: only api.github.com may receive the token.");
      if (url.href.includes(cleanToken)) throw new HttpError("Refused: the token must never be part of a URL.");

      const method = request.method ?? "GET";
      const raw: RawRequest = {
        url: url.href,
        method,
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      };
      if (request.noCache) {
        raw.headers["Cache-Control"] = "no-cache";
        raw.headers.Pragma = "no-cache";
      }
      if (request.body !== undefined) {
        raw.body = JSON.stringify(request.body);
        raw.contentType = "application/json";
      }

      logger?.debug(`${method} ${url.host}${url.pathname}`);

      let cancel = (): void => {};
      const timedOut = new Promise<never>((_, reject) => {
        cancel = timers.after(timeoutMs, () =>
          reject(new HttpError(`GitHub did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)),
        );
      });

      try {
        const res = await Promise.race([transport(raw), timedOut]);
        logger?.debug(`${method} ${url.host}${url.pathname} → ${res.status}`);
        return { status: res.status, headers: res.headers, text: res.text, json: tryParseJson(res.text) };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        throw new HttpError(`Network error: ${redact(detail, [cleanToken])}`);
      } finally {
        cancel();
      }
    },
  };
}
