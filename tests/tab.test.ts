import { beforeEach, describe, expect, it, vi } from "vitest";

// A minimal stand-in for the parts of "obsidian" the settings tab touches at import and construction time.
vi.mock("obsidian", () => {
  class PluginSettingTab {
    constructor(
      public app: unknown,
      public plugin: unknown,
    ) {}
    refreshDomState(): void {}
    update(): void {}
    hide(): void {}
  }
  class SecretComponent {}
  return { PluginSettingTab, SecretComponent, debounce: <T>(fn: T) => fn };
});

import { BlygSettingTab } from "../src/settings/tab";
import { defaultSettings, type BlygSettings } from "../src/settings/schema";
import { getPath } from "../src/settings/path";

interface Def {
  name?: string;
  type?: string;
  heading?: string;
  control?: { type: string; key: string; options?: Record<string, string> };
  render?: unknown;
  items?: Def[];
  visible?: boolean | (() => boolean);
  action?: unknown;
}

function makeTab(settings: BlygSettings, locked = false) {
  const saved: BlygSettings[] = [];
  const plugin = {
    settings,
    isSettingsLocked: locked,
    manifest: { version: "9.8.7" },
    saveSettings: () => {
      saved.push(structuredClone(settings));
      return Promise.resolve();
    },
    runConnectionCheck: () => Promise.resolve({ ok: true, lines: [] }),
  };
  const tab = new BlygSettingTab({} as never, plugin as never);
  return { tab, plugin, saved };
}

function controls(items: Def[]): Def[] {
  return items.flatMap((d) => [...(d.control ? [d] : []), ...controls(d.items ?? [])]);
}

