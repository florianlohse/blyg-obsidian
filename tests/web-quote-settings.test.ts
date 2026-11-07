// S20 web quote settings: the "Web quote" group is optional in data.json (no schema bump, plan §7 / D4), so an old file loads with the defaults,
// a bad value falls back one field at a time, and an unusable format is a warning on the Setup check, never an error that blocks publishing.
import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/settings/migrate";
import { defaultSettings, SCHEMA_VERSION } from "../src/settings/schema";
import { describeField, validateSettings } from "../src/settings/validate";

const load = (webQuote?: unknown) => migrateSettings({ schemaVersion: SCHEMA_VERSION, ...(webQuote === undefined ? {} : { webQuote }) });

describe("settings: web quote", () => {
  it("the defaults are generic: a quote with an italic source as its last line, tracking removed", () => {
    expect(defaultSettings().webQuote).toEqual({ format: "> {quote}\n> *{link}*", stripTracking: true });
    expect(defaultSettings("dev").webQuote).toEqual(defaultSettings().webQuote);
  });
  it("a data.json without the group (written before this feature) loads with the defaults and is not 'from a newer version'", () => {
    const { settings, fromNewerVersion } = load();
    expect(settings.webQuote).toEqual(defaultSettings().webQuote);
    expect(fromNewerVersion).toBe(false);
    expect(SCHEMA_VERSION).toBe(3); // adding the group did not raise the version
  });
  it("keeps what the owner chose, a multi-line format included", () => {
    expect(load({ format: "{quote}\n\nSource: {link}", stripTracking: false }).settings.webQuote).toEqual({ format: "{quote}\n\nSource: {link}", stripTracking: false });
  });
  it("reads a format typed on a device that writes CRLF as LF", () => {
    expect(load({ format: "> {quote}\r\n> {link}" }).settings.webQuote.format).toBe("> {quote}\n> {link}");
  });
  it("falls back field by field on garbage, and treats an empty format as none", () => {
    expect(load({ format: 5, stripTracking: "yes" }).settings.webQuote).toEqual(defaultSettings().webQuote);
    expect(load({ format: "  \n ", stripTracking: false }).settings.webQuote).toEqual({ format: "> {quote}\n> *{link}*", stripTracking: false });
    expect(load("nonsense").settings.webQuote).toEqual(defaultSettings().webQuote);
  });
  it("does not read the keys of the first dev build (attribution, position): no public release carried them", () => {
    expect(load({ attribution: "Source: {link}", position: "below" }).settings.webQuote).toEqual(defaultSettings().webQuote);
  });
  it("keeps an unusable format as typed, so the tab can show what is wrong", () => {
    expect(load({ format: "> {quote}\n> {lnk}" }).settings.webQuote.format).toBe("> {quote}\n> {lnk}");
  });
  it("raises no issue for the defaults, and only a warning (never an error) for an unusable format", () => {
    const fine = validateSettings(defaultSettings()).filter((i) => i.field.startsWith("webQuote"));
    expect(fine).toEqual([]);
    const s = defaultSettings();
    s.webQuote.format = "*{link}*";
    const issues = validateSettings(s).filter((i) => i.field === "webQuote.format");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toMatch(/needs \{quote\}.*default format is used/);
    expect(describeField("webQuote.format")).toBe("Web quote format");
    expect(validateSettings(s).filter((i) => i.severity === "error").length).toBe(validateSettings(defaultSettings()).filter((i) => i.severity === "error").length);
  });
});
