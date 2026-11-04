// Did the site deploy? After a commit, GitHub Actions builds, checks and uploads the site in one workflow run for that
// commit. This module reads those workflow runs (read-only; the token needs "Actions: Read-only") and waits, politely, for
// the verdict. (Check runs would be the narrower API, but fine-grained personal tokens have no "Checks" permission.)
//
// A finished commit is not a finished deploy: if the site's checks fail, the commit stays on the branch but nothing goes
// live. Everything here is a *report*; it never changes anything and its failure never affects the publish.
import { headerValue, type GithubHttp } from "../platform/http";
import type { Clock, Timers } from "../platform/ports";
import { redact } from "../platform/redact";

export interface RunInfo {
  /** GitHub's id of the workflow run (needed to ask which step failed). */
  id?: number;
  name: string;
  /** queued | in_progress | completed (GitHub may add values). */
  status: string;
  /** success | failure | cancelled | skipped | … ; null until the run has completed. */
  conclusion: string | null;
  url?: string;
}

export type RunsResult =
  | { kind: "ok"; runs: RunInfo[] }
  /** 403: the token may not read workflow runs (fine-grained tokens need “Actions: Read-only”). */
  | { kind: "no-access" }
  | { kind: "not-found" }
  | { kind: "error"; status: number; message: string };

export interface JobInfo {
  name: string;
  conclusion: string | null;
  steps: { name: string; conclusion: string | null }[];
}

export type JobsResult = { kind: "ok"; jobs: JobInfo[] } | { kind: "unavailable" };

export interface RunsClient {
  /** The jobs and steps of one run: used only to say *where* a failed run stopped. */
  listJobs(runId: number): Promise<JobsResult>;
  /** The workflow runs of one commit, or the newest run of a branch. */
  listRuns(filter: { sha: string } | { branch: string }): Promise<RunsResult>;
}

let nonceCounter = 0;
const defaultNonce = (): string => `${Date.now().toString(36)}${(nonceCounter++).toString(36)}`;

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** Reads must be fresh (a cached "in progress" would never turn into "done"): same measures as contents.ts. */
export function createRunsClient(deps: {
  http: GithubHttp;
  token: string;
  owner: string;
  repo: string;
  nonce?: () => string;
}): RunsClient {
  const nonce = deps.nonce ?? defaultNonce;
  const path = `/repos/${encodeURIComponent(deps.owner)}/${encodeURIComponent(deps.repo)}/actions/runs`;
  return {
    async listRuns(filter) {
      const res = await deps.http.send(deps.token, {
        path,
        query: { ...("sha" in filter ? { head_sha: filter.sha } : { branch: filter.branch, per_page: "1" }), _: nonce() },
        noCache: true,
      });
      if (res.status === 403) {
        return headerValue(res.headers, "x-ratelimit-remaining") === "0"
          ? { kind: "error", status: 403, message: "GitHub's rate limit is used up." }
          : { kind: "no-access" };
      }
      if (res.status === 404) return { kind: "not-found" };
      if (res.status !== 200) {
        const message = redact(typeof asObject(res.json).message === "string" ? (asObject(res.json).message as string) : "", [deps.token]);
        return { kind: "error", status: res.status, message: message.slice(0, 200) };
      }
      const list = asObject(res.json).workflow_runs;
      if (!Array.isArray(list)) return { kind: "error", status: 200, message: "GitHub's answer had no list of workflow runs." };
      const runs = list.flatMap((entry: unknown): RunInfo[] => {
        const o = asObject(entry);
        if (typeof o.name !== "string" || typeof o.status !== "string") return [];
        const run: RunInfo = { name: o.name, status: o.status, conclusion: typeof o.conclusion === "string" ? o.conclusion : null };
        if (typeof o.id === "number") run.id = o.id;
        if (typeof o.html_url === "string") run.url = o.html_url;
        return [run];
      });
      return { kind: "ok", runs };
    },

    async listJobs(runId) {
      if (!Number.isSafeInteger(runId) || runId <= 0) return { kind: "unavailable" };
      const res = await deps.http.send(deps.token, { path: `${path}/${runId}/jobs`, query: { _: nonce() }, noCache: true });
      const list = asObject(res.json).jobs;
      if (res.status !== 200 || !Array.isArray(list)) return { kind: "unavailable" };
      const jobs = list.flatMap((entry: unknown): JobInfo[] => {
        const o = asObject(entry);
        if (typeof o.name !== "string") return [];
        const steps = Array.isArray(o.steps)
          ? o.steps.flatMap((s: unknown) => {
              const so = asObject(s);
              return typeof so.name === "string" ? [{ name: so.name, conclusion: typeof so.conclusion === "string" ? so.conclusion : null }] : [];
            })
          : [];
        return [{ name: o.name, conclusion: typeof o.conclusion === "string" ? o.conclusion : null, steps }];
      });
      return { kind: "ok", jobs };
    },
  };
}

