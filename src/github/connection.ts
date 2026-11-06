import { createRunsClient } from "./deployStatus";
import { encodePath, headerValue, HttpError, type GithubHttp, type GithubResponse } from "../platform/http";
import type { Keychain } from "../platform/ports";
import { readToken } from "../platform/token";

export interface ConnectionTarget {
  owner: string;
  repo: string;
  branch: string;
  previewBranch: string;
  tokenSecretName: string;
  /** When true, also check that the token can read the site's workflow runs (deploy status). */
  watchDeploy?: boolean;
}

export interface CheckLine {
  level: "ok" | "info" | "warn" | "error";
  text: string;
}

export interface ConnectionReport {
  /** True when the token can write to the repository and the production branch exists. */
  ok: boolean;
  lines: CheckLine[];
}

const fail = (text: string): ConnectionReport => ({ ok: false, lines: [{ level: "error", text }] });

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function describeFailure(res: GithubResponse, what: string): string {
  if (res.status === 401) return "GitHub rejected the token (wrong or expired). Create a new token and enter it in the keychain entry.";
  if (res.status === 403) {
    return headerValue(res.headers, "x-ratelimit-remaining") === "0"
      ? "GitHub's rate limit is used up. Try again in a few minutes."
      : `GitHub refused access to ${what}. The token needs “Contents: read and write” on this repository.`;
  }
  if (res.status === 404) {
    return `${what} was not found, or the token has no access to it. Check owner and repository, and that the token was given this repository.`;
  }
  return `GitHub answered ${res.status} for ${what}.`;
}

/**
 * Read-only check: can this token reach the site repository and write to it, and do the two branches exist?
 * Makes GET requests only. The report never contains the token.
 */
export async function checkConnection(
  deps: { http: GithubHttp; keychain: Keychain },
  target: ConnectionTarget,
): Promise<ConnectionReport> {
  if (target.owner === "" || target.repo === "") return fail("Enter the repository owner and name first.");

  const tokenResult = readToken(deps.keychain, target.tokenSecretName);
  if (!tokenResult.ok) return fail(tokenResult.message);
  const { token } = tokenResult;

  const slug = `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const lines: CheckLine[] = [];

  try {
    const fresh = (): { _: string } => ({ _: `${Date.now().toString(36)}` }); // a URL nobody asked before: see contents.ts
    const repoRes = await deps.http.send(token, { path: `/repos/${slug}`, query: fresh(), noCache: true });
    if (repoRes.status !== 200) return fail(describeFailure(repoRes, `the repository ${target.owner}/${target.repo}`));

    const repo = asObject(repoRes.json);
    const permissions = asObject(repo.permissions);
    lines.push({ level: "ok", text: `Repository ${target.owner}/${target.repo} reachable.` });
    let canWrite = false;
    if (permissions.push === true) {
      canWrite = true;
      lines.push({ level: "ok", text: "The token can write to it." });
    } else if (permissions.push === false) {
      lines.push({ level: "error", text: "The token can read but not write. It needs “Contents: read and write”." });
    } else {
      lines.push({
        level: "warn",
        text: "GitHub did not report write permission. The first publish to the preview branch will show whether it works.",
      });
      canWrite = true;
    }

    let productionExists = false;
    for (const [label, name] of [
      ["Production", target.branch],
      ["Preview", target.previewBranch],
    ] as const) {
      const res = await deps.http.send(token, { path: `/repos/${slug}/branches/${encodePath(name)}`, query: fresh(), noCache: true });
      if (res.status === 200) {
        lines.push({ level: "ok", text: `${label} branch “${name}” exists.` });
        if (label === "Production") productionExists = true;
      } else if (res.status === 404) {
        lines.push({
          level: label === "Production" ? "error" : "warn",
          text:
            label === "Production"
              ? `Production branch “${name}” not found.`
              : `Preview branch “${name}” not found. Publishing to preview will not work until it exists.`,
        });
      } else {
        lines.push({ level: "error", text: describeFailure(res, `branch “${name}”`) });
      }
    }

    if (target.watchDeploy && productionExists) {
      const checks = await createRunsClient({ http: deps.http, token, owner: target.owner, repo: target.repo }).listRuns({ branch: target.branch });
      if (checks.kind === "ok") lines.push({ level: "ok", text: "The token can read deploy status." });
      else if (checks.kind === "no-access") {
        lines.push({
          level: "warn",
          text: "The token cannot read deploy status. Publishing works; to see “Deployed ✓” after each publish, give the token “Actions: Read-only” — or turn off “Watch deploys”.",
        });
      } else lines.push({ level: "warn", text: "Could not tell whether the token can read deploy status." });
    }

    return { ok: canWrite && productionExists && lines.every((l) => l.level !== "error"), lines };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : "Unexpected error while contacting GitHub.";
    return { ok: false, lines: [...lines, { level: "error", text: message }] };
  }
}

export function formatReport(report: ConnectionReport): string {
  const mark = { ok: "✓", info: "ⓘ", warn: "⚠", error: "✗" } as const;
  return report.lines.map((l) => `${mark[l.level]} ${l.text}`).join("\n");
}