describe("settings tab definitions", () => {
  let settings: BlygSettings;
  beforeEach(() => {
    settings = defaultSettings();
    settings.routes = [
      { vaultPrefix: "a/", mode: "blyg", label: "A" },
      { vaultPrefix: "b/", mode: "plain", dest: "src/b/", label: "B" },
    ];
  });

  it("only declares keys that exist in the settings (or are optional route fields)", () => {
    const { tab } = makeTab(settings);
    const defs = tab.getSettingDefinitions() as Def[];
    const optional = /\.(dest|requireTitle|webUrl|draftsOnly)$/;
    for (const d of controls(defs)) {
      const key = d.control?.key as string;
      if (optional.test(key)) continue;
      expect(getPath(settings, key), key).not.toBeUndefined();
    }
  });

  it("caps the fragment-length control at the contract's limit", () => {
    const { tab } = makeTab(settings);
    const cap = controls(tab.getSettingDefinitions() as Def[]).find((d) => d.control?.key === "blyg.fragmentCharCap");
    expect((cap?.control as { max?: number } | undefined)?.max).toBe(1000);
  });

  it("never declares a control that would store the token itself", () => {
    const { tab } = makeTab(settings);
    const keys = controls(tab.getSettingDefinitions() as Def[]).map((d) => d.control?.key);
    expect(keys.some((k) => /token(?!SecretName)/i.test(k ?? ""))).toBe(false);
  });

  it("shows each route as its own section with live fields and a visible remove row", () => {
    const { tab } = makeTab(settings);
    const defs = tab.getSettingDefinitions() as Def[];
    const routeGroups = defs.filter((d) => d.heading?.startsWith("Route "));
    expect(routeGroups.map((g) => g.heading)).toEqual(["Route 1", "Route 2"]);
    // No sub-pages: their titles went stale in 0.0.2.
    expect(JSON.stringify(defs)).not.toContain('"type":"page"');
    for (const [i, g] of routeGroups.entries()) {
      const keys = (g.items ?? []).filter((x) => x.control).map((x) => x.control?.key);
      expect(keys).toContain(`routes.${i}.vaultPrefix`);
      expect(keys).toContain(`routes.${i}.label`);
      expect(keys).toContain(`routes.${i}.mode`);
      const remove = (g.items ?? []).find((x) => x.name === `Remove route ${i + 1}`);
      expect(typeof remove?.action).toBe("function");
    }
  });

  it("shows the plain-only fields only on plain routes", () => {
    const { tab } = makeTab(settings);
    const groups = (tab.getSettingDefinitions() as Def[]).filter((d) => d.heading?.startsWith("Route "));
    const visibility = (g: Def) =>
      (g.items ?? [])
        .filter((i) => i.control && /\.(dest|requireTitle|webUrl)$/.test(i.control.key))
        .map((i) => (typeof i.visible === "function" ? i.visible() : i.visible));
    expect(visibility(groups[0] as Def)).toEqual([false, false, false]);
    expect(visibility(groups[1] as Def)).toEqual([true, true, true]);
  });

  it("offers Drafts only on Studio routes only, and switching a route away from Studio drops it", () => {
    const { tab } = makeTab(settings);
    const groups = (tab.getSettingDefinitions() as Def[]).filter((d) => d.heading?.startsWith("Route "));
    const item = (g: Def) => (g.items ?? []).find((i) => i.control?.key.endsWith(".draftsOnly"));
    expect(groups.map((g) => item(g) !== undefined)).toEqual(groups.map(() => true));
    const shown = groups.map((g) => {
      const v = item(g)?.visible;
      return typeof v === "function" ? v() : v;
    });
    expect(shown).toEqual(settings.routes.map((r) => r.mode === "studio"));
    settings.routes[0] = { vaultPrefix: "s/", mode: "studio", label: "S", draftsOnly: true };
    tab.setControlValue("routes.0.mode", "blyg");
    expect(settings.routes[0]).not.toHaveProperty("draftsOnly");
  });

  it("writes a changed value into the settings, trimmed, and saves", () => {
    const { tab, saved } = makeTab(settings);
    tab.setControlValue("github.owner", "  someone ");
    expect(settings.github.owner).toBe("someone");
    expect(saved).toHaveLength(1);
    expect(tab.getControlValue("github.owner")).toBe("someone");
  });

  it("gives a route switched to plain an empty destination to edit", () => {
    const { tab } = makeTab(settings);
    tab.setControlValue("routes.0.mode", "plain");
    expect(settings.routes[0]).toMatchObject({ mode: "plain", dest: "" });
  });

  it("adds a route, and removes the right one, rebuilding the definitions each time", () => {
    const { tab, saved } = makeTab(settings);
    const update = vi.spyOn(tab, "update");
    const find = (name: string): Def | undefined =>
      (tab.getSettingDefinitions() as Def[]).flatMap((d) => d.items ?? []).find((i) => i.name === name);

    (find("Add route")?.action as () => void)();
    expect(settings.routes).toHaveLength(3);
    expect(update).toHaveBeenCalledTimes(1);

    (find("Remove route 1")?.action as () => void)();
    expect(settings.routes.map((r) => r.vaultPrefix)).toEqual(["b/", ""]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(saved.length).toBeGreaterThanOrEqual(2);

    (find("Remove route 2")?.action as () => void)();
    expect(settings.routes.map((r) => r.vaultPrefix)).toEqual(["b/"]);
  });

  it("keeps edits to a route in the stored settings as soon as they are made", () => {
    const { tab, saved } = makeTab(settings);
    tab.setControlValue("routes.0.vaultPrefix", " website/blyg/ ");
    tab.setControlValue("routes.0.label", "Blyg note");
    expect(settings.routes[0]).toMatchObject({ vaultPrefix: "website/blyg/", label: "Blyg note" });
    expect(saved.at(-1)?.routes[0]?.vaultPrefix).toBe("website/blyg/");
  });

  it("ignores writes to keys that do not exist", () => {
    const { tab, saved } = makeTab(settings);
    tab.setControlValue("nope.nothing", "x");
    tab.setControlValue("__proto__.polluted", "x");
    expect(saved).toHaveLength(0);
  });

  it("announces read-only settings at the top when a newer plugin version wrote them", () => {
    const first = (makeTab(settings, true).tab.getSettingDefinitions() as Def[])[0];
    expect(first?.name).toBe("Settings are read-only");
    const normal = (makeTab(settings, false).tab.getSettingDefinitions() as Def[])[0];
    expect(normal?.name).toBe("Setup check");
  });
});

describe("settings tab for someone with only a Studio (M1 A2.4)", () => {
  const headings = (items: Def[]): string[] => items.flatMap((d) => (d.heading ? [d.heading] : []));
  const studioOnly = (): BlygSettings => {
    const s = defaultSettings();
    s.studio = { baseUrl: "https://blyg.example.com", mount: "", tokenSecretName: "studio-token", importFolder: "" };
    return s;
  };

  it("does not show the GitHub group, or the GitHub-site fields of Publication, or the folder Kind", () => {
    const { tab } = makeTab(studioOnly());
    const defs = tab.getSettingDefinitions() as unknown as Def[];
    expect(headings(defs)).not.toContain("GitHub");
    expect(headings(defs)).toContain("Studio");
    const keys = controls(defs).map((d) => d.control?.key);
    for (const hidden of ["github.owner", "github.repo", "github.branch", "github.previewBranch", "github.useBranch", "github.watchDeploy", "blyg.origin", "blyg.previewOrigin", "blyg.itemsDir"]) {
      expect(keys, hidden).not.toContain(hidden);
    }
    // what a Studio user does need stays
    for (const shown of ["studio.baseUrl", "studio.mount", "blyg.fragmentCharCap", "routes.0.vaultPrefix", "routes.0.draftsOnly"]) expect(keys, shown).toContain(shown);
    const kind = controls(defs).find((d) => d.control?.key === "routes.0.mode");
    const hidden = typeof kind?.visible === "function" ? !kind.visible() : kind?.visible === false;
    expect(hidden).toBe(true);
  });

  const toggleOf = (tab: ReturnType<typeof makeTab>["tab"]) => {
    const defs = tab.getSettingDefinitions() as unknown as Def[];
    const adv = defs.find((d) => d.heading === "Advanced");
    const row = adv?.items?.find((d) => d.name === "Also publish to a GitHub-hosted site");
    let value: boolean | undefined;
    let onChange: ((on: boolean) => void) | undefined;
    const t = { setValue: (v: boolean) => ((value = v), t), onChange: (f: (on: boolean) => void) => ((onChange = f), t) };
    (row?.render as ((setting: unknown) => void) | undefined)?.({ addToggle: (f: (x: typeof t) => void) => f(t) });
    return { defs, adv, value, flip: (on: boolean) => onChange?.(on) };
  };
  const keysOf = (defs: Def[]): (string | undefined)[] => controls(defs).map((d) => d.control?.key);

  it("a new route is a Studio route", () => {
    const { tab, plugin } = makeTab(studioOnly());
    const defs = tab.getSettingDefinitions() as unknown as Def[];
    const add = defs.flatMap((d) => d.items ?? []).find((d) => d.name === "Add route");
    (add?.action as () => void)();
    expect(plugin.settings.routes.at(-1)?.mode).toBe("studio");
  });

  it("Studio only: the switch is off and the GitHub settings are not there; switching on expands them in the same Advanced box, off collapses them (M1 0.9.0: F6)", () => {
    const { tab } = makeTab(studioOnly());
    const first = toggleOf(tab);
    expect(first.value).toBe(false);
    expect(keysOf(first.adv?.items ?? [])).not.toContain("github.owner");
    first.flip(true);
    const on = toggleOf(tab);
    expect(on.value).toBe(true);
    // the GitHub fields now sit inside the Advanced box, right after the switch, and nowhere else
    expect(on.adv?.items?.[0]?.name).toBe("Also publish to a GitHub-hosted site");
    expect(keysOf(on.adv?.items ?? [])).toEqual(expect.arrayContaining(["github.owner", "github.repo", "github.watchDeploy", "blyg.origin", "blyg.itemsDir"]));
    expect(headings(on.defs)).not.toContain("GitHub");
    expect(keysOf(on.defs.filter((d) => d.heading !== "Advanced"))).not.toContain("github.owner");
    const kind = controls(on.defs).find((d) => d.control?.key === "routes.0.mode");
    expect(typeof kind?.visible === "function" ? kind.visible() : kind?.visible).not.toBe(false);
    on.flip(false);
    const off = toggleOf(tab);
    expect(off.value).toBe(false);
    expect(keysOf(off.defs)).not.toContain("github.owner");
  });

  it("a setup that uses GitHub starts with the switch on, every field there, and collapsing never deletes a value (M1 0.9.0: F6)", () => {
    const s = defaultSettings();
    s.routes = [{ vaultPrefix: "a/", mode: "blyg", label: "A" }];
    s.github.owner = "someone";
    s.github.repo = "site";
    s.github.tokenSecretName = "gh-token";
    s.blyg.origin = "https://example.com/blyg/";
    const before = structuredClone(s);
    const { tab, plugin } = makeTab(s);
    const start = toggleOf(tab);
    expect(start.value).toBe(true);
    expect(keysOf(start.adv?.items ?? [])).toEqual(expect.arrayContaining(["github.owner", "github.repo", "github.branch", "github.previewBranch", "github.useBranch", "github.watchDeploy", "blyg.origin", "blyg.previewOrigin", "blyg.itemsDir"]));
    expect(controls(start.defs).map((d) => d.control?.key)).toContain("routes.0.mode");
    start.flip(false);
    expect(keysOf(toggleOf(tab).defs)).not.toContain("github.owner");
    expect(plugin.settings).toEqual(before);
    toggleOf(tab).flip(true);
    expect(keysOf(toggleOf(tab).defs)).toContain("github.owner");
    expect(plugin.settings).toEqual(before);
  });

  it("the switch state is kept while the page is open and derived again when it is opened anew", () => {
    const { tab } = makeTab(studioOnly());
    toggleOf(tab).flip(true);
    expect(toggleOf(tab).value).toBe(true);
    tab.hide();
    expect(toggleOf(tab).value).toBe(false);
  });

  it("filling in a GitHub setting makes the next visit start with the switch on", () => {
    const s = studioOnly();
    s.github.owner = "someone";
    const { tab } = makeTab(s);
    expect(toggleOf(tab).value).toBe(true);
  });
});
