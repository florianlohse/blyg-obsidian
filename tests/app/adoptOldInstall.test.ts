import { describe, expect, it } from "vitest";
import { adoptOldInstall, isPluginEnabled, OLD_PLUGIN_ID, type AdoptPorts } from "../../src/app/adoptOldInstall";

function ports(over: Partial<AdoptPorts> & { own?: unknown; old?: string | null }): { p: AdoptPorts; saved: Record<string, unknown>[] } {
  const saved: Record<string, unknown>[] = [];
  const p: AdoptPorts = {
    ownId: "blyg",
    loadOwn: async () => over.own ?? null,
    saveOwn: async (d) => void saved.push(d),
    readOld: async () => (over.old === undefined ? null : over.old),
    oldPluginEnabled: () => false,
    ...over,
  };
  return { p, saved };
}

describe("taking over the data.json of the old install (id obsidian-blyg → blyg)", () => {
  it("copies settings, published records and drafts when the new plugin has no data of its own", async () => {
    const old = JSON.stringify({ schemaVersion: 2, studio: { baseUrl: "https://x.example" }, published: { "a.md": { hash: "h" } }, studioDrafts: [{ id: "d1" }] });
    const { p, saved } = ports({ old });
    expect(await adoptOldInstall(p)).toBe("adopted");
    expect(saved).toEqual([JSON.parse(old)]);
  });

  it("does nothing when the new plugin already has data (an install that was used, or a synced copy)", async () => {
    const { p, saved } = ports({ own: { schemaVersion: 2 }, old: JSON.stringify({ schemaVersion: 2, x: 1 }) });
    expect(await adoptOldInstall(p)).toBe("not-needed");
    expect(saved).toEqual([]);
  });

  it("treats an empty object as no data", async () => {
    const { p, saved } = ports({ own: {}, old: JSON.stringify({ a: 1 }) });
    expect(await adoptOldInstall(p)).toBe("adopted");
    expect(saved).toEqual([{ a: 1 }]);
  });

  it("does nothing when there is no old install", async () => {
    const { p, saved } = ports({ old: null });
    expect(await adoptOldInstall(p)).toBe("nothing-to-adopt");
    expect(saved).toEqual([]);
  });

  it("refuses a broken or foreign file and writes nothing", async () => {
    for (const old of ["{not json", "[1,2]", "42", "null"]) {
      const { p, saved } = ports({ old });
      expect(await adoptOldInstall(p)).toBe("unreadable");
      expect(saved).toEqual([]);
    }
  });

  it("an unreadable old folder does not stop the plugin from starting", async () => {
    const { p, saved } = ports({ readOld: async () => { throw new Error("no access"); } });
    expect(await adoptOldInstall(p)).toBe("unreadable");
    expect(saved).toEqual([]);
  });

  it("never runs inside the old id itself", async () => {
    const { p, saved } = ports({ ownId: OLD_PLUGIN_ID, old: JSON.stringify({ a: 1 }) });
    expect(await adoptOldInstall(p)).toBe("not-needed");
    expect(saved).toEqual([]);
  });

  it("a development build (blyg-dev) never takes over the live install's data", async () => {
    const { p, saved } = ports({ ownId: "blyg-dev", old: JSON.stringify({ a: 1 }) });
    expect(await adoptOldInstall(p)).toBe("not-needed");
    expect(saved).toEqual([]);
  });
  it("an enabled old plugin blocks the takeover and everything else: nothing is read or written (review P1: both register the same view)", async () => {
    let read = false;
    const { p, saved } = ports({ old: JSON.stringify({ a: 1 }), oldPluginEnabled: () => true, readOld: async () => { read = true; return "{}"; } });
    expect(await adoptOldInstall(p)).toBe("old-plugin-enabled");
    expect(saved).toEqual([]);
    expect(read).toBe(false);
  });

  it("the old plugin being enabled does not matter for a dev build or inside the old id", async () => {
    for (const ownId of ["blyg-dev", OLD_PLUGIN_ID]) {
      const { p } = ports({ ownId, oldPluginEnabled: () => true });
      expect(await adoptOldInstall(p)).toBe("not-needed");
    }
  });

  it("a takeover whose write fails does not throw: the plugin starts with empty settings (review P9)", async () => {
    const { p } = ports({ old: JSON.stringify({ a: 1 }), saveOwn: async () => { throw new Error("disk full"); } });
    expect(await adoptOldInstall(p)).toBe("write-failed");
  });

  it("finds an enabled plugin in Obsidian's plugin manager, and copes with a manager of another shape", () => {
    expect(isPluginEnabled({ plugins: { enabledPlugins: new Set([OLD_PLUGIN_ID]) } }, OLD_PLUGIN_ID)).toBe(true);
    expect(isPluginEnabled({ plugins: { enabledPlugins: new Set(["x"]) } }, OLD_PLUGIN_ID)).toBe(false);
    for (const app of [undefined, null, {}, { plugins: {} }, { plugins: { enabledPlugins: [OLD_PLUGIN_ID] } }]) expect(isPluginEnabled(app, OLD_PLUGIN_ID)).toBe(false);
  });
});
