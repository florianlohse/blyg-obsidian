import { describe, expect, it } from "vitest";
import { watchCommit, type DeployEnv } from "../src/app/deploy";
import {
  actionsUrlOf,
  createRunsClient,
  describeDeploy,
  type DeployResult,
  judgeRuns,
  watchDeploy,
  type RunInfo,
  type JobsResult,
  type RunsResult,
  type RunsClient,
} from "../src/github/deployStatus";
import type { Timers } from "../src/platform/ports";
import { defaultSettings } from "../src/settings/schema";
import { fakeGithub, fakeKeychain, json, TOKEN } from "./helpers";

const run = (name: string, status: string, conclusion: string | null = null, url?: string): RunInfo => ({
  name,
  status,
  conclusion,
  ...(url ? { url } : {}),
});

/** A clock that only moves when the code under test sleeps, and a record of every sleep. */
function fakeTime(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  const timers: Timers = {
    after: (ms, fn) => {
      sleeps.push(ms);
      t += ms;
      queueMicrotask(fn);
      return () => {};
    },
  };
  return { timers, clock: { now: () => new Date(t) }, sleeps };
}

/** A scripted checks client: answers in order; the last answer repeats. */
function script(
  answers: (RunsResult | Error)[],
  jobs: JobsResult | Error = { kind: "unavailable" },
): RunsClient & { calls: string[]; jobCalls: number[] } {
  const calls: string[] = [];
  const jobCalls: number[] = [];
  return {
    calls,
    jobCalls,
    listJobs: (runId) => {
      jobCalls.push(runId);
      return jobs instanceof Error ? Promise.reject(jobs) : Promise.resolve(jobs);
    },
    listRuns: (filter) => {
      calls.push("sha" in filter ? filter.sha : `branch:${filter.branch}`);
      const next = answers[Math.min(calls.length - 1, answers.length - 1)];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as RunsResult);
    },
  };
}
const ok = (...runs: RunInfo[]): RunsResult => ({ kind: "ok", runs });

describe("judgeRuns", () => {
  it("none, pending, deployed", () => {
    expect(judgeRuns([]).kind).toBe("none");
    expect(judgeRuns([run("deploy", "queued")]).kind).toBe("pending");
    expect(judgeRuns([run("deploy", "in_progress")]).kind).toBe("pending");
    expect(judgeRuns([run("deploy", "completed", "success", "https://x/1")])).toEqual({ kind: "deployed", url: "https://x/1" });
  });

  it("a failed run wins over everything, and names the run", () => {
    const v = judgeRuns([run("lint", "completed", "success"), run("deploy", "completed", "failure", "https://x/2"), run("other", "in_progress")]);
    expect(v).toEqual({ kind: "failed", names: ["deploy"], url: "https://x/2" });
    for (const conclusion of ["timed_out", "startup_failure", "action_required"]) {
      expect(judgeRuns([run("deploy", "completed", conclusion)]).kind).toBe("failed");
    }
  });

  it("cancelled is superseded, not failed", () => {
    expect(judgeRuns([run("deploy", "completed", "cancelled")]).kind).toBe("superseded");
  });

  it("not finished while any run is still going, even if another passed", () => {
    expect(judgeRuns([run("a", "completed", "success"), run("b", "in_progress")]).kind).toBe("pending");
  });

  it("only skipped runs is not 'deployed'", () => {
    expect(judgeRuns([run("deploy", "completed", "skipped")]).kind).toBe("skipped");
  });
});

