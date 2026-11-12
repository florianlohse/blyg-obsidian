// The only way the plugin talks to a Studio (docs/SECURITY.md §1, §3). Requests are built from a path below the Studio's
// configured host, so the token can never be sent anywhere else; it is put into a header here and nowhere else; nothing this
// file logs or throws contains it. Mirrors platform/http.ts (GitHub) on purpose: a different host, a different token.
import { DEFAULT_TIMEOUT_MS, headerValue, HttpError, type RawTransport, type RawRequest } from "../platform/http";
import type { Logger, Timers } from "../platform/ports";
import { redact } from "../platform/redact";
import type { StudioAddress } from "./address";
import { buildMultipart, newBoundary, type MultipartFile } from "./multipart";

/** A Studio answers in a few kilobytes; anything larger than this is not an answer to a question the plugin asked. */
export const MAX_RESPONSE_CHARS = 4_000_000;
/** Studio's owner write budget is 120 a minute; a 429 says when to come back. We wait for that at most this long, twice. */
const MAX_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 3;

export interface StudioRequest {
  method?: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  /** "api" — below {host}/api, with the token; "public" — below {host}{mount}, without credentials (the manifest). */
  area: "api" | "public";
  /** Path below the area, starting with "/". Already percent-encoded. */
  path: string;
  query?: Record<string, string>;
  /** Serialised as JSON. */
  body?: unknown;
  /** Sent as multipart/form-data instead of `body` (a media upload). */
  multipart?: { fields: Record<string, string>; file: MultipartFile };
}

export interface StudioResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** Parsed body, or undefined when it is not JSON. */
  json: unknown;
}

export interface StudioHttp {
  /** `token` is required for area "api" and never sent for area "public". */
  send(token: string | null, request: StudioRequest): Promise<StudioResponse>;
}

function tryParseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const sleep = (timers: Timers, ms: number): Promise<void> => new Promise((resolve) => void timers.after(ms, resolve));

function retryAfterMs(headers: Record<string, string>): number | null {
  const seconds = Number(headerValue(headers, "retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

export function createStudioHttp(deps: {
  transport: RawTransport;
  timers: Timers;
  address: StudioAddress;
  logger?: Logger;
  timeoutMs?: number;
}): StudioHttp {
  const { transport, timers, address, logger } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(token, request) {
      const cleanToken = token?.trim() ?? null;
      if (request.area === "api") {
        if (cleanToken === null || cleanToken === "" || /\s/.test(cleanToken)) {
          throw new HttpError("The Studio token is empty or contains spaces or line breaks. Paste it again in the keychain entry.");
        }
      }
      const badPath =
        !request.path.startsWith("/") ||
        request.path.startsWith("//") ||
        request.path.includes("://") ||
        /[?#\\]/.test(request.path) ||
        request.path.split("/").some((segment) => segment === "." || segment === "..");
      if (badPath) throw new HttpError("Refused: the request path is not a plain Studio path.");

      const base = request.area === "api" ? address.apiBase : `${address.host}${address.mount}`;
      const url = new URL(base + request.path);
      for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
      if (url.origin !== address.host) throw new HttpError("Refused: only the configured Studio may receive the token.");
      if (cleanToken && url.href.includes(cleanToken)) throw new HttpError("Refused: the token must never be part of a URL.");

      const method = request.method ?? "GET";
      const raw: RawRequest = { url: url.href, method, headers: { Accept: "application/json" } };
      if (request.area === "api" && cleanToken) raw.headers.Authorization = `Bearer ${cleanToken}`;
      if (request.area === "api" && method === "GET") {
        // Reads decide what gets written: never from a cache (see github/contents.ts for what iOS did to the GitHub ones).
        raw.headers["Cache-Control"] = "no-cache";
        raw.headers.Pragma = "no-cache";
      }
      if (request.body !== undefined) {
        raw.body = JSON.stringify(request.body);
        raw.contentType = "application/json";
      }

      if (request.multipart) {
        const built = buildMultipart(newBoundary(), request.multipart.fields, request.multipart.file);
        raw.bodyBytes = built.body;
        raw.contentType = built.contentType;
      }

      const label = `${method} ${url.host}${url.pathname}`;
      for (let attempt = 1; ; attempt++) {
        logger?.debug(label);
        let cancel = (): void => {};
        const timedOut = new Promise<never>((_, reject) => {
          cancel = timers.after(timeoutMs, () => reject(new HttpError(`The Studio did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
        });
        let res;
        try {
          res = await Promise.race([transport(raw), timedOut]);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const detail = err instanceof Error ? err.message : String(err);
          throw new HttpError(`Network error: ${redact(detail, cleanToken ? [cleanToken] : [])}`);
        } finally {
          cancel();
        }
        logger?.debug(`${label} → ${res.status}`);
        if (res.text.length > MAX_RESPONSE_CHARS) throw new HttpError("The Studio's answer is far larger than expected; the plugin ignores it.");

        // 429: the request was not processed, so asking again is safe for writes too. Wait as long as told, within reason.
        if (res.status === 429 && attempt < MAX_ATTEMPTS) {
          const wait = retryAfterMs(res.headers) ?? 2000;
          if (wait <= MAX_WAIT_MS) {
            await sleep(timers, wait);
            continue;
          }
        }
        return { status: res.status, headers: res.headers, text: res.text, json: tryParseJson(res.text) };
      }
    },
  };
}
