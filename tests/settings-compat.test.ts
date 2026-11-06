// Settings must survive an update (Florian, 2026-11-06: "I don't want to fill in the settings again and again with every new update").
//
// BRAT replaces only main.js, manifest.json and styles.css (BRAT 2.2.0), so data.json stays; what can still lose a setting is a release that
// changes the settings schema without reading the old shape. `tests/fixtures/data-0.9.0.json` is the data.json of a 0.9.0 install, with
// placeholder values and every kind of key. A later release must read it unchanged. If this test fails after a schema change, add a
// migration to `migrateSettings`; do not edit the fixture to make it pass (add a new fixture for the new version instead).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDataUpdater } from "../src/app/dataUpdater";
import { migrateSettings } from "../src/settings/migrate";
import { SCHEMA_VERSION } from "../src/settings/schema";
import { validateSettings } from "../src/settings/validate";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/data-0.9.0.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("a data.json written by 0.9.0 still loads, unchanged, in this version", () => {
  it("keeps every setting the owner typed in (Studio, token entry names, routes, GitHub site, safety, templates)", () => {
    const { settings, fromNewerVersion } = migrateSettings(fixture);
    expect(fromNewerVersion).toBe(false);
    expect(settings.studio).toEqual({ baseUrl: "https://blyg.example.com", mount: "", tokenSecretName: "studio-token", importFolder: "Blyg/Imports" });
    expect(settings.github).toEqual({ owner: "someone", repo: "my-site", branch: "main", previewBranch: "preview", useBranch: "production", tokenSecretName: "github-token", watchDeploy: true });
    expect(settings.routes).toEqual([
      { vaultPrefix: "Blyg/", mode: "studio", label: "Blyg item" },
      { vaultPrefix: "Blyg Drafts/", mode: "studio", label: "Blyg draft", draftsOnly: true },
      { vaultPrefix: "website/essays/", mode: "plain", label: "Essay", dest: "src/content/essays/", requireTitle: true, webUrl: "https://site.example.com/essays/{slug}/" },
    ]);
    expect(settings.blyg.origin).toBe("https://site.example.com/blyg/");
    expect(settings.safety.outsideLinks).toBe("warn");
    expect(settings.templates).toEqual({ fragment: "Templates/fragment.md", thread: "Templates/thread.md" });
    expect(settings.respond.draftsPrefix).toBe("Blyg Drafts/");
    expect(settings.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("is still a valid configuration (nothing the old version accepted is refused now)", () => {
    expect(validateSettings(migrateSettings(fixture).settings)).toEqual([]);
  });

  it("is not mistaken for data from a newer version, so the plugin keeps saving", () => {
    expect(typeof fixture["schemaVersion"]).toBe("number");
    expect(fixture["schemaVersion"] as number).toBeLessThanOrEqual(SCHEMA_VERSION);
  });

  it("saving the settings keeps the other keys of data.json (published records, the import ignore list)", async () => {
    let disk: Record<string, unknown> = structuredClone(fixture);
    const update = createDataUpdater({ load: () => Promise.resolve(disk), save: (d) => { disk = d; return Promise.resolve(); } }, () => false);
    const { settings } = migrateSettings(fixture);
    settings.studio.importFolder = "Blyg/New imports";
    await update((data) => void Object.assign(data, settings));
    expect((disk["studio"] as { importFolder: string }).importFolder).toBe("Blyg/New imports");
    expect(disk["published"]).toEqual(fixture["published"]);
    expect(disk["studioImportIgnored"]).toEqual(fixture["studioImportIgnored"]);
  });
});
