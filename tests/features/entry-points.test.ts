// Enforcer: a command, ribbon icon, view, editor extension or protocol handler may be registered only in a registered feature's module (features/registry.ts
// `modules`) or on the explicit core allowlist (CORE_ENTRIES, by count, so a new core entry is a deliberate edit). Also checks the gate itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CORE_ENTRIES, FEATURES, createFeatures } from "../../src/features/registry";

vi.mock("obsidian", () => ({ FuzzySuggestModal: class { setPlaceholder() {} }, Modal: class {}, Notice: class {}, setIcon: () => {}, ItemView: class {}, TFile: class {}, normalizePath: (p: string) => p }));
import { registerFeatureEntries } from "../../src/features/register";

const CALLS = ["addCommand", "addRibbonIcon", "registerView", "registerEditorExtension", "registerObsidianProtocolHandler"];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

describe("every entry point belongs to a feature or to the core", () => {
  const found: Record<string, Record<string, number>> = {};
  for (const file of walk("src")) {
    const text = strip(readFileSync(file, "utf8"));
    for (const call of CALLS) {
      const n = (text.match(new RegExp(`\\b${call}\\s*\\(`, "g")) ?? []).length;
      if (n > 0) (found[file] ??= {})[call] = n;
    }
  }
  const featureModules = new Set(FEATURES.flatMap((f) => f.modules));
  it("finds no registration outside a feature module or the core allowlist", () => {
    const stray = Object.entries(found).filter(([file]) => !featureModules.has(file) && !(file in CORE_ENTRIES));
    expect(stray.map(([f]) => f)).toEqual([]);
  });
  it("finds the core files with exactly the allowed counts", () => {
    for (const [file, counts] of Object.entries(CORE_ENTRIES)) expect(found[file]).toEqual(counts);
  });
  it("names modules that exist and register something", () => {
    for (const m of featureModules) expect(found[m], m).toBeDefined();
  });
});

const fakePlugin = (id: string) => {
  const calls: string[] = [];
  const p = {
    manifest: { id },
    app: { workspace: { onLayoutReady: () => {} }, vault: {} },
    addCommand: (c: { id: string }) => calls.push(`cmd:${c.id}`),
    addRibbonIcon: (_i: string, t: string) => calls.push(`ribbon:${t}`),
    registerView: (t: string) => calls.push(`view:${t}`),
    registerEvent: () => {},
  };
  return { calls, p: p as never };
};
const deps = { digest: { readList: async () => null, ai: { settings: () => ({}) as never, keychain: {} as never, transport: {} as never } }, share: { settings: () => ({}) as never, build: () => ({}) as never, openReader: async () => {} }, contrast: () => "normal" as const };

describe("registerFeatureEntries", () => {
  it("registers nothing switchable in the release build by default", () => {
    const { calls, p } = fakePlugin("blyg");
    registerFeatureEntries(p, createFeatures(() => ({}), "blyg"), deps);
    expect(calls).toEqual([]);
  });
  it("registers everything in the dev build by default", () => {
    const { calls, p } = fakePlugin("blyg-dev");
    registerFeatureEntries(p, createFeatures(() => ({}), "blyg-dev"), deps);
    expect(calls).toEqual(expect.arrayContaining(["cmd:open-daily", "cmd:show-digest-sent", "ribbon:Open Blyg Daily", "cmd:open-address-from-clipboard", "cmd:dev-author-look", "cmd:dev-draw-synthetic-posts"]));
  });
  it("leaves out a feature that is switched off, and the AI layer alone", () => {
    const { calls, p } = fakePlugin("blyg-dev");
    registerFeatureEntries(p, createFeatures(() => ({ "digest-ai": false, "share-open": false }), "blyg-dev"), deps);
    expect(calls).toContain("cmd:open-daily");
    expect(calls).not.toContain("cmd:show-digest-sent");
    expect(calls).not.toContain("cmd:open-address-from-clipboard");
    expect(calls).toContain("cmd:dev-author-look");
  });
  it("turns the release build's experimental features on with the user's switch", () => {
    const { calls, p } = fakePlugin("blyg");
    registerFeatureEntries(p, createFeatures(() => ({ daily: true }), "blyg"), deps);
    expect(calls).toContain("cmd:open-daily");
    expect(calls).not.toContain("cmd:show-digest-sent");
  });
});
