// S15: the reader's choices survive restarts (filter, contrast), and a missing settings file does not send the plugin back to its defaults.
import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/settings/migrate";
import { defaultSettings } from "../src/settings/schema";
import { isEmptySettingsData, readMirror } from "../src/settings/mirror";
import { DEFAULT_FILTER, readFilter } from "../src/ui/readerFeed";

describe("the feed's choices are kept in the settings", () => {
  it("start as the start values, and come back as saved", () => {
    expect(defaultSettings().readerPane.filter).toEqual(DEFAULT_FILTER);
    const saved = { sort: "longest", source: "sub-1", unreadOnly: true, length: "long", repliesToMe: true };
    expect(migrateSettings({ readerPane: { filter: saved } }).settings.readerPane.filter).toEqual(saved);
    // a file that still has the removed "Show my posts" key loses it
    expect(migrateSettings({ readerPane: { filter: { ...saved, showMine: false } } }).settings.readerPane.filter).toEqual(saved);
  });
  it("anything unknown is the start value, never a broken feed", () => {
    expect(readFilter({ sort: "random", source: 5, unreadOnly: "yes", length: "huge" })).toEqual(DEFAULT_FILTER);
    expect(readFilter(null)).toEqual(DEFAULT_FILTER);
    expect(readFilter({ source: "" }).source).toBeNull();
    expect(migrateSettings({ readerPane: { filter: "nonsense" } }).settings.readerPane.filter).toEqual(DEFAULT_FILTER);
  });
  it("the contrast is reduced, normal or high, otherwise normal", () => {
    expect(defaultSettings().readerPane.contrast).toBe("normal");
    for (const c of ["reduced", "normal", "high"] as const) expect(migrateSettings({ readerPane: { contrast: c } }).settings.readerPane.contrast).toBe(c);
    for (const bad of ["Loud", 2, null, {}]) expect(migrateSettings({ readerPane: { contrast: bad } }).settings.readerPane.contrast).toBe("normal");
  });
});

describe("the device's copy of the settings", () => {
  it("is used only when the settings file carries no settings at all", () => {
    for (const empty of [null, undefined, "", 3, [], {}, { published: [] }, { studioDrafts: {} }]) expect(isEmptySettingsData(empty), JSON.stringify(empty)).toBe(true);
    for (const has of [{ schemaVersion: 7 }, { studio: {} }, { routes: [] }, { github: {} }, { readerPane: {} }]) expect(isEmptySettingsData(has), JSON.stringify(has)).toBe(false);
  });
  it("is read back only if it is JSON text of a settings object", () => {
    const text = JSON.stringify({ ...defaultSettings("dev"), studio: { baseUrl: "https://x.workers.dev", mount: "", tokenSecretName: "my-token", importFolder: "" } });
    expect(migrateSettings(readMirror(text)).settings.studio.tokenSecretName).toBe("my-token");
    for (const bad of [null, undefined, "", "not json", "[]", "{\"a\":1}", 5, {}]) expect(readMirror(bad)).toBeNull();
  });
});
