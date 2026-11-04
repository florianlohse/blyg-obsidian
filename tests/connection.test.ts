import { describe, expect, it } from "vitest";
import { checkConnection, formatReport, type ConnectionTarget } from "../src/github/connection";
import { fakeGithub, fakeKeychain, json, TOKEN } from "./helpers";

const target: ConnectionTarget = {
  owner: "someone",
  repo: "site",
  branch: "main",
  previewBranch: "preview",
  tokenSecretName: "gh-token",
};
const keychain = fakeKeychain({ "gh-token": TOKEN });

const levels = (r: { lines: { level: string }[] }) => r.lines.map((l) => l.level);

describe("checkConnection", () => {
  it("reports success when the token can write and both branches exist", async () => {
    const { http, requests } = fakeGithub((req) =>
      new URL(req.url).pathname.endsWith("/repos/someone/site") ? json(200, { permissions: { push: true, pull: true } }) : json(200, {}),
    );
    const report = await checkConnection({ http, keychain }, target);
    expect(report.ok).toBe(true);
    expect(levels(report)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /repos/someone/site",
      "GET /repos/someone/site/branches/main",
      "GET /repos/someone/site/branches/preview",
    ]);
  });

  it("with deploy watching on, also tells whether the token can read deploy status", async () => {
    const ok = fakeGithub((req) =>
      new URL(req.url).pathname.endsWith("/actions/runs") ? json(200, { workflow_runs: [] }) : json(200, { permissions: { push: true } }),
    );
    const a = await checkConnection({ http: ok.http, keychain }, { ...target, watchDeploy: true });
    expect(a.ok).toBe(true);
    expect(a.lines.at(-1)).toEqual({ level: "ok", text: "The token can read deploy status." });
    expect(ok.requests.every((r) => r.method === "GET")).toBe(true);

    const denied = fakeGithub((req) =>
      new URL(req.url).pathname.endsWith("/actions/runs") ? json(403, { message: "Resource not accessible" }) : json(200, { permissions: { push: true } }),
    );
    const b = await checkConnection({ http: denied.http, keychain }, { ...target, watchDeploy: true });
    expect(b.ok).toBe(true); // publishing works without it
    expect(b.lines.at(-1)).toMatchObject({ level: "warn" });
    expect(b.lines.at(-1)?.text).toMatch(/Actions: Read-only/);
  });

  it("with deploy watching off, does not touch the checks API", async () => {
    const { http, requests } = fakeGithub(() => json(200, { permissions: { push: true } }));
    await checkConnection({ http, keychain }, { ...target, watchDeploy: false });
    expect(requests.some((r) => r.url.includes("/actions/"))).toBe(false);
  });

  it("makes read requests only", async () => {
    const { http, requests } = fakeGithub(() => json(200, { permissions: { push: true } }));
    await checkConnection({ http, keychain }, target);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("fails when the token can only read", async () => {
    const { http } = fakeGithub(() => json(200, { permissions: { push: false, pull: true } }));
    const report = await checkConnection({ http, keychain }, target);
    expect(report.ok).toBe(false);
    expect(report.lines.some((l) => l.level === "error" && /read but not write/.test(l.text))).toBe(true);
  });

  it("warns, but does not fail, when GitHub does not report permissions", async () => {
    const { http } = fakeGithub(() => json(200, {}));
    const report = await checkConnection({ http, keychain }, target);
    expect(report.ok).toBe(true);
    expect(levels(report)).toContain("warn");
  });

  it("explains 401, 403, rate limit and 404 on the repository", async () => {
    const cases: [number, Record<string, string>, RegExp][] = [
      [401, {}, /rejected the token/],
      [403, {}, /Contents: read and write/],
      [403, { "X-RateLimit-Remaining": "0" }, /rate limit/],
      [404, {}, /not found, or the token has no access/],
      [500, {}, /answered 500/],
    ];
    for (const [status, headers, expected] of cases) {
      const { http, requests } = fakeGithub(() => json(status, { message: "x" }, headers));
      const report = await checkConnection({ http, keychain }, target);
      expect(report.ok).toBe(false);
      expect(report.lines).toHaveLength(1);
      expect(report.lines[0]?.text).toMatch(expected);
      expect(requests).toHaveLength(1);
    }
  });

  it("treats a missing preview branch as a warning and a missing production branch as an error", async () => {
    const noPreview = fakeGithub((req) =>
      new URL(req.url).pathname.endsWith("/branches/preview") ? json(404, {}) : json(200, { permissions: { push: true } }),
    );
    const a = await checkConnection({ http: noPreview.http, keychain }, target);
    expect(a.ok).toBe(true);
    expect(a.lines.at(-1)).toMatchObject({ level: "warn" });

    const noMain = fakeGithub((req) =>
      new URL(req.url).pathname.endsWith("/branches/main") ? json(404, {}) : json(200, { permissions: { push: true } }),
    );
    const b = await checkConnection({ http: noMain.http, keychain }, target);
    expect(b.ok).toBe(false);
  });

  it("encodes branch names with slashes per segment", async () => {
    const { http, requests } = fakeGithub(() => json(200, { permissions: { push: true } }));
    await checkConnection({ http, keychain }, { ...target, previewBranch: "test/new idea" });
    expect(requests.at(-1)?.url).toContain("/branches/test/new%20idea");
  });

  it("stops before any network call when owner, repository or token are missing", async () => {
    const { http, requests } = fakeGithub(() => json(200, {}));
    for (const t of [
      { ...target, owner: "" },
      { ...target, repo: "" },
      { ...target, tokenSecretName: "" },
      { ...target, tokenSecretName: "not-there" },
    ]) {
      const report = await checkConnection({ http, keychain }, t);
      expect(report.ok).toBe(false);
    }
    const old = await checkConnection({ http, keychain: fakeKeychain({ "gh-token": TOKEN }, false) }, target);
    expect(old.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("turns a network failure into an error line and keeps what was learned before it", async () => {
    let calls = 0;
    const { http } = fakeGithub(() => (++calls === 1 ? json(200, { permissions: { push: true } }) : new Error("offline")));
    const report = await checkConnection({ http, keychain }, target);
    expect(report.ok).toBe(false);
    expect(levels(report)).toEqual(["ok", "ok", "error"]);
  });

  it("never lets the token into a report, whatever goes wrong", async () => {
    const scenarios = [
      () => json(200, { permissions: { push: true }, echo: TOKEN }),
      () => json(401, { message: `Bad credentials ${TOKEN}` }),
      () => json(404, { message: TOKEN }),
      () => new Error(`socket hang up (Authorization: Bearer ${TOKEN})`),
    ];
    for (const handler of scenarios) {
      const { http } = fakeGithub(handler);
      const report = await checkConnection({ http, keychain }, target);
      expect(JSON.stringify(report)).not.toContain(TOKEN);
      expect(formatReport(report)).not.toContain(TOKEN);
    }
  });

  it("formats lines with ✓ ⚠ ✗", () => {
    expect(
      formatReport({ ok: false, lines: [{ level: "ok", text: "a" }, { level: "warn", text: "b" }, { level: "error", text: "c" }] }),
    ).toBe("✓ a\n⚠ b\n✗ c");
  });
});
