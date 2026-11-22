import { describe, expect, it } from "vitest";
import { cleanFeatureFlags, createFeatures, featureEnabled, FEATURES } from "../../src/features/registry";
import { defaultSettings } from "../../src/settings/schema";
import { migrateSettings } from "../../src/settings/migrate";

describe("the feature accessor", () => {
  it("has an experimental feature off in the release build and on in the dev build", () => {
    expect(featureEnabled("daily", {}, false)).toBe(false);
    expect(featureEnabled("daily", undefined, true)).toBe(true);
  });
  it("lets the user's switch win in both builds", () => {
    expect(featureEnabled("marginalia", { marginalia: true }, false)).toBe(true);
    expect(featureEnabled("marginalia", { marginalia: false }, true)).toBe(false);
  });
  it("never has a dev feature in the release build, whatever the settings say", () => {
    expect(featureEnabled("reader-timing", { "reader-timing": true }, false)).toBe(false);
    expect(featureEnabled("author-look", {}, true)).toBe(true);
  });
  it("needs the Daily for its AI layer", () => {
    expect(featureEnabled("digest-ai", { "digest-ai": true }, false)).toBe(false);
    expect(featureEnabled("digest-ai", { daily: true, "digest-ai": true }, false)).toBe(true);
    expect(featureEnabled("digest-ai", { daily: false }, true)).toBe(false);
  });
  it("is off for an id it does not know", () => {
    expect(featureEnabled("nope", { nope: true }, true)).toBe(false);
  });
  it("reads the live settings and the manifest id", () => {
    const flags: Record<string, boolean> = {};
    const rel = createFeatures(() => flags, "blyg");
    const dev = createFeatures(() => flags, "blyg-dev");
    expect([rel.enabled("daily"), dev.enabled("daily")]).toEqual([false, true]);
    flags.daily = true;
    expect(rel.enabled("daily")).toBe(true);
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
