import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("release metadata", () => {
  const pkg = read("package.json");
  const manifest = read("manifest.json");
  const versions = read("versions.json");

  it("keeps package.json, manifest.json and versions.json on the same version", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(versions[manifest.version as string]).toBe(manifest.minAppVersion);
  });

  it("is mobile-capable and needs the keychain API", () => {
    expect(manifest.isDesktopOnly).toBe(false);
    const [major = 0, minor = 0, patch = 0] = String(manifest.minAppVersion).split(".").map(Number);
    // 1.13.0: the declarative settings API the settings tab is built on.
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_013_000);
  });

  it("uses a plain semver version (BRAT and releases need tag == version, no 'v'); a release candidate in the snapshot adds -rc.N", () => {
    expect(String(manifest.version)).toMatch(/^\d+\.\d+\.\d+(-rc\.[1-9]\d*)?$/);
  });
});
