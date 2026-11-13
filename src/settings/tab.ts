import { importFolderChoices } from "../studio/import";
import { DEV_STUDIO_RULE, isDevStudioLock } from "../studio/devLock";
import {
  debounce,
  PluginSettingTab,
  SecretComponent,
  type App,
  type Setting,
  type SettingDefinitionItem,
  type SettingGroupItem,
} from "obsidian";
import type BlygPlugin from "../main";
import { CONTRACT_MAX_FRAGMENT_CAP } from "../contract";
import { getPath, setPath } from "./path";
import type { Route } from "./schema";
import { isStudioOnly } from "./studioOnly";
import { describeField, validateSettings } from "./validate";

/**
 * The settings UI, declared with Obsidian 1.13's declarative settings API (so every field is searchable in
 * Obsidian's settings search). Values are read and written by dotted key into `plugin.settings`
 * (see getControlValue / setControlValue below).
 */
export class BlygSettingTab extends PluginSettingTab {
  private issuesSetting: Setting | null = null;
  /**
   * The "Also publish to a GitHub-hosted site" switch (Advanced). Not saved and not in the settings schema: null until the page is first
   * drawn, then derived from the loaded settings (on when they carry a GitHub setup or a legacy route), kept while the settings tab is
   * open and forgotten when it closes. Switching off only hides: no value is ever deleted.
   */
  private showGithub: boolean | null = null;
  private readonly save = debounce(() => void this.plugin.saveSettings(), 500, true);

  constructor(
    app: App,
    private readonly plugin: BlygPlugin,
  ) {
    super(app, plugin);
  }

  override getControlValue(key: string): unknown {
    return getPath(this.plugin.settings, key);
  }

  override setControlValue(key: string, value: unknown): void {
    const clean = typeof value === "string" ? value.trim() : value;
    if (!setPath(this.plugin.settings, key, clean)) return;
    // A route switched to "plain" needs a (still empty) destination to be edited.
    const modeMatch = /^routes\.(\d+)\.mode$/.exec(key);
    if (modeMatch && clean === "plain") {
      const route = this.plugin.settings.routes[Number(modeMatch[1])];
      if (route && route.dest === undefined) route.dest = "";
    }
    // "Drafts only" exists for Studio routes: leaving the mode drops it, so it cannot come back unseen.
    if (modeMatch && clean !== "studio") {
      const route = this.plugin.settings.routes[Number(modeMatch[1])];
      if (route) delete route.draftsOnly;
    }
    this.changed();
  }

  /** Is the GitHub-site part expanded in the Advanced box? */
  private githubOpen(): boolean {
    this.showGithub ??= !isStudioOnly(this.plugin.settings);
    return this.showGithub;
  }

