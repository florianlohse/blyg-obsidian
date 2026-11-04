import { describe, expect, it } from "vitest";
import { manifestFor, nextDevVersion, versionKind } from "../../scripts/flavour.mjs";

const base = { id: "blyg", name: "Blyg", version: "0.9.0", minAppVersion: "1.13.0", isDesktopOnly: false };

describe("build flavours", () => {
  it("keeps the release manifest as it is", () => {
    expect(manifestFor(base, "blyg")).toEqual(base);
  });
  it("derives the dev id and name from the manifest, whatever id it holds", () => {
    expect(manifestFor(base, "blyg-dev")).toEqual({ ...base, id: "blyg-dev", name: "Blyg (dev)" });
    expect(manifestFor({ ...base, id: "obsidian-blyg" }, "blyg-dev").id).toBe("obsidian-blyg-dev");
  });
  it("never doubles the suffix and the release flavour strips it", () => {
    expect(manifestFor({ ...base, id: "blyg-dev", name: "Blyg (dev)" }, "blyg-dev").id).toBe("blyg-dev");
    expect(manifestFor({ ...base, id: "blyg-dev", name: "Blyg (dev)" }, "blyg")).toMatchObject({ id: "blyg", name: "Blyg" });
  });
  it("refuses an unknown flavour and an invalid id", () => {
    expect(() => manifestFor(base, "beta")).toThrow(/Unknown flavour/);
    expect(() => manifestFor({ ...base, id: "Bad Id" }, "blyg")).toThrow(/not a valid plugin id/);
  });
  it("classifies versions", () => {
    expect(versionKind("0.9.0")).toBe("stable");
    expect(versionKind("0.9.0-dev.1")).toBe("dev");
    for (const v of ["v0.9.0", "0.9.0-beta.1", "0.9.0-dev", "0.9.0+x", "0.9"]) expect(versionKind(v)).toBe("invalid");
  });
  it("counts dev pre-releases up per base version", () => {
    expect(nextDevVersion("0.9.0", [])).toBe("0.9.0-dev.1");
    expect(nextDevVersion("0.9.0", ["0.9.0-dev.1", "0.9.0-dev.2", "0.8.0-dev.7", "0.7.0"])).toBe("0.9.0-dev.3");
    expect(nextDevVersion("0.9.0", ["0.9.0-dev.9", "0.9.0-dev.10"])).toBe("0.9.0-dev.11");
    expect(() => nextDevVersion("0.9.0-dev.1", [])).toThrow(/plain x.y.z/);
  });
});