/** What the workflow runs of one commit add up to, right now. */
export type Verdict =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "deployed"; url?: string; runId?: number }
  | { kind: "failed"; names: string[]; url?: string; runId?: number; step?: string }
  /** Cancelled: usually replaced by a newer run, not a failure of the content. */
  | { kind: "superseded"; url?: string }
  | { kind: "skipped" };

const FAILING = new Set(["failure", "timed_out", "startup_failure", "action_required", "stale"]);
const PASSING = new Set(["success", "neutral"]);

export function judgeRuns(runs: readonly RunInfo[]): Verdict {
  if (runs.length === 0) return { kind: "none" };
  const failed = runs.filter((r) => r.status === "completed" && r.conclusion !== null && FAILING.has(r.conclusion));
  if (failed.length > 0) {
    const url = failed[0]?.url;
    const runId = failed[0]?.id;
    return { kind: "failed", names: failed.map((r) => r.name), ...(url ? { url } : {}), ...(runId !== undefined ? { runId } : {}) };
  }
  const cancelled = runs.find((r) => r.status === "completed" && r.conclusion === "cancelled");
  if (cancelled) return { kind: "superseded", ...(cancelled.url ? { url: cancelled.url } : {}) };
  if (runs.some((r) => r.status !== "completed")) return { kind: "pending" };
  const passed = runs.find((r) => r.conclusion !== null && PASSING.has(r.conclusion));
  if (passed) return { kind: "deployed", ...(passed.url ? { url: passed.url } : {}), ...(passed.id !== undefined ? { runId: passed.id } : {}) };
  return { kind: "skipped" };
}

export type DeployResult =
  | Exclude<Verdict, { kind: "none" | "pending" }>
  /**
   * The run is green but its Deploy step was skipped: the site's guard found a newer commit on the branch and left the upload to that
   * commit's run (T0, 2026-10-19). Nothing is wrong; this publish just did not deploy by itself.
   */
  | { kind: "replaced"; url?: string }
  /** A run was seen but had not finished when the waiting time ran out. */
  | { kind: "timeout" }
  /** No workflow run ever appeared for the commit (the site's workflow did not start). */
  | { kind: "no-checks" }
  | { kind: "no-access" }
  | { kind: "error"; message: string }
  | { kind: "stopped" };

export interface WatchOptions {
  checks: RunsClient;
  timers: Timers;
  clock: Clock;
  sha: string;
  /** Wait before the first look, then between looks. Defaults: 8 s, 15 s. */
  firstDelayMs?: number;
  intervalMs?: number;
  /** Give up on a verdict after this long. Default 5 minutes. */
  maxMs?: number;
  /** Give up when no run exists at all after this long. Default 90 s. */
  noChecksAfterMs?: number;
  /** Polled between looks: true ends the wait quietly (plugin unloaded). */
  shouldStop?: () => boolean;
}

/** Say *where* a failed run stopped (the first failed step). Best effort: any trouble just leaves the step out. */
async function withFailedStep(checks: RunsClient, verdict: Extract<Verdict, { kind: "failed" }>): Promise<DeployResult> {
  if (verdict.runId === undefined) return verdict;
  try {
    const jobs = await checks.listJobs(verdict.runId);
    if (jobs.kind !== "ok") return verdict;
    for (const job of jobs.jobs) {
      const step = job.steps.find((s) => s.conclusion === "failure");
      if (step) return { ...verdict, step: step.name.slice(0, 100) };
    }
  } catch {
    // ignore: the verdict stands without the step
  }
  return verdict;
}

/**
 * A green run whose Deploy step did not run: the guard stopped it because a newer commit had landed. Best effort like the failed step: if
 * the jobs cannot be read the run is reported as deployed, as before.
 */
async function withSkippedDeploy(checks: RunsClient, verdict: Extract<Verdict, { kind: "deployed" }>): Promise<DeployResult> {
  const { runId, url } = verdict;
  if (runId === undefined) return verdict;
  try {
    const jobs = await checks.listJobs(runId);
    if (jobs.kind !== "ok") return verdict;
    const skipped = jobs.jobs.some((job) => job.steps.some((step) => /^deploy/i.test(step.name) && step.conclusion === "skipped"));
    if (skipped) return { kind: "replaced", ...(url ? { url } : {}) };
  } catch {
    // ignore: the verdict stands
  }
  return verdict;
}

const sleep = (timers: Timers, ms: number): Promise<void> => new Promise((resolve) => void timers.after(ms, resolve));

