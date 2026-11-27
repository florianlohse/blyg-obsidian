import { describe, expect, it } from "vitest";
import { cleanFeatureFlags, createFeatures, featureEnabled, FEATURES } from "../../src/features/registry";
import { defaultSettings } from "../../src/settings/schema";
import { migrateSettings } from "../../src/settings/migrate";

describe("the feature accessor", () => {
  it("has an experimental feature off in the release build and on in the dev build", () => {
    expect(featureEnabled("tangle", {}, false)).toBe(false);
    expect(featureEnabled("tangle", undefined, true)).toBe(true);
  });
  it("lets the user's switch win in both builds", () => {
    expect(featureEnabled("passages", { passages: true }, false)).toBe(true);
    expect(featureEnabled("passages", { passages: false }, true)).toBe(false);
  });
  it("release 1.1.0: the four promoted features are on in the release build with no switch, the others fail closed (off)", () => {
    const stage = (id: string) => FEATURES.find((f) => f.id === id)?.stage;
    for (const id of ["daily", "digest-ai", "shelf", "marginalia"]) {
      expect(stage(id), id).toBe("stable");
      expect(featureEnabled(id, undefined, false), id).toBe(true);
      expect(featureEnabled(id, {}, false), id).toBe(true);
      expect(createFeatures(() => undefined, "blyg").enabled(id), id).toBe(true);
    }
    for (const id of ["passages", "tangle", "share-open"]) {
      expect(stage(id), id).toBe("experimental");
      expect(featureEnabled(id, undefined, false), id).toBe(false);
      expect(createFeatures(() => ({}), "blyg").enabled(id), id).toBe(false);
    }
    expect(FEATURES.filter((f) => f.stage === "experimental").map((f) => f.id).sort()).toEqual(["passages", "share-open", "tangle"]);
    for (const id of ["author-look", "reader-timing"]) expect(featureEnabled(id, { [id]: true }, false), id).toBe(false);
  });
  it("a stable feature has no switch: an old switch value in data.json changes nothing", () => {
    for (const id of ["daily", "shelf", "marginalia"]) {
      expect(featureEnabled(id, { [id]: false }, false), id).toBe(true);
      expect(featureEnabled(id, { [id]: true }, false), id).toBe(true);
    }
    expect(featureEnabled("digest-ai", { "digest-ai": false, daily: false }, false)).toBe(true);
  });
  it("never has a dev feature in the release build, whatever the settings say", () => {
    expect(featureEnabled("reader-timing", { "reader-timing": true }, false)).toBe(false);
    expect(featureEnabled("author-look", {}, true)).toBe(true);
  });
  it("keeps the AI layer tied to the Daily (it requires it)", () => {
    expect(FEATURES.find((f) => f.id === "digest-ai")?.requires).toBe("daily");
    expect(featureEnabled("digest-ai", {}, false)).toBe(true);
  });
  it("is off for an id it does not know", () => {
    expect(featureEnabled("nope", { nope: true }, true)).toBe(false);
  });
  it("reads the live settings and the manifest id", () => {
    const flags: Record<string, boolean> = {};
    const rel = createFeatures(() => flags, "blyg");
    const dev = createFeatures(() => flags, "blyg-dev");
    expect([rel.enabled("tangle"), dev.enabled("tangle")]).toEqual([false, true]);
    flags.tangle = true;
    expect(rel.enabled("tangle")).toBe(true);
  });
  it("has unique ids", () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
  });
});

describe("the feature switches in settings", () => {
  it("load from an old data.json without them", () => {
    const { settings } = migrateSettings({ schemaVersion: 1 });
    expect(settings.features).toEqual({});
    expect(defaultSettings().features).toEqual({});
  });
  it("keep booleans only, and the stored data of a switched-off feature stays", () => {
    expect(cleanFeatureFlags({ daily: false, marginalia: "yes", x: 1 })).toEqual({ daily: false });
    expect(cleanFeatureFlags([true])).toEqual({});
    const { settings } = migrateSettings({ schemaVersion: 1, features: { daily: false }, digest: { useAi: true, keySecretName: "k" }, readerPane: { shareInbox: "Inbox" } });
    expect(settings.features).toEqual({ daily: false });
    expect(settings.digest.useAi).toBe(true);
    expect(settings.digest.keySecretName).toBe("k");
    expect(settings.readerPane.shareInbox).toBe("Inbox");
  });
});