  /** Hide everything about GitHub-hosted sites while the Advanced switch is off (studioOnly.ts). */
  private studioOnlyView(): boolean {
    return !this.githubOpen();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const studioOnly = this.studioOnlyView();
    const text = (name: string, desc: string, key: string, placeholder?: string): SettingGroupItem => ({
      name,
      desc,
      control: { type: "text", key, ...(placeholder ? { placeholder } : {}) },
    });

    const items: SettingDefinitionItem[] = [];

    if (isDevStudioLock()) {
      items.push({
        name: "Development build",
        desc: `This build connects only to test Studios (${DEV_STUDIO_RULE}). Any other Studio address is refused, so it can never publish to your real Studio.`,
        searchable: false,
      });
    }

    if (this.plugin.isSettingsLocked) {
      items.push({
        name: "Settings are read-only",
        desc: "These settings were saved by a newer version of the plugin. Update the plugin on this device; changes made here will not be saved.",
      });
    }

    items.push({
      name: "Setup check",
      desc: "",
      searchable: false,
      render: (setting) => {
        this.issuesSetting = setting;
        this.renderIssues();
      },
    });

    items.push({ name: "Version", desc: `This device runs Blyg ${this.plugin.manifest.version}.`, searchable: false });

    items.push({
      type: "group",
      heading: "Studio",
      items: [
        text("Studio address", "A Blygger Studio that Studio routes publish to: its host, e.g. https://blyg.example.com. The owner API is always at {host}/api.", "studio.baseUrl", "https://blyg.example.com"),
        text("Studio mount", "Empty when the Studio has its own host. A path like /blyg when it is mounted below one. Public pages are then {host}{mount}/f/{id}/.", "studio.mount", "/blyg"),
        {
          name: "Studio token",
          desc: "A REST token from the Studio (More → Client access) with owner:read, owner:draft and owner:publish, plus owner:manage to change hoppers. It expires after 30 days. Pick or create an entry in the keychain; the plugin remembers only the entry's name.",
          aliases: ["secret", "keychain", "bearer", "api"],
          render: (setting) => {
            setting.addComponent((el) =>
              new SecretComponent(this.app, el).setValue(s.studio.tokenSecretName).onChange((name) => {
                this.setControlValue("studio.tokenSecretName", name);
              }),
            );
          },
        },
        {
          name: "Import folder",
          desc: "Where “Studio: import new items” puts notes for items written in the Studio (drafts too). Default: the first Studio folder that is not Drafts-only.",
          aliases: ["import", "sync", "download"],
          // Drawn here, not as a declarative dropdown: the choices are the Studio folders as they are when the page is drawn. The static list
          // was fixed when the definitions were read, and on Florian's iPad (2026-11-02) the Drafts-only test folder could not be chosen.
          render: (setting) => {
            setting.addDropdown((d) => {
              const current = this.plugin.settings.studio.importFolder;
              d.addOption("", "Default");
              for (const c of importFolderChoices(this.plugin.settings.routes, current)) d.addOption(c.value, c.label);
              d.setValue(current).onChange((value) => this.setControlValue("studio.importFolder", value));
            });
          },
        },
        this.checkConnectionItem("Tests the address, the Studio's version, the token, its permissions and how long it still lasts. Changes nothing.", () => this.plugin.runStudioConnectionCheck(), "Check connection"),
      ],
    });

    items.push({
      type: "group",
      heading: "Publication",
      items: [
        {
          name: "Fragment character cap",
          desc: `Longer fragments are refused before anything is sent. At most ${CONTRACT_MAX_FRAGMENT_CAP}: the site rejects longer ones.`,
          control: { type: "number", key: "blyg.fragmentCharCap", min: 1, max: CONTRACT_MAX_FRAGMENT_CAP, step: 1 },
        },
        {
          name: "Thread length warning",
          desc: "Threads longer than this get a warning (no hard limit).",
          control: { type: "number", key: "blyg.threadSoftCap", min: 1, step: 1 },
        },
      ],
    });

    items.push({
      type: "group",
      heading: "Templates",
      items: [
        text(
          "Fragment template",
          "A note in your vault that every new fragment starts from (path, e.g. “Templates/Fragment.md”). Applies to New fragment and to text moved out of another note. Placeholders: {{title}}, {{date}}, {{time}}, {{date:FORMAT}}. Empty: a bare note.",
          "templates.fragment",
          "Templates/Fragment.md",
        ),
        text(
          "Thread template",
          "The same for every new thread (New thread, Quote in thread, text moved into a thread). The thread property is added for you; the template must not set the other kind or any other blyg_ property.",
          "templates.thread",
          "Templates/Thread.md",
        ),
      ],
    });

    items.push({
      type: "group",
      heading: "Web quote",
      items: [
        {
          name: "Web quote format",
          desc: "What “Insert web quote” writes, as a template for the whole block (it has nothing to do with blyg items). {quote} is the quote, {link} the whole link, {alias} its visible text, {url} the address. Each line stands as you type it, so a blank line appears only where you leave one. Default: “> {quote}” on one line and “> *{link}*” on the next (a quote with an italic source as its last line). The quote's own lines follow the marks in front of {quote}.",
          aliases: ["quote", "attribution", "source", "substack", "template"],
          control: { type: "textarea", key: "webQuote.format", placeholder: "> {quote}\n> *{link}*", rows: 3 },
        },
        {
          name: "Remove tracking parameters",
          desc: "Takes utm_*, fbclid, gclid and similar (and Substack's share parameters) out of the address before it is written. The page is the same without them.",
          control: { type: "toggle", key: "webQuote.stripTracking", defaultValue: true },
        },
      ],
    });

    items.push({
      type: "group",
      heading: "Reader",
      items: [
        {
          name: "Images in posts you read",
          desc: "For posts shown as text (see “Open posts as”). A post can carry images from its author's server, or from any server the author chose. Loading one tells that server that you read the post, and when. “Load on click” shows each image as a button and loads it only when you tap it; “Always load” draws images with the post. The list of posts never loads images, and frames and scripts in a post are never loaded.",
          aliases: ["reader", "images", "privacy", "tracking"],
          control: { type: "dropdown", key: "readerPane.images", options: { click: "Load on click", always: "Always load" } },
        },
        {
          name: "Open posts as",
          desc: "“Web page” shows the post as its author's blyg shows it on the web, inside Obsidian, without the blyg's menus and header (scripts are not run; the post, its stylesheet and its images load as a visit would; “Open in browser” shows the whole page). “Text” draws only the post's text here, and images follow the setting above. A blyg that does not allow its pages inside other apps is always shown as text.",
          aliases: ["reader", "web view", "page"],
          control: { type: "dropdown", key: "readerPane.view", options: { web: "Web page", text: "Text" } },
        },
      ],
    });

    items.push({
      type: "group",
      heading: "Safety",
      items: [
        {
          name: "Links to unpublished notes",
          desc: "Links to notes outside every publish folder (their title would appear on the site) and to notes that do not exist yet (dead text). Block refuses to publish, warn publishes with a heads-up.",
          control: {
            type: "dropdown",
            key: "safety.outsideLinks",
            options: { block: "Block", warn: "Warn", off: "Off" },
          },
        },
      ],
    });

    // Routes: one section per route, edited in place. (Sub-pages and the list's own delete affordance were tried in
    // 0.0.2: page titles went stale until the list was rebuilt, and there was no way to delete on a phone.)
    items.push({
      type: "group",
      heading: "Routes",
      items: [
        {
          name: "Which folders are published",
          desc:
            s.routes.length === 0
              ? "No routes yet: nothing can be published. Add one below."
              : studioOnly
                ? "Each route maps a vault folder to your Studio. A note outside every route is refused."
                : "Each route maps a vault folder to a place in the site repository. A note outside every route is refused.",
        },
      ],
    });
    s.routes.forEach((route, index) => items.push(this.routeGroup(route, index)));
    items.push({
      type: "group",
      items: [
        {
          name: "Add route",
          desc: "Adds an empty route at the end.",
          action: () => {
            s.routes.push({ vaultPrefix: "", mode: studioOnly ? "studio" : "blyg", label: "Blyg item" });
            this.changed();
            this.update();
          },
        },
      ],
    });

    // The legacy path (Blyg items committed to a GitHub-hosted site, plain files, the preview channel) stays in the code. The switch below
    // expands its settings in this same box; a setup that already uses GitHub starts with it on. (The folder Kind of each route is
    // shown or hidden with it, in the route's own box.)
    items.push({
      type: "group",
      heading: "Advanced",
      items: [
        {
          name: "Also publish to a GitHub-hosted site",
          desc: "For a site built from a GitHub repository (the older way to run a blyg). Switch on to show the GitHub settings below and the folder kinds that commit to a repository. Not needed for a Studio. Switching off only hides them; nothing is deleted.",
          aliases: ["github", "legacy", "repository", "preview"],
          searchable: false,
          render: (setting) => {
            setting.addToggle((t) =>
              t.setValue(this.githubOpen()).onChange((on) => {
                this.showGithub = on;
                this.update();
              }),
            );
          },
        },
        ...(this.githubOpen() ? this.githubItems(text) : []),
      ],
    });

    // The reader section arrives with the reader (R4).
    return items;
  }


