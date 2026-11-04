import { describe, expect, it } from "vitest";
import { migrateSettings } from "../../src/settings/migrate";
import { defaultSettings, SCHEMA_VERSION } from "../../src/settings/schema";
import { describeField, validateSettings } from "../../src/settings/validate";

/** A setup with a GitHub Blyg route and no Studio route (what a new install started with before Studio-only mode). */
const githubDefaults = () => {
  const s = defaultSettings();
  s.routes = [{ vaultPrefix: "blyg/", mode: "blyg", label: "Blyg item" }];
  return s;
};
const errorsOf = (s = githubDefaults()) => validateSettings(s).filter((i) => i.severity === "error" && i.field.startsWith("studio"));

describe("studio settings", () => {
  it("default to nothing: no address, no secret name (nothing setup-specific in code)", () => {
    expect(defaultSettings().studio).toEqual({ baseUrl: "", mount: "", tokenSecretName: "", importFolder: "" });
  });

  it("are read from stored data and fall back for junk", () => {
    const stored = migrateSettings({ studio: { baseUrl: "https://blyg.example.com", mount: "/blyg", tokenSecretName: "studio-token", importFolder: "studio/" } }).settings.studio;
    expect(stored).toEqual({ baseUrl: "https://blyg.example.com", mount: "/blyg", tokenSecretName: "studio-token", importFolder: "studio/" });
    // written by 0.4.x, which had no Import folder: the default
    expect(migrateSettings({ studio: { baseUrl: "https://blyg.example.com", mount: "", tokenSecretName: "t" } }).settings.studio.importFolder).toBe("");
    expect(migrateSettings({ studio: { baseUrl: 3, mount: [], tokenSecretName: null, importFolder: 7 } }).settings.studio).toEqual({ baseUrl: "", mount: "", tokenSecretName: "", importFolder: "" });
    expect(migrateSettings({ studio: "x" }).settings.studio).toEqual({ baseUrl: "", mount: "", tokenSecretName: "", importFolder: "" });
  });

  it("a Studio route survives loading; an unknown mode still becomes a GitHub Blyg route", () => {
    const routes = migrateSettings({ routes: [{ vaultPrefix: "s/", mode: "studio", label: "S" }, { vaultPrefix: "x/", mode: "other", label: "X" }, { vaultPrefix: "n/", mode: "studio" }] }).settings.routes;
    expect(routes.map((r) => r.mode)).toEqual(["studio", "blyg", "studio"]);
    expect(routes[2]?.label).toBe("Blyg item");
  });

  it("raise the schema version, so a device on an older plugin stays read-only instead of reading a Studio route as a GitHub one", () => {
    // 3 (0.4.0): "Drafts only" on a route. A 0.3.x device (schema 2) must not read it as an ordinary Studio route and publish from a drafts-only folder.
    expect(SCHEMA_VERSION).toBe(3);
    expect(migrateSettings({ schemaVersion: SCHEMA_VERSION + 1 }).fromNewerVersion).toBe(true);
    expect(migrateSettings({ schemaVersion: 2 }).fromNewerVersion).toBe(false);
    // what a 0.3.x device would see in data.json saved by this version: 3 > its own 2
    expect(migrateSettings({}).settings.schemaVersion).toBe(3);
  });
});

describe("Drafts only on a route", () => {
  it("is kept on a Studio route only when it is exactly true, and never on another kind of route", () => {
    const { settings } = migrateSettings({
      schemaVersion: 3,
      routes: [
        { vaultPrefix: "a/", mode: "studio", label: "A", draftsOnly: true },
        { vaultPrefix: "b/", mode: "studio", label: "B", draftsOnly: false },
        { vaultPrefix: "c/", mode: "studio", label: "C", draftsOnly: "yes" },
        { vaultPrefix: "d/", mode: "blyg", label: "D", draftsOnly: true },
        { vaultPrefix: "e/", mode: "plain", label: "E", dest: "x/", draftsOnly: true },
        { vaultPrefix: "f/", mode: "studio", label: "F" },
      ],
    });
    expect(settings.routes.map((r) => r.draftsOnly)).toEqual([true, undefined, undefined, undefined, undefined, undefined]);
  });

  it("settings of schema 2 load as they are, with no route drafts-only", () => {
    const { settings, fromNewerVersion } = migrateSettings({ schemaVersion: 2, routes: [{ vaultPrefix: "s/", mode: "studio", label: "S" }] });
    expect(fromNewerVersion).toBe(false);
    expect(settings.routes[0]).toEqual({ vaultPrefix: "s/", mode: "studio", label: "S" });
  });
});

describe("studio settings validation", () => {
  it("nothing is required while no route uses a Studio", () => {
    expect(errorsOf()).toEqual([]);
  });

  it("a Studio route requires an address and a token entry", () => {
    const s = defaultSettings();
    s.routes.push({ vaultPrefix: "studio/", mode: "studio", label: "Blyg item" });
    expect(errorsOf(s).map((i) => i.field)).toEqual(["studio.baseUrl", "studio.tokenSecretName"]);
    s.studio.baseUrl = "https://blyg.example.com";
    s.studio.tokenSecretName = "studio-token";
    expect(errorsOf(s)).toEqual([]);
  });

  it("checks the address, the mount and the entry name", () => {
    const s = defaultSettings();
    s.studio = { baseUrl: "http://blyg.example.com", mount: "blyg/", tokenSecretName: "Studio Token", importFolder: "" };
    expect(errorsOf(s).map((i) => i.field).sort()).toEqual(["studio.baseUrl", "studio.mount", "studio.tokenSecretName"]);
    s.studio.baseUrl = "http://localhost:8787";
    expect(errorsOf(s).map((i) => i.field)).not.toContain("studio.baseUrl");
  });

  it("the Studio token and the GitHub token must be two different keychain entries", () => {
    const s = defaultSettings();
    s.routes.push({ vaultPrefix: "studio/", mode: "studio", label: "Blyg item" });
    s.studio = { baseUrl: "https://blyg.example.com", mount: "", tokenSecretName: "one-token", importFolder: "" };
    s.github.tokenSecretName = "one-token";
    expect(errorsOf(s).map((i) => i.message)).toEqual(["Must differ from the GitHub token's entry: they are two different secrets."]);
  });

  it("names the fields the way the settings screen does", () => {
    expect(describeField("studio.baseUrl")).toBe("Studio address");
    expect(describeField("studio.tokenSecretName")).toBe("Studio token");
  });
});
