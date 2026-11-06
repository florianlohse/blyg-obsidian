import { describe, expect, it } from "vitest";
import { checkStudioConnection } from "../../src/studio/connection";
import { formatReport } from "../../src/github/connection";
import { fakeKeychain, idleTimers } from "../helpers";
import { FAR_FUTURE, FakeStudio, STUDIO_HOST, STUDIO_TOKEN, makeToken } from "./fake-studio";

const NOW = new Date("2026-10-22T09:00:00Z");
const settings = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "studio-token" };

function run(studio: FakeStudio, over: Partial<typeof settings> = {}, secrets: Record<string, string> = { "studio-token": studio.token }) {
  return checkStudioConnection({ transport: studio.transport, timers: idleTimers, keychain: fakeKeychain(secrets), clock: { now: () => NOW } }, { ...settings, ...over });
}
const levels = (r: { lines: { level: string }[] }) => r.lines.map((l) => l.level);

describe("studio connection check", () => {
  it("a good Studio and a good token: all green, and it only reads", async () => {
    const studio = new FakeStudio();
    studio.seed({ content_md: "x" });
    const report = await run(studio);
    expect(report.ok).toBe(true);
    // the default test token has no owner:manage: a note (hoppers, S13), not a fault
    expect(levels(report)).toEqual(["ok", "ok", "ok", "ok", "warn", "ok"]);
    expect(formatReport(report)).toMatch(/cannot change hoppers: that needs owner:manage/);
    expect(formatReport(report)).toMatch(/Studio 0\.51\.0, contract 5\.2\.0: the API this plugin speaks/);
    expect(formatReport(report)).toMatch(/valid for 70 more days/);
    expect(formatReport(report)).toMatch(/holds 1 item\./);
    expect(studio.seen.every((s) => s.method === "GET")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(STUDIO_TOKEN);
  });

  it("says when the token may change hoppers (owner:manage)", async () => {
    const studio = new FakeStudio();
    studio.token = makeToken({ expSeconds: FAR_FUTURE, scope: "owner:read owner:draft owner:publish owner:manage" });
    const report = await run(studio);
    expect(report.lines.every((l) => l.level === "ok")).toBe(true);
    expect(formatReport(report)).toMatch(/may change hoppers/);
  });

  it("warns, but still passes, for a newer minor of contract 5 and for a program that is not a Blygger Studio", async () => {
    const newer = new FakeStudio();
    newer.contractVersion = "5.9.0";
    const r1 = await run(newer);
    expect(r1.ok).toBe(true);
    expect(formatReport(r1)).toMatch(/Studio API 5\.9\.0 is newer than the 5\.4 this plugin was tested with\. Newer minor versions only add things and are accepted/);
    // an info line (muted), not a warning
    expect(r1.lines.find((l) => /newer than/.test(l.text))?.level).toBe("info");
    expect(r1.lines.filter((l) => l.level === "warn").some((l) => /newer than/.test(l.text))).toBe(false);
    // the tested contracts (Studio 0.51.0 to 0.53.0) say nothing about versions
    for (const v of ["5.2.0", "5.3.0", "5.4.0"]) {
      const tested = new FakeStudio();
      tested.contractVersion = v;
      const r = await run(tested);
      expect(r.ok, v).toBe(true);
      expect(formatReport(r), v).not.toMatch(/newer than/);
    }
    const next = new FakeStudio();
    next.contractVersion = "5.5.0";
    expect(formatReport(await run(next))).toMatch(/Studio API 5\.5\.0 is newer than the 5\.4/);
    const major = new FakeStudio();
    major.contractVersion = "6.0.0";
    const refused = await run(major);
    expect(refused.ok).toBe(false);
    expect(refused.lines.some((l) => l.level === "error")).toBe(true);
    const fork = new FakeStudio();
    fork.generator = "my-fork/1";
    expect(formatReport(await run(fork))).toMatch(/does not announce a Blygger Studio/);
  });

  it("an older contract fails the check, says what to update, and asks nothing further", async () => {
    const old = new FakeStudio();
    old.contractVersion = "4.0.0";
    old.generator = "blygger-studio/0.49.1";
    const report = await run(old);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toMatch(/Studio 0\.49\.1, contract 4\.0\.0: This Studio speaks an older API\. Update the Studio \(it needs 0\.51\.0 or later\)/);
    expect(old.seen.map((s) => s.path)).toEqual(["/blyg.json", "/api/capabilities"]);
  });

  it("a Studio with no /capabilities (before 0.49.7) fails the same way", async () => {
    const old = new FakeStudio();
    old.contractVersion = null;
    const report = await run(old);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toMatch(/older API/);
  });

  it("a newer major fails the check and says to update the plugin", async () => {
    const future = new FakeStudio();
    future.contractVersion = "6.0.0";
    const report = await run(future);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toMatch(/Update the plugin/);
  });

  it("warns when the Studio says it lives elsewhere than the settings", async () => {
    const studio = new FakeStudio();
    studio.manifestSite = "https://www.example.org/";
    expect(formatReport(await run(studio))).toMatch(/Studio says it lives at https:\/\/www\.example\.org\/, but the settings say https:\/\/studio\.test\//);
  });

  it("warns five days before the token ends, errors after", async () => {
    const soon = new FakeStudio();
    soon.token = makeToken({ expSeconds: Math.floor(NOW.getTime() / 1000) + 3 * 86400 });
    const r = await run(soon);
    expect(r.ok).toBe(true);
    expect(formatReport(r)).toMatch(/expires in 3 days/);
    const gone = new FakeStudio();
    gone.token = makeToken({ expSeconds: Math.floor(NOW.getTime() / 1000) - 60 });
    const r2 = await run(gone);
    expect(r2.ok).toBe(false);
    expect(formatReport(r2)).toMatch(/token has expired/);
  });

  it("errors when the token lacks a permission publishing needs", async () => {
    const studio = new FakeStudio();
    studio.token = makeToken({ expSeconds: FAR_FUTURE, scope: "owner:read" });
    const r = await run(studio);
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toMatch(/lacks owner:draft, owner:publish/);
  });

  it("explains a rejected token", async () => {
    const studio = new FakeStudio();
    const r = await run(studio, {}, { "studio-token": "someone-elses-token" });
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toMatch(/rejected the token/);
  });

  it("stops early, with a plain message, for missing settings, a missing keychain entry or a Studio that is not there", async () => {
    const studio = new FakeStudio();
    expect(formatReport(await run(studio, { baseUrl: "" }))).toMatch(/Enter the Studio's address first/);
    expect(formatReport(await run(studio, { baseUrl: "http://blyg.example.com" }))).toMatch(/Studio address: Must be an https/);
    expect(formatReport(await run(studio, { mount: "blyg" }))).toMatch(/Studio mount/);
    expect(formatReport(await run(studio, { tokenSecretName: "" }))).toMatch(/No Studio token chosen yet/);
    expect(formatReport(await run(studio, {}, {}))).toMatch(/keychain entry “studio-token” is empty on this device/);
    studio.forced.set("GET /blyg.json", { status: 404, text: "" });
    expect(formatReport(await run(studio))).toMatch(/blyg\.json: The Studio has no such address \(404\)/);
    expect(studio.seen.filter((s) => s.path.startsWith("/api"))).toEqual([]);
  });

  it("reports a network failure instead of throwing", async () => {
    const studio = new FakeStudio();
    studio.forced.set("GET /blyg.json", new Error("offline"));
    const r = await run(studio);
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toMatch(/Network error: offline/);
  });
});