  /** The GitHub-site settings, drawn under the switch in the Advanced box. */
  private githubItems(text: (name: string, desc: string, key: string, placeholder?: string) => SettingGroupItem): SettingGroupItem[] {
    const s = this.plugin.settings;
    return [
        text("GitHub owner", "The account or organisation that owns the site repository.", "github.owner"),
        text("GitHub repository", "The site repository the plugin commits to.", "github.repo"),
        text("Production branch", "Where published notes go live.", "github.branch"),
        text("Preview branch", "A test channel: nothing published there is permanent.", "github.previewBranch"),
        {
          name: "Publish to",
          desc: "The branch the publish commands write to. Preview is for testing.",
          control: {
            type: "dropdown",
            key: "github.useBranch",
            options: { production: "Production", preview: "Preview" },
          },
        },
        {
          name: "GitHub token",
          desc: "Pick or create an entry in the keychain. The token stays in this device's keychain; the plugin only remembers the entry's name.",
          aliases: ["secret", "keychain", "pat"],
          render: (setting) => {
            setting.addComponent((el) =>
              new SecretComponent(this.app, el).setValue(s.github.tokenSecretName).onChange((name) => {
                this.setControlValue("github.tokenSecretName", name);
              }),
            );
          },
        },
        {
          name: "Watch deploys",
          desc: "After a commit, wait for the site's checks and tell you whether it deployed. Needs “Actions: Read-only” on the token; harmless without it.",
          aliases: ["deploy", "status", "checks", "actions"],
          control: { type: "toggle", key: "github.watchDeploy", defaultValue: true },
        },
        this.checkConnectionItem("Tests the token, the repository and both branches. Changes nothing.", () => this.plugin.runConnectionCheck()),
        text("Blyg address", "The production blyg's address, ending with “/”.", "blyg.origin", "https://example.com/blyg/"),
        text("Preview blyg address", "The preview channel's address, ending with “/”.", "blyg.previewOrigin", "https://preview.example.pages.dev/blyg/"),
        text("Items folder", "Repository folder where Blyg items are written.", "blyg.itemsDir"),
    ];
  }

