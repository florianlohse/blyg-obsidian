// Deploy watching, wired to the settings: after a commit, wait for the site's checks and report the verdict.
import { actionsUrlOf, createRunsClient, describeDeploy, watchDeploy, type DeployReport } from "../github/deployStatus";
import type { GithubHttp } from "../platform/http";
import type { Clock, Keychain, Logger, Timers } from "../platform/ports";
import { redact } from "../platform/redact";
import { readToken } from "../platform/token";
import type { BlygSettings } from "../settings/schema";

export interface DeployEnv {
  settings: BlygSettings;
  keychain: Keychain;
  http: GithubHttp;
  timers: Timers;
  clock: Clock;
  logger?: Logger;
  /** True once the plugin is unloading: the wait ends quietly. */
  shouldStop?: () => boolean;
}

export interface WatchedCommit {
  branch: string;
  sha: string;
  /** The Blyg version this commit made, when it made one (not for essays and pages). */
  version?: number;
  /** The repo path the commit wrote: the panel shows the deploy only for the note that owns this path. */
  path?: string;
}

export interface DeployRecord extends WatchedCommit {
  report: DeployReport;
  /** When the verdict was reached. */
  at: Date;
}

/**
 * Wait for the deploy verdict of one commit. Returns null when there is nothing to say: watching is off, the token is
 * unavailable, or the plugin is unloading. Never throws; a problem becomes a report (the commit itself is unaffected).
 */
export async function watchCommit(
  env: DeployEnv,
  commit: WatchedCommit,
  opts: { firstDelayMs?: number } = {},
): Promise<DeployRecord | null> {
  const { github } = env.settings;
  if (!github.watchDeploy) return null;
  const token = readToken(env.keychain, github.tokenSecretName);
  if (!token.ok) return null;
  try {
    const result = await watchDeploy({
      checks: createRunsClient({ http: env.http, token: token.token, owner: github.owner, repo: github.repo }),
      timers: env.timers,
      clock: env.clock,
      sha: commit.sha,
      ...(opts.firstDelayMs !== undefined ? { firstDelayMs: opts.firstDelayMs } : {}),
      ...(env.shouldStop ? { shouldStop: env.shouldStop } : {}),
    });
    if (result.kind === "stopped") return null;
    const report = describeDeploy(result, {
      branch: commit.branch,
      actionsUrl: actionsUrlOf(github.owner, github.repo),
      ...(commit.version !== undefined ? { version: commit.version } : {}),
    });
    return { ...commit, report, at: env.clock.now() };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`deploy watch failed: ${redact(detail, [token.token])}`);
    return null;
  }
}
