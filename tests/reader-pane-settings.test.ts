// PROOF OF CONCEPT (S15): the reader's image setting. Optional in data.json; anything but "always" means "click" (a typo or a value from a later
// version must never switch images on by accident), and an older data.json without the key loads unchanged.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/settings/migrate";
import { defaultSettings } from "../src/settings/schema";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/data-0.9.0.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("reader image setting", () => {
  it("defaults to load on click, for a fresh install and for a 0.9.0 data.json", () => {
    expect(defaultSettings().readerPane.images).toBe("click");
    expect(migrateSettings(fixture).settings.readerPane.images).toBe("click");
  });
  it("keeps 'always' when the owner chose it", () => {
    expect(migrateSettings({ ...fixture, readerPane: { images: "always" } }).settings.readerPane.images).toBe("always");
  });
  it("reads anything else as 'click'", () => {
    for (const bad of ["Always", "yes", true, 1, null, undefined, {}, ["always"]]) {
      expect(migrateSettings({ ...fixture, readerPane: { images: bad } }).settings.readerPane.images).toBe("click");
    }
    expect(migrateSettings({ ...fixture, readerPane: "always" }).settings.readerPane.images).toBe("click");
  });
});