/** Wait for the deploy verdict of a commit. Never throws. */
export async function watchDeploy(opts: WatchOptions): Promise<DeployResult> {
  const interval = opts.intervalMs ?? 15_000;
  const first = opts.firstDelayMs ?? 8_000;
  const maxMs = opts.maxMs ?? 300_000;
  const noChecksAfter = opts.noChecksAfterMs ?? 90_000;
  const started = opts.clock.now().getTime();
  let failures = 0;
  let lastMessage = "";
  let sawChecks = false;

  await sleep(opts.timers, first);
  for (;;) {
    if (opts.shouldStop?.()) return { kind: "stopped" };
    const elapsed = opts.clock.now().getTime() - started;

    let result: RunsResult | null = null;
    try {
      result = await opts.checks.listRuns({ sha: opts.sha });
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : "Network error.";
    }
    if (result?.kind === "no-access") return { kind: "no-access" };
    if (result?.kind === "ok") {
      failures = 0;
      const verdict = judgeRuns(result.runs);
      if (verdict.kind === "failed") return await withFailedStep(opts.checks, verdict);
      if (verdict.kind === "deployed") return await withSkippedDeploy(opts.checks, verdict);
      if (verdict.kind !== "none" && verdict.kind !== "pending") return verdict;
      if (verdict.kind === "pending") sawChecks = true;
      if (verdict.kind === "none" && elapsed >= noChecksAfter) return { kind: "no-checks" };
    } else {
      // A hiccup (network, a 5xx, "not found yet") is tolerated a few times before it counts as a problem.
      failures += 1;
      if (result && result.kind === "error") lastMessage = result.message || `GitHub answered ${result.status}.`;
      if (result && result.kind === "not-found") lastMessage = "GitHub does not know this commit yet.";
      if (failures >= 4) return { kind: "error", message: lastMessage };
    }

    if (elapsed + interval > maxMs) return sawChecks ? { kind: "timeout" } : { kind: "no-checks" };
    await sleep(opts.timers, interval);
  }
}

export interface DeployReport {
  result: DeployResult;
  /** One or two plain sentences for a notice. */
  text: string;
  /** Needs attention (shown longer). */
  attention: boolean;
}

/** Words for each result. `actionsUrl` is the repository's Actions page, for when the plugin cannot say more. */
export function describeDeploy(result: DeployResult, ctx: { branch: string; actionsUrl: string; version?: number }): DeployReport {
  const { branch, actionsUrl } = ctx;
  const commitFine = "Your commit is fine.";
  switch (result.kind) {
    case "deployed":
      return { result, attention: false, text: `Deployed ✓ — the checks passed and the site (${branch}) was updated.` };
    case "replaced":
      return {
        result,
        attention: false,
        text: `Not deployed by itself — a newer publish on ${branch} replaced this one. Its deploy includes this change once its own checks pass. Your commit is on ${branch}.${result.url ? ` Details: ${result.url}` : ""}`,
      };
    case "failed": {
      const where = result.url ?? actionsUrl;
      const asVersion = ctx.version !== undefined ? ` (v${ctx.version})` : "";
      const next = ctx.version !== undefined ? ` (that becomes v${ctx.version + 1}: version numbers only go up)` : "";
      const stopped = result.step ? ` It stopped at the step “${result.step}”.` : "";
      return {
        result,
        attention: true,
        text: `Checks failed ✗ — nothing went live.${stopped} Your commit${asVersion} is on ${branch}, but the site did not change. Fix the cause and publish again${next}: the next deploy that passes includes everything committed so far. Details: ${where}`,
      };
    }
    case "superseded":
      return {
        result,
        attention: true,
        text: `The deploy was cancelled — usually because a newer one replaced it. Run “Show deploy status” to look at the latest, or see ${actionsUrl}`,
      };
    case "skipped":
      return {
        result,
        attention: true,
        text: `The deploy was skipped for ${branch} — nothing went live. The site only deploys its production and preview branches. ${actionsUrl}`,
      };
    case "timeout":
      return { result, attention: true, text: `Still deploying after 5 minutes. Run “Show deploy status” later, or see ${actionsUrl}` };
    case "no-checks":
      return {
        result,
        attention: true,
        text: `No deploy started for this commit. ${commitFine} Check that the site's workflow is enabled: ${actionsUrl}`,
      };
    case "no-access":
      return {
        result,
        attention: true,
        text: `Cannot read the deploy status: the token needs “Actions: Read-only” on the site repository (or turn off “Watch deploys” in the settings). ${commitFine}`,
      };
    case "error":
      return { result, attention: true, text: `Could not read the deploy status (${result.message}). ${commitFine} See ${actionsUrl}` };
    case "stopped":
      return { result, attention: false, text: "" };
  }
}

export const actionsUrlOf = (owner: string, repo: string): string =>
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
