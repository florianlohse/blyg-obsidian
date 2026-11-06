import { describe, expect, it, vi } from "vitest";

// The parts of "obsidian" that main.ts needs to be imported and loaded; anything else is an empty class.
vi.mock("obsidian", () => {
  class Plugin {
    commands: { id: string; name: string; callback?: () => void; checkCallback?: (checking: boolean) => boolean | void }[] = [];
    app = { vault: { adapter: { exists: () => Promise.resolve(false) }, configDir: ["", "obsidian"].join("."), on: () => ({}), getName: () => "v" }, metadataCache: { on: () => ({}) }, workspace: { on: () => ({}), getActiveFile: () => null, onLayoutReady: (f: () => void) => f(), getLeavesOfType: () => [] }, plugins: { enabledPlugins: new Set() } };
    manifest = { id: "blyg", version: "9.9.9" };
    data: unknown = null;
    addCommand(c: Plugin["commands"][number]) {
      this.commands.push(c);
    }
    addSettingTab() {}
    registerView() {}
    addRibbonIcon() {}
    registerEvent() {}
    registerInterval() {}
    registerDomEvent() {}
    loadData() {
      return Promise.resolve(this.data);
    }
    saveData(d: unknown) {
      this.data = d;
      return Promise.resolve();
    }
  }
  class Blank {}
  const fn = () => ({});
  return {
    Plugin,
    PluginSettingTab: class { update() {} hide() {} refreshDomState() {} },
    SecretComponent: Blank, FuzzySuggestModal: Blank, ItemView: Blank, MarkdownView: Blank, Modal: Blank, Notice: Blank, Setting: Blank, SuggestModal: Blank, TFile: Blank, TAbstractFile: Blank, WorkspaceLeaf: Blank,
    debounce: <T>(f: T) => f, moment: fn, normalizePath: (p: string) => p, parseYaml: fn, requestUrl: fn, sanitizeHTMLToDom: fn, stringifyYaml: () => "",
  };
});

import BlygPlugin from "../src/main";
import { defaultSettings } from "../src/settings/schema";

async function load(mutate: (s: ReturnType<typeof defaultSettings>) => void) {
  const plugin = new BlygPlugin({} as never, { id: "blyg", version: "9.9.9" } as never) as unknown as {
    commands: { id: string; checkCallback?: (checking: boolean) => boolean | void; callback?: () => void }[];
    settings: ReturnType<typeof defaultSettings>;
    onload(): Promise<void>;
    loadSettings(): Promise<void>;
  };
  const s = defaultSettings();
  mutate(s);
  plugin.loadSettings = () => {
    plugin.settings = s;
    return Promise.resolve();
  };
  await plugin.onload();
  return plugin;
}

const REPOST = ["repost-to-studio", "list-reposted-items"];

describe("Repost commands are offered only to a GitHub setup (M1 0.9.0: R11)", () => {
  it("a Studio-only install does not see them in the palette", async () => {
    const p = await load((s) => {
      s.studio.baseUrl = "https://blyg.example.com";
      s.routes = [{ vaultPrefix: "blyg/", mode: "studio", label: "Blyg item" }];
    });
    for (const id of REPOST) {
      const c = p.commands.find((x) => x.id === id);
      expect(c, id).toBeDefined(); // kept, not removed
      expect(c?.checkCallback?.(true), id).toBe(false);
    }
  });

  it("a setup with a GitHub setup or a GitHub route sees them", async () => {
    for (const mutate of [
      (s: ReturnType<typeof defaultSettings>) => void (s.github.owner = "someone"),
      (s: ReturnType<typeof defaultSettings>) => void (s.routes = [{ vaultPrefix: "a/", mode: "blyg", label: "A" }]),
    ]) {
      const p = await load(mutate);
      for (const id of REPOST) expect(p.commands.find((x) => x.id === id)?.checkCallback?.(true), id).toBe(true);
    }
  });
});
