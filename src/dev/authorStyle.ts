// HK5 (prototype C inside the plugin), DEVELOPMENT BUILD ONLY (registered only when the manifest id ends in "-dev", like the timing command): a chooser that switches the open post
// between the Clean look and three INVENTED author profiles. The profiles are made up for this prototype; no real blyg's values belong here. Nothing is fetched or stored.
import { FuzzySuggestModal, Notice, type App, type Plugin } from "obsidian";
import { isDevBuildId } from "../studio/devLock";
import { applyStyle } from "../style/apply";
import { resolveStyle } from "../style/resolve";
import type { StyleProfile } from "../style/profile";
import type { ReaderContrast } from "../ui/readerLook";

/** The reader's view type (src/ui/ReaderView.ts BLYG_READER_VIEW); repeated so this file stays free of the view's imports. */
const READER_VIEW_TYPE = "blyg-reader";

export const PROTOTYPE_PROFILES: Array<{ name: string; profile: StyleProfile }> = [
  { name: "Paper (serif, warm)", profile: { version: 1, font: "serif",
    light: { surface: "#fbf6ea", text: "#2b2118", softText: "#5a4a3a", accent: "#8a3b12", rule: "#cdbf9f" },
    dark: { surface: "#1f1a14", text: "#f3e9d6", softText: "#cdbda3", accent: "#f0a36b", rule: "#5b4e3c" } } },
  { name: "Ink (sans, cool)", profile: { version: 1, font: "sans",
    light: { surface: "#eef3f8", text: "#0e1b2a", softText: "#3d5068", accent: "#0b4f9c", rule: "#a9bbcf" },
    dark: { surface: "#0d1722", text: "#e6eef7", softText: "#a9bbd0", accent: "#7fb4f0", rule: "#34475c" } } },
  { name: "Terminal (mono, green)", profile: { version: 1, font: "mono",
    light: { surface: "#f1f6ee", text: "#10230f", softText: "#35502f", accent: "#1a6b25", rule: "#a8c3a0" },
    dark: { surface: "#08120a", text: "#d9f2d4", softText: "#98c391", accent: "#6fe07e", rule: "#2b4a2d" } } },
];

interface Choice { name: string; profile: StyleProfile | null }
const CHOICES: Choice[] = [{ name: "Clean (the reader's own look)", profile: null }, ...PROTOTYPE_PROFILES];

/** Switch the reading surfaces of the open reader panes to `profile` (null: Clean). Returns the reason when the profile was refused (Clean is shown then). */
export function switchStyle(app: App, profile: StyleProfile | null, level: ReaderContrast): string | undefined {
  const dark = activeDocument.body.classList.contains("theme-dark");
  const r = resolveStyle(profile, { dark, level });
  for (const leaf of app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
    const surface = (leaf.view as { contentEl?: HTMLElement }).contentEl?.querySelector<HTMLElement>(".blyg-reader-surface");
    if (surface) applyStyle(surface, r);
  }
  return r.reason;
}

class StyleChooser extends FuzzySuggestModal<Choice> {
  constructor(app: App, private readonly level: () => ReaderContrast) {
    super(app);
    this.setPlaceholder("Author look for the open post");
  }
  getItems(): Choice[] { return CHOICES; }
  getItemText(c: Choice): string { return c.name; }
  onChooseItem(c: Choice): void {
    const reason = switchStyle(this.app, c.profile, this.level());
    new Notice(reason ? `Clean look (${reason})` : c.name);
  }
}

export function registerAuthorStyleCommand(plugin: Plugin, level: () => ReaderContrast): void {
  if (!isDevBuildId(plugin.manifest.id)) return;
  plugin.addCommand({ id: "dev-author-look", name: "Reader: switch the author look (prototype)", callback: () => new StyleChooser(plugin.app, level).open() });
}

