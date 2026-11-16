// The first minute: what the panel, the settings' Setup check, the publish refusal and the reader say before a Studio is connected.
import { describe, expect, it } from "vitest";
import { CONNECT_STEPS } from "../src/app/panelState";
import { preflight } from "../src/app/publishSettings";
import { M } from "../src/publish/messages";
import { defaultSettings } from "../src/settings/schema";
import { connectionCheckKey, setupProgress } from "../src/settings/setup";
import { validateSettings } from "../src/settings/validate";

describe("setup progress (the settings' Setup check)", () => {
  it("a fresh install: connecting, no step done", () => {
    const p = setupProgress(validateSettings(defaultSettings()));
    expect(p.connecting).toBe(true);
    expect(p.done).toEqual([false, false, false, false]);
    expect(p.errors.some((i) => i.field === "studio.baseUrl" || i.field === "studio.tokenSecretName")).toBe(false); // those two are the steps, not extra lines
  });
  it("an address but no keychain entry name: step 1 ticked, step 3 not (it is never ticked: whether the entry holds a token is only known after Check connection)", () => {
    const s = defaultSettings();
    s.studio.baseUrl = "https://blyg.example.com";
    const p = setupProgress(validateSettings(s));
    expect(p.connecting).toBe(true);
    expect(p.done).toEqual([true, false, false, false]);
  });
  it("address and entry chosen: no longer connecting (the rest is the ordinary list)", () => {
    const s = defaultSettings();
    s.studio.baseUrl = "https://blyg.example.com";
    s.studio.tokenSecretName = "blyg-studio";
    const p = setupProgress(validateSettings(s));
    expect(p.connecting).toBe(false);
    expect(p.errors).toEqual([]);
  });
  it("other errors stay listed while connecting", () => {
    const s = defaultSettings();
    s.routes = [{ vaultPrefix: "no-slash", mode: "studio", label: "Blyg item" }];
    const p = setupProgress(validateSettings(s));
    expect(p.connecting).toBe(true);
    expect(p.errors.map((i) => i.field)).toContain("routes[0].vaultPrefix");
  });
});

describe("the connection result belongs to the settings it was made with", () => {
  it("changes with the address, the mount or the keychain entry; not with unrelated settings; never contains a token", () => {
    const s = defaultSettings();
    s.studio.baseUrl = "https://a.example.com";
    s.studio.tokenSecretName = "entry-a";
    const base = connectionCheckKey(s, "Check connection");
    expect(connectionCheckKey(s, "Check connection")).toBe(base);
    s.blyg.fragmentCharCap = 500;
    expect(connectionCheckKey(s, "Check connection")).toBe(base);
    for (const change of [(x: typeof s) => (x.studio.baseUrl = "https://b.example.com"), (x: typeof s) => (x.studio.mount = "/blyg"), (x: typeof s) => (x.studio.tokenSecretName = "entry-b")]) {
      const t = structuredClone(s);
      change(t);
      expect(connectionCheckKey(t, "Check connection")).not.toBe(base);
    }
    expect(connectionCheckKey(s, "Another check")).not.toBe(base);
  });
});

describe("the first-run words", () => {
  it("nothing connected: the publish refusal is one sentence that says what to do (no field list, no doubled full stop)", () => {
    expect(preflight(defaultSettings())).toBe(M.studioNotConfigured);
    expect(M.studioNotConfigured).toBe("Connect your Studio first: Settings → Blyg → Studio (address and token).");
    const githubUser = defaultSettings();
    githubUser.routes = [{ vaultPrefix: "blyg/", mode: "blyg", label: "Blyg item" }];
    expect(preflight(githubUser)).not.toContain("..");
  });
  it("the four steps are in order, and the last line explains the 30 days and every device", () => {
    expect(CONNECT_STEPS.slice(0, 4).map((t) => t.slice(0, 2))).toEqual(["1.", "2.", "3.", "4."]);
    expect(CONNECT_STEPS[3]).toContain("Check connection");
    expect(CONNECT_STEPS[4]).toMatch(/30 days.*each device/);
  });
});
