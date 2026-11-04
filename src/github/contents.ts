// GitHub contents API: read a file, list a directory, write a file (one file per commit, sha-checked).
// Statuses are returned as typed results; only network failures and timeouts throw (HttpError).
import { fromBase64Utf8, toBase64Utf8 } from "../core/hash";
import { redact } from "../platform/redact";
import { encodePath, type GithubHttp } from "../platform/http";

export type GetFileResult =
  | { kind: "found"; sha: string; text: string }
  | { kind: "not-found" }
  | { kind: "error"; status: number; message: string };

export type ListDirResult =
  | { kind: "found"; names: string[] }
  | { kind: "not-found" }
  | { kind: "error"; status: number; message: string };

export interface PutFileRequest {
  path: string;
  text: string;
  message: string;
  branch: string;
  /** The blob sha read just before; required to update an existing file. */
  sha?: string;
}

export type PutFileResult =
  | { kind: "ok"; created: boolean; sha: string | undefined; /** The new commit: what the site's checks run on. */ commitSha: string | undefined }
  /** 409/422: another device wrote first, or the sha was missing/stale. Never retried blindly (contract §1). */
  | { kind: "conflict"; status: number }
  /** 404: the repository or branch does not exist (or the token cannot see it). */
  | { kind: "not-found" }
  | { kind: "error"; status: number; message: string };

export interface ContentsClient {
  getFile(path: string, ref: string): Promise<GetFileResult>;
  listDir(path: string, ref: string): Promise<ListDirResult>;
  putFile(request: PutFileRequest): Promise<PutFileResult>;
}

function apiMessage(json: unknown, token: string): string {
  const message =
    typeof json === "object" && json !== null && "message" in json && typeof json.message === "string"
      ? json.message
      : "";
  return redact(message, [token]).slice(0, 200);
}

let nonceCounter = 0;
/** A value nobody has sent before: makes the URL of every read unique. */
const defaultNonce = (): string => `${Date.now().toString(36)}${(nonceCounter++).toString(36)}`;

/**
 * Reads decide what gets written, so they must never be answered from a cache. GitHub marks contents responses as
 * cacheable for a minute and the app's HTTP layer on iOS honours that: right after a withdraw, the next read still
 * returned the version from before it (found on the iPad, 2026-10-07). Hence a no-cache request AND a URL that is
 * different every time (a parameter GitHub ignores), so even a cache that ignores headers cannot match it.
 */
export function createContentsClient(deps: {
  http: GithubHttp;
  token: string;
  owner: string;
  repo: string;
  nonce?: () => string;
}): ContentsClient {
  const { http, token } = deps;
  const nonce = deps.nonce ?? defaultNonce;
  const base = `/repos/${encodeURIComponent(deps.owner)}/${encodeURIComponent(deps.repo)}/contents/`;

  return {
    async getFile(path, ref) {
      const res = await http.send(token, { path: base + encodePath(path), query: { ref, _: nonce() }, noCache: true });
      if (res.status === 404) return { kind: "not-found" };
      if (res.status !== 200) return { kind: "error", status: res.status, message: apiMessage(res.json, token) };
      const body = res.json;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { kind: "error", status: 200, message: "That path is a folder, not a file." };
      }
      const { sha, content, encoding } = body as Record<string, unknown>;
      if (typeof sha !== "string" || typeof content !== "string" || encoding !== "base64") {
        return { kind: "error", status: 200, message: "GitHub returned the file in a form the plugin cannot read (too large?)." };
      }
      return { kind: "found", sha, text: fromBase64Utf8(content) };
    },

    async listDir(path, ref) {
      const res = await http.send(token, { path: base + encodePath(path), query: { ref, _: nonce() }, noCache: true });
      if (res.status === 404) return { kind: "not-found" };
      if (res.status !== 200) return { kind: "error", status: res.status, message: apiMessage(res.json, token) };
      if (!Array.isArray(res.json)) return { kind: "error", status: 200, message: "That path is a file, not a folder." };
      const names = res.json.flatMap((entry: unknown) =>
        typeof entry === "object" && entry !== null && "name" in entry && typeof entry.name === "string"
          ? [entry.name]
          : [],
      );
      return { kind: "found", names };
    },

    async putFile(request) {
      const res = await http.send(token, {
        method: "PUT",
        path: base + encodePath(request.path),
        body: {
          message: request.message,
          content: toBase64Utf8(request.text),
          branch: request.branch,
          ...(request.sha ? { sha: request.sha } : {}),
        },
      });
      if (res.status === 200 || res.status === 201) {
        const content = typeof res.json === "object" && res.json !== null && "content" in res.json ? res.json.content : null;
        const sha =
          typeof content === "object" && content !== null && "sha" in content && typeof content.sha === "string"
            ? content.sha
            : undefined;
        const commit = typeof res.json === "object" && res.json !== null && "commit" in res.json ? res.json.commit : null;
        const commitSha =
          typeof commit === "object" && commit !== null && "sha" in commit && typeof commit.sha === "string" ? commit.sha : undefined;
        return { kind: "ok", created: res.status === 201, sha, commitSha };
      }
      if (res.status === 409 || res.status === 422) return { kind: "conflict", status: res.status };
      if (res.status === 404) return { kind: "not-found" };
      return { kind: "error", status: res.status, message: apiMessage(res.json, token) };
    },
  };
}
