// The development build ("blyg-dev") only talks to test Studios (Florian, 2026-11-06): a published id is permanent, so a dev build must never be
// able to publish to the live Studio. See src/studio/devLock.ts.
import { afterEach, describe, expect, it } from "vitest";
import { validateSettings } from "../../src/settings/validate";
import { defaultSettings } from "../../src/settings/schema";
import { studioAddress, studioBaseProblem } from "../../src/studio/address";
import { checkStudioConnection } from "../../src/studio/connection";
import { DEV_STUDIO_RULE, devGuardProblem, devStudioProblem, isDevBuildId, isTestStudioHost, realPluginId, setDevStudioLock } from "../../src/studio/devLock";
import { fakeKeychain, idleTimers } from "../helpers";
import { FakeStudio, STUDIO_HOST } from "./fake-studio";

afterEach(() => setDevStudioLock(false));

describe("which plugin is the development build", () => {
  it("by its manifest id: only an id ending in -dev", () => {
    expect(isDevBuildId("blyg-dev")).toBe(true);
    expect(isDevBuildId("blyg")).toBe(false);
    expect(isDevBuildId("obsidian-blyg")).toBe(false);
    expect(isDevBuildId("blyg-device")).toBe(false);
  });
});

describe("what a test Studio's host is", () => {
  it.each(["a.workers.dev", "blyg-studio-test.someone-4d4.workers.dev", "A.WORKERS.DEV", "a.workers.dev.", "localhost", "127.0.0.1", "[::1]"])("%s is", (h) => {
    expect(isTestStudioHost(h)).toBe(true);
  });
  it.each(["workers.dev", "evilworkers.dev", "workers.dev.example.com", "a.workers.dev.example.com", "a.pages.dev", "blyg.example.com", "localhost.example.com", "10.0.0.1"])("%s is not", (h) => {
    expect(isTestStudioHost(h)).toBe(false);
  });
});

describe("with the lock off (the release plugin) nothing changes", () => {
  it("every ordinary address still passes", () => {
    expect(devStudioProblem("https://blyg.example.com")).toBeNull();
    expect(studioBaseProblem("https://blyg.example.com")).toBeNull();
    expect(studioAddress({ baseUrl: "https://blyg.example.com", mount: "" })).not.toBeNull();
  });
});

describe("with the lock on (the development build)", () => {
  it("accepts a workers.dev address and the local machine", () => {
    setDevStudioLock(true);
    for (const u of ["https://blyg-studio-test.someone.workers.dev", "http://localhost:8787", "http://127.0.0.1:8787", "https://localhost"]) {
      expect(studioBaseProblem(u), u).toBeNull();
      expect(studioAddress({ baseUrl: u, mount: "" }), u).not.toBeNull();
    }
  });

  it("refuses every other address, with a reason that names the rule and the host, and gives no usable address", () => {
    setDevStudioLock(true);
    for (const u of ["https://blyg.example.com", "https://workers.dev", "https://evilworkers.dev", "https://a.workers.dev.example.com", "https://a.pages.dev"]) {
      const problem = studioBaseProblem(u);
      expect(problem, u).toContain("only connects to test Studios");
      expect(problem, u).toContain(DEV_STUDIO_RULE);
      expect(problem, u).toContain(new URL(u).hostname);
      expect(studioAddress({ baseUrl: u, mount: "" }), u).toBeNull();
    }
  });

  it("cannot be talked round by the shape of the address", () => {
    setDevStudioLock(true);
    expect(studioBaseProblem("https://a.workers.dev@blyg.example.com")).not.toBeNull(); // credentials are refused before the host is looked at
    expect(studioBaseProblem("https://blyg.example.com/a.workers.dev")).not.toBeNull(); // a path is refused, and the host still is not a test host
    expect(studioBaseProblem("https://blyg.example.com?x=.workers.dev")).not.toBeNull();
    expect(devStudioProblem("not an address")).toBeNull(); // not an address at all: the other checks say that
  });

  it("shows up in the settings check, in the owner's words", () => {
    setDevStudioLock(true);
    const s = defaultSettings();
    s.studio = { baseUrl: "https://blyg.example.com", mount: "", tokenSecretName: "studio-token", importFolder: "" };
    const issue = validateSettings(s).find((i) => i.field === "studio.baseUrl");
    expect(issue?.message).toContain("only connects to test Studios");
    s.studio.baseUrl = "https://blyg-studio-test.someone.workers.dev";
    expect(validateSettings(s).find((i) => i.field === "studio.baseUrl")).toBeUndefined();
  });

  it("'Check connection' against a refused address stops before any request and before reading the token", async () => {
    setDevStudioLock(true);
    const studio = new FakeStudio();
    const report = await checkStudioConnection(
      { transport: studio.transport, timers: idleTimers, keychain: fakeKeychain({}), clock: { now: () => new Date("2026-11-06T09:00:00Z") } },
      { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "studio-token" },
    );
    expect(report.ok).toBe(false);
    expect(report.lines[0]?.text).toContain("only connects to test Studios");
    expect(studio.seen).toHaveLength(0);
  });
});

describe("the development build stays idle while the real plugin is enabled (one plugin at a time)", () => {
  it("names the real plugin of a dev id", () => {
    expect(realPluginId("blyg-dev")).toBe("blyg");
    expect(realPluginId("blyg")).toBe("blyg");
  });

  it("is a reason to stay idle only for the dev build with the real plugin enabled, and says what to do", () => {
    const reason = devGuardProblem("blyg-dev", true);
    expect(reason).toContain("Blyg (dev) is idle");
    expect(reason).toContain("Turn the real Blyg off");
    expect(reason).toContain("Nothing was changed");
    expect(devGuardProblem("blyg-dev", false)).toBeNull(); // the real plugin is off: the dev build runs
    expect(devGuardProblem("blyg", true)).toBeNull(); // the release plugin never stays idle because of this
    expect(devGuardProblem("blyg", false)).toBeNull();
    expect(devGuardProblem("obsidian-blyg", true)).toBeNull();
  });
});