describe("createRunsClient", () => {
  const client = (handler: Parameters<typeof fakeGithub>[0]) => {
    const g = fakeGithub(handler);
    return { ...g, checks: createRunsClient({ http: g.http, token: TOKEN, owner: "o", repo: "r", nonce: () => "n1" }) };
  };

  it("reads the commit's workflow runs with a fresh, uncached GET", async () => {
    const { checks, requests } = client(() =>
      json(200, { total_count: 1, workflow_runs: [{ name: "deploy", status: "completed", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/1" }, { bogus: true }] }),
    );
    const res = await checks.listRuns({ sha: "abc123" });
    expect(res).toEqual({ kind: "ok", runs: [{ name: "deploy", status: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/1" }] });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req?.method).toBe("GET");
    expect(new URL(req?.url ?? "").pathname).toBe("/repos/o/r/actions/runs");
    expect(new URL(req?.url ?? "").searchParams.get("head_sha")).toBe("abc123");
    expect(new URL(req?.url ?? "").searchParams.get("_")).toBe("n1");
    expect(req?.headers["Cache-Control"]).toBe("no-cache");
  });

  it("can ask for a branch's newest run instead (Check connection)", async () => {
    const { checks, requests } = client(() => json(200, { workflow_runs: [] }));
    expect(await checks.listRuns({ branch: "main" })).toEqual({ kind: "ok", runs: [] });
    const q = new URL(requests[0]?.url ?? "").searchParams;
    expect([q.get("branch"), q.get("per_page"), q.get("head_sha")]).toEqual(["main", "1", null]);
  });

  it("403 is no-access (a token without Actions: read); a used-up rate limit is not", async () => {
    expect(await client(() => json(403, { message: "Resource not accessible by personal access token" })).checks.listRuns({ sha: "a" })).toEqual({ kind: "no-access" });
    const limited = await client(() => json(403, { message: "rate" }, { "x-ratelimit-remaining": "0" })).checks.listRuns({ sha: "a" });
    expect(limited.kind).toBe("error");
  });

  it("404, 500 and a surprising body are reported, never thrown, and never echo the token", async () => {
    expect((await client(() => json(404, {})).checks.listRuns({ sha: "a" })).kind).toBe("not-found");
    const boom = await client(() => json(500, { message: `oops ${TOKEN}` })).checks.listRuns({ sha: "a" });
    expect(boom).toMatchObject({ kind: "error", status: 500 });
    expect(JSON.stringify(boom)).not.toContain(TOKEN);
    expect((await client(() => json(200, { nothing: 1 })).checks.listRuns({ sha: "a" })).kind).toBe("error");
  });
});

describe("watchDeploy", () => {
  const watch = (checks: RunsClient, extra: Partial<Parameters<typeof watchDeploy>[0]> = {}) => {
    const time = fakeTime();
    return { time, done: watchDeploy({ checks, timers: time.timers, clock: time.clock, sha: "sha1", ...extra }) };
  };

  it("waits, looks every 15 s, and reports a deploy that finishes", async () => {
    const checks = script([ok(), ok(run("deploy", "queued")), ok(run("deploy", "in_progress")), ok(run("deploy", "completed", "success", "https://x/9"))]);
    const { time, done } = watch(checks);
    expect(await done).toEqual({ kind: "deployed", url: "https://x/9" });
    expect(checks.calls).toEqual(["sha1", "sha1", "sha1", "sha1"]);
    expect(time.sleeps).toEqual([8000, 15000, 15000, 15000]);
  });

  it("reports a failure as soon as it shows, without waiting for the rest", async () => {
    const checks = script([ok(run("deploy", "in_progress")), ok(run("deploy", "completed", "failure"))]);
    const { done } = watch(checks);
    expect(await done).toMatchObject({ kind: "failed", names: ["deploy"] });
    expect(checks.calls).toHaveLength(2);
  });

  it("a cancelled run is reported as superseded", async () => {
    expect((await watch(script([ok(run("deploy", "completed", "cancelled"))])).done).kind).toBe("superseded");
  });

  it("gives up with 'no-checks' when no run ever appears (90 s)", async () => {
    const checks = script([ok()]);
    const { time, done } = watch(checks);
    expect(await done).toEqual({ kind: "no-checks" });
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
  });

  it("gives up with 'timeout' when checks keep running past 5 minutes, with a polite number of requests", async () => {
    const checks = script([ok(run("deploy", "in_progress"))]);
    const { time, done } = watch(checks);
    expect(await done).toEqual({ kind: "timeout" });
    expect(checks.calls.length).toBeLessThanOrEqual(21);
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(300_000);
  });

  it("no access to checks ends the wait at the first look", async () => {
    const checks = script([{ kind: "no-access" }]);
    expect(await watch(checks).done).toEqual({ kind: "no-access" });
    expect(checks.calls).toHaveLength(1);
  });

  it("shrugs off a few hiccups, but not four in a row", async () => {
    const hiccup: RunsResult = { kind: "error", status: 502, message: "bad gateway" };
    const fine = script([hiccup, new Error("Network error"), hiccup, ok(run("deploy", "completed", "success"))]);
    expect((await watch(fine).done).kind).toBe("deployed");
    const bad = script([hiccup, hiccup, hiccup, hiccup, ok(run("deploy", "completed", "success"))]);
    expect(await watch(bad).done).toEqual({ kind: "error", message: "bad gateway" });
  });

  it("a hiccup in the middle resets the count", async () => {
    const hiccup: RunsResult = { kind: "error", status: 502, message: "x" };
    const checks = script([hiccup, hiccup, hiccup, ok(run("d", "in_progress")), hiccup, hiccup, hiccup, ok(run("d", "completed", "success"))]);
    expect((await watch(checks).done).kind).toBe("deployed");
  });

  it("stops quietly when told to (the plugin unloads)", async () => {
    let stop = false;
    const checks = script([ok(run("d", "in_progress"))]);
    const time = fakeTime();
    const promise = watchDeploy({
      checks,
      timers: time.timers,
      clock: time.clock,
      sha: "s",
      shouldStop: () => {
        const was = stop;
        stop = true;
        return was;
      },
    });
    expect(await promise).toEqual({ kind: "stopped" });
    expect(checks.calls).toHaveLength(1);
  });

  it("the first delay can be skipped (a look at an older commit)", async () => {
    const { time, done } = watch(script([ok(run("d", "completed", "success"))]), { firstDelayMs: 0 });
    expect((await done).kind).toBe("deployed");
    expect(time.sleeps).toEqual([0]);
  });
});

describe("where a failed run stopped", () => {
  const failedRun = { id: 77, name: "Deploy to Cloudflare Pages", status: "completed", conclusion: "failure", url: "https://x/77" } satisfies RunInfo;
  const jobsWithFailure: JobsResult = {
    kind: "ok",
    jobs: [
      {
        name: "deploy",
        conclusion: "failure",
        steps: [
          { name: "Build", conclusion: "success" },
          { name: "Check build (S24 — internal links)", conclusion: "failure" },
          { name: "Deploy to Cloudflare Pages (Direct Upload)", conclusion: "skipped" },
        ],
      },
    ],
  };
  const watchIt = (checks: RunsClient) => {
    const time = fakeTime();
    return watchDeploy({ checks, timers: time.timers, clock: time.clock, sha: "s" });
  };

  it("names the first failed step", async () => {
    const checks = script([ok(failedRun)], jobsWithFailure);
    expect(await watchIt(checks)).toMatchObject({ kind: "failed", step: "Check build (S24 — internal links)", url: "https://x/77" });
    expect(checks.jobCalls).toEqual([77]);
  });

  it("is only asked for a failure, never for success or pending", async () => {
    const ok1 = script([ok(run("d", "in_progress")), ok(run("d", "completed", "success"))], jobsWithFailure);
    await watchIt(ok1);
    expect(ok1.jobCalls).toEqual([]);
  });

  it("a failure without step details (no permission, network, odd data) is still reported", async () => {
    for (const jobs of [{ kind: "unavailable" } satisfies JobsResult, new Error("Network error"), { kind: "ok", jobs: [] } satisfies JobsResult]) {
      const result = await watchIt(script([ok(failedRun)], jobs));
      expect(result.kind).toBe("failed");
      expect("step" in result).toBe(false);
    }
  });

  it("the message says where it stopped, that the commit stays, and what to do", () => {
    const text = describeDeploy({ kind: "failed", names: ["x"], step: "Check build (S24 — internal links)", url: "https://x/77" }, { branch: "preview", actionsUrl: "u" }).text;
    expect(text).toContain("stopped at the step “Check build (S24 — internal links)”");
    expect(text).toContain("Your commit is on preview");
    expect(text).toContain("publish again");
    expect(text).toContain("https://x/77");
    const bare = describeDeploy({ kind: "failed", names: ["x"] }, { branch: "main", actionsUrl: "https://github.com/o/r/actions" }).text;
    expect(bare).not.toContain("stopped at the step");
    expect(bare).toContain("https://github.com/o/r/actions");
  });
});

describe("a green run whose deploy was skipped (the site's guard, T0 test 5)", () => {
  const greenRun = { id: 91, name: "Deploy to Cloudflare Pages", status: "completed", conclusion: "success", url: "https://x/91" } satisfies RunInfo;
  const guardStopped: JobsResult = {
    kind: "ok",
    jobs: [
      {
        name: "deploy",
        conclusion: "success",
        steps: [
          { name: "Build", conclusion: "success" },
          { name: "Check this commit is still the newest on its branch", conclusion: "success" },
          { name: "Deploy to Cloudflare Pages (Direct Upload)", conclusion: "skipped" },
        ],
      },
    ],
  };
  const deployRan: JobsResult = { kind: "ok", jobs: [{ name: "deploy", conclusion: "success", steps: [{ name: "Deploy to Cloudflare Pages (Direct Upload)", conclusion: "success" }] }] };
  const watchIt = (checks: RunsClient) => {
    const time = fakeTime();
    return watchDeploy({ checks, timers: time.timers, clock: time.clock, sha: "s" });
  };

  it("is reported as replaced, not as deployed", async () => {
    const checks = script([ok(greenRun)], guardStopped);
    expect(await watchIt(checks)).toEqual({ kind: "replaced", url: "https://x/91" });
    expect(checks.jobCalls).toEqual([91]);
  });

  it("a run whose deploy step ran is deployed", async () => {
    expect(await watchIt(script([ok(greenRun)], deployRan))).toEqual({ kind: "deployed", url: "https://x/91", runId: 91 });
  });

  it("when the steps cannot be read, the run is still reported (as deployed, as before this check existed)", async () => {
    for (const jobs of [{ kind: "unavailable" } satisfies JobsResult, new Error("Network error"), { kind: "ok", jobs: [] } satisfies JobsResult]) {
      expect((await watchIt(script([ok(greenRun)], jobs))).kind).toBe("deployed");
    }
  });

  it("a run without an id cannot be asked about, and a pending run is never asked", async () => {
    const bare = script([ok(run("d", "completed", "success"))], guardStopped);
    expect((await watchIt(bare)).kind).toBe("deployed");
    expect(bare.jobCalls).toEqual([]);
    const pending = script([ok({ ...greenRun, status: "in_progress", conclusion: null }), ok(greenRun)], deployRan);
    await watchIt(pending);
    expect(pending.jobCalls).toEqual([91]);
  });

  it("says plainly that the publish was replaced and nothing is wrong; it is not an alarm", () => {
    const report = describeDeploy({ kind: "replaced", url: "https://x/91" }, { branch: "preview", actionsUrl: "u" });
    expect(report.attention).toBe(false);
    expect(report.text).toMatch(/Not deployed by itself — a newer publish on preview replaced this one/);
    expect(report.text).toContain("Your commit is on preview");
    expect(report.text).toContain("https://x/91");
  });
});

describe("createRunsClient.listJobs", () => {
  const client = (handler: Parameters<typeof fakeGithub>[0]) => {
    const g = fakeGithub(handler);
    return { ...g, checks: createRunsClient({ http: g.http, token: TOKEN, owner: "o", repo: "r", nonce: () => "n1" }) };
  };

  it("reads the jobs of one run, fresh, and keeps only names and conclusions", async () => {
    const { checks, requests } = client(() =>
      json(200, { jobs: [{ name: "deploy", conclusion: "failure", steps: [{ name: "Build", conclusion: "success", number: 1 }, { bad: 1 }] }, { nope: true }] }),
    );
    expect(await checks.listJobs(5)).toEqual({ kind: "ok", jobs: [{ name: "deploy", conclusion: "failure", steps: [{ name: "Build", conclusion: "success" }] }] });
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/repos/o/r/actions/runs/5/jobs");
    expect(requests[0]?.headers["Cache-Control"]).toBe("no-cache");
  });

  it("is 'unavailable' on any error status, and never asks about a nonsense run id", async () => {
    expect(await client(() => json(403, {})).checks.listJobs(5)).toEqual({ kind: "unavailable" });
    expect(await client(() => json(404, {})).checks.listJobs(5)).toEqual({ kind: "unavailable" });
    const g = client(() => json(200, { jobs: [] }));
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(await g.checks.listJobs(bad)).toEqual({ kind: "unavailable" });
    expect(g.requests).toHaveLength(0);
  });
});

describe("describeDeploy", () => {
  const ctx = { branch: "preview", actionsUrl: actionsUrlOf("o", "r") };
  it("says plainly what happened, with the branch", () => {
    expect(describeDeploy({ kind: "deployed" }, ctx).text).toMatch(/^Deployed ✓/);
    const failed = describeDeploy({ kind: "failed", names: ["deploy"], url: "https://github.com/o/r/actions/runs/7" }, ctx);
    expect(failed.text).toMatch(/Checks failed ✗ — nothing went live/);
    expect(failed.text).toContain("https://github.com/o/r/actions/runs/7");
    expect(failed.attention).toBe(true);
  });

  it("every result has words, except 'stopped'; only a clean deploy needs no attention", () => {
    const results = [
      { kind: "superseded" },
      { kind: "skipped" },
      { kind: "timeout" },
      { kind: "no-checks" },
      { kind: "no-access" },
      { kind: "error", message: "x" },
    ] as const;
    for (const r of results) {
      const report = describeDeploy(r, ctx);
      expect(report.text.length).toBeGreaterThan(10);
      expect(report.attention).toBe(true);
    }
    expect(describeDeploy({ kind: "stopped" }, ctx).text).toBe("");
    expect(describeDeploy({ kind: "no-access" }, ctx).text).toMatch(/Actions: Read-only/);
  });

  it("a failed Blyg commit says which version it used up and what the fix will be (versions only go up)", () => {
    const failed = { kind: "failed", names: ["x"] } satisfies DeployResult;
    const withVersion = describeDeploy(failed, { ...ctx, version: 7 }).text;
    expect(withVersion).toContain("Your commit (v7) is on preview");
    expect(withVersion).toContain("that becomes v8: version numbers only go up");
    const noVersion = describeDeploy(failed, ctx).text;
    expect(noVersion).not.toMatch(/\bv\d/);
  });

  it("builds the Actions link from owner and repo only", () => {
    expect(actionsUrlOf("example-owner", "my-site")).toBe("https://github.com/example-owner/my-site/actions");
  });
});

describe("watchCommit (settings → watcher)", () => {
  const make = (over: { watch?: boolean; secret?: string | null; handler?: Parameters<typeof fakeGithub>[0] } = {}) => {
    const settings = defaultSettings();
    settings.github = { ...settings.github, owner: "o", repo: "r", tokenSecretName: "tok", watchDeploy: over.watch ?? true };
    const g = fakeGithub(over.handler ?? (() => json(200, { workflow_runs: [{ name: "deploy", status: "completed", conclusion: "success" }] })));
    const time = fakeTime();
    const env: DeployEnv = {
      settings,
      keychain: fakeKeychain(over.secret === null ? {} : { tok: over.secret ?? TOKEN }),
      http: g.http,
      timers: time.timers,
      clock: time.clock,
    };
    return { env, requests: g.requests };
  };

  it("reports a deploy of the commit it was given", async () => {
    const { env, requests } = make();
    const record = await watchCommit(env, { branch: "preview", sha: "abc" });
    expect(record?.report.result.kind).toBe("deployed");
    expect(record?.branch).toBe("preview");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/repos/o/r/actions/runs");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("head_sha")).toBe("abc");
  });

  it("hands the commit's Blyg version to the failure message", async () => {
    const { env } = make({ handler: () => json(200, { workflow_runs: [{ name: "deploy", status: "completed", conclusion: "failure" }] }) });
    const record = await watchCommit(env, { branch: "preview", sha: "abc", version: 7 });
    expect(record?.report.result.kind).toBe("failed");
    expect(record?.report.text).toContain("(v7)");
    expect(record?.report.text).toContain("v8");
  });

  it("does nothing, and asks GitHub nothing, when watching is off", async () => {
    const { env, requests } = make({ watch: false });
    expect(await watchCommit(env, { branch: "main", sha: "abc" })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("does nothing when the token is not available", async () => {
    const { env, requests } = make({ secret: null });
    expect(await watchCommit(env, { branch: "main", sha: "abc" })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("a token without Actions: read gives the explaining report, not an exception", async () => {
    const { env } = make({ handler: () => json(403, { message: "Resource not accessible by personal access token" }) });
    const record = await watchCommit(env, { branch: "main", sha: "abc" });
    expect(record?.report.result.kind).toBe("no-access");
    expect(record?.report.text).not.toContain(TOKEN);
  });
});
