import { importFolderChoices } from "../studio/import";
import { DEV_STUDIO_RULE, isDevStudioLock } from "../studio/devLock";
import {
  debounce,
  Notice,
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
import { FEATURES } from "../features/registry";
import type { Route } from "./schema";
import { isStudioOnly } from "./studioOnly";
import { CONNECT_STEPS } from "../app/panelState";
import { connectionCheckKey, setupProgress } from "./setup";
import { describeField, validateSettings } from "./validate";
import { askConsentGate } from "../digest/consentGate";

/**
 * The settings UI, declared with Obsidian 1.13's declarative settings API (so every field is searchable in
 * Obsidian's settings search). Values are read and written by dotted key into `plugin.settings`
 * (see getControlValue / setControlValue below).
 */
export class BlygSettingTab extends PluginSettingTab {
  private issuesSetting: Setting | null = null;
  /** The "Check connection" rows drawn now, and the last result of each check (kept in memory while Obsidian runs, shown again only for the settings it was made with). */
  private checks: Array<{ paint: () => void }> = [];
  /** The live post previews under the font and contrast settings; repainted whenever one of the reader's settings changes. */
  private previews: Array<() => void> = [];
  private readonly lastReports = new Map<string, { lines: { level: string; text: string }[]; at: Date }>();
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
    if (key.startsWith("features.")) return this.plugin.features.enabled(key.slice("features.".length));
    return getPath(this.plugin.settings, key);
  }

  override setControlValue(key: string, value: unknown): void {
    const clean = typeof value === "string" ? value.trim() : value;
    // Switching the AI layer on needs the person's consent first (asked once per provider host): the setting turns on only after Agree.
    if (key === "digest.useAi" && clean === true) {
      void askConsentGate().then((agreed) => {
        if (agreed) {
          setPath(this.plugin.settings, key, true);
          this.changed();
        }
        this.update();
      });
      return;
    }
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
    if (key.startsWith("features.")) new Notice("Reload Obsidian for this to take effect. Nothing the feature saved is deleted.", 8000);
    if (key.startsWith("readerPane.")) for (const paint of this.previews) paint();
  }

  /** A setting row that is only a folded help: a native details element (keyboard and screen reader friendly), closed at first. */
  private helpItem(name: string, summary: string, lines: string[]): SettingGroupItem {
    return {
      name,
      desc: "",
      aliases: ["help", "placeholders", "variables"],
      render: (setting) => {
        const box = setting.infoEl.createEl("details", { cls: "blyg-help" });
        box.createEl("summary", { text: summary });
        for (const line of lines) box.createDiv({ cls: "blyg-note", text: line });
      },
    };
  }

  /** "Preview" under the font and contrast settings: a few lines drawn with the very classes the reader uses, so the choice can be judged without opening the reader. */
  private fontPreviewItem(): SettingGroupItem {
    return {
      name: "Preview",
      desc: "How a reader item looks with the font and the contrast above. This only changes how the reader shows what you read; it does not change how your own blyg looks.",
      aliases: ["reader", "font", "contrast", "sample"],
      render: (setting) => {
        const box = setting.infoEl.createDiv({ cls: "blyg-font-preview" });
        const paint = (): void => {
          box.empty();
          const font = this.plugin.settings.readerPane.font;
          const contrast = this.plugin.settings.readerPane.contrast;
          const root = box.createDiv({ cls: `blyg-reader is-font-${font} is-contrast-${contrast}` });
          const body = root.createDiv({ cls: "blyg-reader-surface" }).createDiv({ cls: "blyg-reader-body" });
          body.createEl("p", { text: "A reader item is shown here: the quick brown fox jumps over the lazy dog, 0123456789." });
          const quote = body.createEl("blockquote", { cls: "blyg-transclusion" });
          quote.createEl("p", { text: "A quote of another blyg's item looks like this." });
        };
        this.previews.push(paint);
        paint();
      },
    };
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
    this.checks = [];
    this.previews = [];
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
        desc: `This build connects only to test Studios (${DEV_STUDIO_RULE}). Any other Studio address is refused, so it can never publish to your real Studio, unless you allow it below.`,
        searchable: false,
      });
      items.push({
        name: "Allow a live Studio",
        desc: "Lets this development build use any Studio address, your real Studio included. What it publishes there is public for good (a withdrawal leaves a notice; readers may have copies). A folder whose route is set to “Drafts only” never publishes. Off by default.",
        aliases: ["dev", "live", "test studio"],
        control: { type: "toggle", key: "dev.allowLiveStudio", defaultValue: false },
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
        text("Studio mount (optional)", "For a Studio under a path, enter that path, e.g. /blyg. Leave empty when the Studio has its own host. Public pages are then {host}{mount}/f/{id}/.", "studio.mount", "/blyg"),
        {
          name: "Studio token",
          desc: "A REST token from the Studio (More → Client access) with every permission ticked: owner:read, owner:draft and owner:publish are needed to publish; owner:manage (hoppers, dismissing mentions, asking the Studio to fetch) and reading:state (read marks in the reader) are for the rest. It expires after 30 days. Pick or create an entry in the keychain; the plugin remembers only the entry's name.",
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
          name: "Fragment character limit",
          desc: `Longer fragments are refused before anything is sent. At most ${CONTRACT_MAX_FRAGMENT_CAP}: the site rejects longer ones.`,
          control: { type: "number", key: "blyg.fragmentCharCap", min: 1, max: CONTRACT_MAX_FRAGMENT_CAP, step: 1 },
        },
        {
          name: "Warn for threads longer than",
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
          "A note in your vault that new fragments start from, e.g. “Templates/Fragment.md”. Empty: a bare note.",
          "templates.fragment",
          "Templates/Fragment.md",
        ),
        text(
          "Thread template",
          "The same for new threads. The thread property is added for you.",
          "templates.thread",
          "Templates/Thread.md",
        ),
        this.helpItem("Template placeholders and rules", "Show the placeholders", [
          "Placeholders: {{title}}, {{date}}, {{time}} and {{date:FORMAT}}.",
          "A template applies to New fragment, New thread, Reply to item… and to text moved out of another note.",
          "The template must not set the other kind or any other blyg_ property.",
        ]),
      ],
    });

    const experimental = FEATURES.filter((f) => f.stage === "experimental");
    items.push({
      type: "group",
      heading: "Experimental features",
      items: [
        { name: "Early features", desc: "These are still being built and may change, be slow or misbehave. Each is off in the released plugin until it has been tried. Switching one off hides it completely and keeps what it saved. Reload Obsidian after a change." },
        ...experimental.map((f): SettingGroupItem => ({ name: f.title, desc: f.description, control: { type: "toggle", key: `features.${f.id}`, defaultValue: false } })),
      ],
    });

    if (this.plugin.features.enabled("digest-ai")) items.push({
      type: "group",
      heading: "Daily digest",
      items: [
        {
          name: "Use an AI model",
          desc: "Off by default. Turning it on asks once for your agreement: the text of posts from blygs you follow is then sent to the provider below to write the digest. A manual “Write the digest” shows one line (groups, posts, tokens, a rough cost) and waits for Send. Afterwards, “Show what the digest sent” lists every run. Without it the Daily is the same list, made on your device.",
          aliases: ["ai", "llm", "claude", "anthropic", "summary"],
          control: { type: "toggle", key: "digest.useAi", defaultValue: false },
        },
        text("AI endpoint", "The provider's address. Default: the Anthropic API. Only https addresses are used.", "digest.endpoint", "https://api.anthropic.com"),
        text("AI model", "The model that writes the digest, e.g. claude-sonnet-5-5 (others: claude-haiku-5-5 cheaper, claude-opus-5-5, claude-fable-5-2).", "digest.model", "claude-sonnet-5-5"),
        {
          name: "Daily token ceiling",
          desc: "The most tokens the digest may use in one day by itself (an automatic run will check this; the “Write the digest” button is never blocked by it, but its tokens count). Default 60000, about two or three full runs. 0 means no ceiling. Token counts are rough.",
          aliases: ["limit", "budget", "tokens", "cost"],
          render: (setting) => {
            setting.addText((t) => t.setValue(String(s.digest.dailyTokenCeiling)).onChange((v) => {
              const k = Number(v.trim());
              if (v.trim() !== "" && Number.isFinite(k) && k >= 0) this.setControlValue("digest.dailyTokenCeiling", Math.round(k));
            }));
          },
        },
        {
          name: "AI key",
          desc: "Your API key for the provider. Pick or create an entry in the keychain; the plugin remembers only the entry's name.",
          aliases: ["secret", "keychain", "api"],
          render: (setting) => {
            setting.addComponent((el) =>
              new SecretComponent(this.app, el).setValue(s.digest.keySecretName).onChange((name) => {
                this.setControlValue("digest.keySecretName", name);
              }),
            );
          },
        },
      ],
    });

    items.push({
      type: "group",
      heading: "Web quote",
      items: [
        {
          name: "Web quote Markdown",
          desc: "What “Insert web quote” writes, as a template for the whole block. It has nothing to do with blyg items.",
          aliases: ["quote", "attribution", "source", "substack", "template"],
          control: { type: "textarea", key: "webQuote.format", placeholder: "> {quote}\n> *{link}*", rows: 3 },
        },
        this.helpItem("Web quote placeholders", "Show the placeholders", [
          "{quote} is the quote, {link} the whole link, {alias} its visible text, {url} the address.",
          "Each line stands as you type it, so a blank line appears only where you leave one.",
          "Default: “> {quote}” on one line and “> *{link}*” on the next (a quote with an italic source as its last line). The quote's own lines follow the marks in front of {quote}.",
        ]),
        {
          name: "Remove tracking parameters from pasted links",
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
          name: "Images in the reader",
          desc: "An item you read can carry images from its author's server, or from any server the author chose. Loading one tells that server that you read the post, and when. “Load on click” shows each image as a button and loads it only when you tap it; “Always load” draws images with the post. The list of posts never loads images, and frames and scripts in a post are never loaded.",
          aliases: ["reader", "images", "privacy", "tracking"],
          control: { type: "dropdown", key: "readerPane.images", options: { click: "Load on tap", always: "Always load" } },
        },
        {
          name: "Font in the reader",
          desc: "The font of the items you read in the reader's text view (not of the buttons and lists, and not how your own blyg looks). “As Obsidian has it” leaves the text view in Obsidian's. The others are fonts your device already has; none is downloaded.",
          aliases: ["reader", "typeface", "serif", "reading font"],
          control: { type: "dropdown", key: "readerPane.font", options: { default: "As Obsidian has it", serif: "Serif", sans: "Sans-serif", mono: "Monospace" } },
        },
        ...(this.plugin.features.enabled("share-open") ? [{
          name: "Share inbox folder",
          desc: "Leave empty to switch this off. Set a folder, and make the iOS share sheet's Obsidian Location create new notes in it as “URL only” (or with {{url}} in its template). When a new note appears there that names a blyg post, the reader opens that post. Notes already there, and notes you edit later, are never looked at, and no note is changed or deleted. Replying and following stay in the reader.",
          aliases: ["share", "share sheet", "inbox", "ios", "address"],
          control: { type: "text", key: "readerPane.shareInbox", placeholder: "Share inbox" },
        } as SettingGroupItem] : []),
        {
          name: "Contrast of the reading surface",
          desc: "How strongly a post stands out from its background in the reader: reduced (softer, for dim rooms), normal, or high.",
          aliases: ["reader", "contrast", "reading surface", "dark", "light"],
          control: { type: "dropdown", key: "readerPane.contrast", options: { reduced: "Reduced", normal: "Normal", high: "High" } },
        },
        this.fontPreviewItem(),
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
          name: "Publish folders",
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
          name: "Add publish folder",
          desc: "Adds an empty route at the end.",
          action: () => {
            s.routes.push({ vaultPrefix: "", mode: studioOnly ? "studio" : "blyg", label: "Blyg item" });
            this.changed();
            this.update();
          },
        },
      ],
    });

    // GitHub-hosted site, in two boxes (plain publishing and the legacy GitHub-Blyg settings used to overlap in one "Advanced" box).
    // "Website (GitHub)" is what Plain routes (essays, pages, tools) need: the repository, branch and token. "Advanced" keeps only what the
    // legacy Blyg-over-GitHub path needs (preview channel, Blyg address, items folder). The switch hides both while the setup is Studio-only;
    // a setup that already uses GitHub starts with it on. (The folder Kind of each route is shown or hidden with it, in the route's own box.)
    items.push({
      type: "group",
      heading: "Website (GitHub)",
      items: [
        {
          name: "Publish to a GitHub-hosted site",
          desc: "For essays, pages and other plain files copied into a site repository (and the older Blyg-on-GitHub way). Switch on to show the repository, branch and token. Not needed if you publish only through a Studio. Switching off only hides the settings; nothing is deleted.",
          aliases: ["github", "legacy", "repository", "plain", "essays", "website"],
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
        ...(this.githubOpen() ? this.websiteItems(text) : []),
      ],
    });
    if (this.githubOpen()) {
      items.push({
        type: "group",
        heading: "Advanced",
        items: [
          {
            name: "Blyg items on a GitHub site (older way)",
            desc: "Only for Blyg items committed to the site repository, the preview channel and the address “Open on web” uses. Essays and pages do not need any of this.",
            searchable: false,
          },
          ...this.legacyBlygItems(text),
        ],
      });
    }

    // The reader section arrives with the reader (R4).
    return items;
  }


  /** What a Plain route (essays, pages, tools) needs: the repository, the production branch and the token. */
  private websiteItems(text: (name: string, desc: string, key: string, placeholder?: string) => SettingGroupItem): SettingGroupItem[] {
    const s = this.plugin.settings;
    return [
      text("GitHub owner", "The account or organisation that owns the site repository: just the name, e.g. “octocat” for github.com/octocat/your-site-repo. No address, no slash.", "github.owner", "octocat"),
      text("GitHub repository", "The name of the site repository the plugin commits to, without the owner: e.g. “your-site-repo” for github.com/octocat/your-site-repo. No slash, no “.git”.", "github.repo", "your-site-repo"),
      text("Production branch", "Where published notes go live.", "github.branch"),
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
    ];
  }

  /** The legacy Blyg-over-GitHub settings (preview channel, Blyg address, items folder), drawn in the Advanced box. */
  private legacyBlygItems(text: (name: string, desc: string, key: string, placeholder?: string) => SettingGroupItem): SettingGroupItem[] {
    return [
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
      text("Blyg address", "The production blyg's address, ending with “/”. Also the site that {site} stands for in a route's web address.", "blyg.origin", "https://example.com/blyg/"),
      text("Preview blyg address", "The preview channel's address, ending with “/”.", "blyg.previewOrigin", "https://preview.example.pages.dev/blyg/"),
      text("Items folder", "Repository folder where Blyg items are written.", "blyg.itemsDir"),
    ];
  }

  /**
   * A “Check connection” row: runs `run`, shows its lines under the button and keeps them. The result belongs to the settings it was made with (the
   * Studio's address, mount and keychain entry, or the GitHub ones): change one and the old result is taken away instead of standing for something else.
   */
  private checkConnectionItem(desc: string, run: () => Promise<{ lines: { level: string; text: string }[] }>, name = "Check connection"): SettingGroupItem {
    return {
      name,
      desc,
      aliases: ["test", "token", "permissions"],
      render: (setting) => {
        const resultEl = setting.infoEl.createDiv({ cls: "blyg-check-result" });
        const key = (): string => connectionCheckKey(this.plugin.settings, name);
        const paint = (): void => {
          resultEl.empty();
          const last = this.lastReports.get(key());
          if (!last) return;
          for (const line of last.lines) resultEl.createDiv({ cls: `blyg-check-line blyg-${line.level}`, text: line.text });
          resultEl.createDiv({ cls: "blyg-note", text: `Checked at ${last.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` });
        };
        this.checks.push({ paint });
        paint();
        setting.addButton((btn) =>
          btn.setButtonText(name).onClick(async () => {
            btn.setDisabled(true);
            const asked = key();
            resultEl.empty();
            resultEl.createDiv({ cls: "blyg-check-line", text: "Checking…" });
            try {
              const report = await run();
              this.lastReports.set(asked, { lines: report.lines, at: new Date() });
              paint();
              // The result stays under the button; the toast only says that the check ran.
              new Notice(report.lines.some((l) => l.level === "error") ? "Connection checked: something needs attention. See below the button." : "Connection checked.", 4000);
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
    for (const c of this.checks) c.paint();
    this.refreshDomState();
    this.save();
  }

  private renderIssues(): void {
    const setting = this.issuesSetting;
    if (!setting) return;
    const issues = validateSettings(this.plugin.settings);
    // Nothing connected yet: say the four steps in order (the panel says the same), instead of a list of empty fields. Step 1 shows a tick once the address is entered.
    const { connecting, done, errors } = setupProgress(issues);
    const warnings = issues.filter((i) => i.severity === "warning");
    setting.setName(connecting ? "Connect your Studio" : errors.length > 0 ? "To fix before publishing" : warnings.length > 0 ? "Setup complete, with notes" : "Setup complete");
    const frag = createFragment();
    if (connecting) {
      const steps = frag.createEl("ol", { cls: "blyg-steps" });
      CONNECT_STEPS.slice(0, 4).forEach((text, i) => steps.createEl("li", { text: `${done[i] ? "✓ " : ""}${text.replace(/^\d\. /, "")}` }));
      frag.createDiv({ cls: "blyg-note", text: CONNECT_STEPS[4] ?? "" });
    } else if (issues.length === 0) {
      frag.createDiv({ text: "Everything needed for publishing is filled in." });
    }
    for (const issue of errors) frag.createDiv({ cls: "blyg-issue", text: `${describeField(issue.field)}: ${issue.message}` });
    for (const issue of warnings) frag.createDiv({ cls: "blyg-note", text: `Note · ${describeField(issue.field)}: ${issue.message}` });
    setting.setDesc(frag);
  }
}