  /** A “Check connection” row: runs `run`, shows its lines under the button. */
  private checkConnectionItem(desc: string, run: () => Promise<{ lines: { level: string; text: string }[] }>, name = "Check connection"): SettingGroupItem {
    return {
      name,
      desc,
      aliases: ["test", "token", "permissions"],
      render: (setting) => {
        const resultEl = setting.infoEl.createDiv({ cls: "blyg-check-result" });
        setting.addButton((btn) =>
          btn.setButtonText(name).onClick(async () => {
            btn.setDisabled(true);
            resultEl.empty();
            resultEl.createDiv({ cls: "blyg-check-line", text: "Checking…" });
            try {
              const report = await run();
              resultEl.empty();
              for (const line of report.lines) {
                resultEl.createDiv({ cls: `blyg-check-line blyg-${line.level}`, text: line.text });
              }
            } finally {
              btn.setDisabled(false);
            }
          }),
        );
      },
    };
  }

  private routeGroup(route: Route, index: number): SettingDefinitionItem {
    const at = `routes.${index}`;
    const isPlain = (): boolean => route.mode === "plain";
    return {
      type: "group",
      heading: `Route ${index + 1}`,
      items: [
        {
          name: "Vault folder",
          desc: "Notes below this folder are published by this route. Ends with “/”.",
          control: { type: "text", key: `${at}.vaultPrefix`, placeholder: "blyg/" },
        },
        {
          name: "Label",
          desc: "Used in messages and commit titles.",
          control: { type: "text", key: `${at}.label` },
        },
        {
          name: "Kind",
          visible: () => !this.studioOnlyView(),
          desc: "Blyg (GitHub): items committed to your site repository. Blyg (Studio): items published through your Studio. Plain: files copied as they are (essays, pages).",
          control: { type: "dropdown", key: `${at}.mode`, options: { blyg: "Blyg (GitHub)", studio: "Blyg (Studio)", plain: "Plain" } },
        },
        {
          name: "Drafts only",
          desc: "Notes in this folder are sent to your Studio as drafts, and never published or withdrawn from here. A draft is visible only to you in the Studio. Good for trying things out: publish in the Studio, or move the note to a normal Studio folder.",
          visible: () => route.mode === "studio",
          control: { type: "toggle", key: `${at}.draftsOnly`, defaultValue: false },
        },
        {
          name: "Repository folder",
          desc: "Where plain files are copied to, ending with “/”.",
          visible: isPlain,
          control: { type: "text", key: `${at}.dest`, placeholder: "src/content/essays/" },
        },
        {
          name: "Web address",
          desc: "Where the site shows a file of this route; the panel's “Open on web” button uses it. Placeholders: {site} (from the Blyg address of the active target), {slug} (file name, lowercase, spaces to hyphens), {name} (file name), {path}. Empty: no button.",
          visible: isPlain,
          control: { type: "text", key: `${at}.webUrl`, placeholder: "{site}/essays/{slug}/" },
        },
        {
          name: "Require a title",
          desc: "Warn when a plain file has no title.",
          visible: isPlain,
          control: { type: "toggle", key: `${at}.requireTitle`, defaultValue: false },
        },
        {
          name: `Remove route ${index + 1}`,
          desc: "Tap to remove this route. Notes in its folder can then no longer be published.",
          action: () => {
            this.plugin.settings.routes.splice(index, 1);
            this.changed();
            this.update();
          },
        },
      ],
    };
  }

  override hide(): void {
    this.showGithub = null;
    void this.plugin.saveSettings();
  }

  private changed(): void {
    this.renderIssues();
    this.refreshDomState();
    this.save();
  }

  private renderIssues(): void {
    const setting = this.issuesSetting;
    if (!setting) return;
    const issues = validateSettings(this.plugin.settings);
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");
    setting.setName(errors.length > 0 ? "To fix before publishing" : warnings.length > 0 ? "Setup complete, with notes" : "Setup complete");
    const frag = createFragment();
    if (issues.length === 0) {
      frag.createDiv({ text: "Everything needed for publishing is filled in." });
    }
    for (const issue of errors) frag.createDiv({ cls: "blyg-issue", text: `${describeField(issue.field)}: ${issue.message}` });
    for (const issue of warnings) frag.createDiv({ cls: "blyg-note", text: `Note · ${describeField(issue.field)}: ${issue.message}` });
    setting.setDesc(frag);
  }
}
