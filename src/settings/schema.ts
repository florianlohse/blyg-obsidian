// Settings schema (docs/ARCHITECTURE.md §2). Everything setup-specific is a setting; the defaults are generic
// placeholders, never the owner's values (CLAUDE.md §3).
import { DEFAULT_WEB_QUOTE } from "../core/webQuote";

// 2 (0.3.0): route mode "studio" and the `studio` block. Raised on purpose: a device still on an older plugin reads the settings as
// "from a newer version" and stays read-only, instead of mistaking a studio route for a GitHub one and saving that over it.
// 3 (0.4.0): `Route.draftsOnly`. Raised for the same reason: a device on an older plugin would ignore the switch and publish from a drafts-only
// folder, so it reads these settings as "from a newer version" and stays read-only.
export const SCHEMA_VERSION = 3;

/**
 * blyg — Blyg items committed to the site repository (today's path); plain — files copied as they are (essays, pages);
 * studio — Blyg items published through a Blygger Studio's owner API (docs/architecture/ADR-002-studio-backend.md).
 */
export type RouteMode = "blyg" | "plain" | "studio";

export interface Route {
  /** Vault-relative folder prefix, ends with "/". */
  vaultPrefix: string;
  mode: RouteMode;
  /** Plain routes only: repo directory the files are copied into, ends with "/". */
  dest?: string;
  label: string;
  /** Plain routes only. */
  requireTitle?: boolean;
  /**
   * Studio routes only: notes here are sent to the Studio as drafts and never published or withdrawn from this folder (docs/plans/S12-studio-per-route.md).
   * A draft is private to the owner; absent means off.
   */
  draftsOnly?: boolean;
  /**
   * Plain routes only: where the site shows a file of this route, as a template (see core/webAddress.ts). Empty or absent: no
   * "Open on web" button for this route.
   */
  webUrl?: string;
}

export interface BlygSettings {
  schemaVersion: number;
  github: {
    owner: string;
    repo: string;
    /** Production branch. */
    branch: string;
    /** Test channel branch. */
    previewBranch: string;
    /** Which of the two publishing targets right now. */
    useBranch: "production" | "preview";
    /** NAME of the keychain entry. Never the token itself. */
    tokenSecretName: string;
    /** After a commit, wait for the site's checks and report whether it deployed (needs “Actions: read” on the token). */
    watchDeploy: boolean;
  };
  blyg: {
    /** Identity of the production blyg, e.g. "https://example.com/blyg/". */
    origin: string;
    previewOrigin: string;
    itemsDir: string;
    fragmentCharCap: number;
    threadSoftCap: number;
    author?: { name: string; url?: string };
  };
  /** The Studio that routes of mode "studio" publish to. Any Studio: address and token are settings. */
  studio: {
    /** The Studio's host, e.g. "https://blyg.example.com". The owner API is always {host}/api. */
    baseUrl: string;
    /** "" when the Studio has its own host, or "/blyg" when it is mounted below a path; public pages are {host}{mount}/f/{id}/. */
    mount: string;
    /** NAME of the keychain entry holding the Studio's bearer token. Never the token itself. */
    tokenSecretName: string;
    /**
     * Where "Import from the Studio" puts new notes (roadmap S7): the folder of a Studio route, or "" for the first Studio route that is not
     * Drafts-only. Optional in data.json (added in 0.5.0 without a schema change: an older plugin ignores it).
     */
    importFolder: string;
  };
  routes: Route[];
  attachments: { repoDir: string };
  safety: {
    /** Wikilinks to vault notes that no route publishes: their titles would appear on the site. */
    outsideLinks: "block" | "warn" | "off";
  };
  reader: {
    cacheDir: string;
    sourcesStore: "vault" | "repo";
    sourcesVaultPath: string;
    sourcesRepoPath: string;
    pollMinutes: number;
    userAgent: string;
  };
  /** Vault paths of the template notes a new fragment / thread starts from. Empty: a bare new note. */
  templates: { fragment: string; thread: string };
  respond: { draftsPrefix: string };
  mentions: { repoPath: string };
  /**
   * "Insert web quote" (roadmap S20): a plain Markdown quote with an attribution link, nothing to do with blyg items. Optional in data.json (added without a
   * schema change, like `studio.importFolder`: an older plugin ignores it and drops it the next time it saves).
   */
  webQuote: {
    /** The whole block: one or more lines, placeholders {quote} (once), {link}, {alias}, {url}. */
    format: string;
    stripTracking: boolean;
  };
  /**
   * The reader pane (roadmap S15, proof of concept). Optional in data.json like `webQuote`. `images`: a post you read can carry images from the author's
   * own server or from any server the author chose, and loading one tells that server you read the post. `click` (the default): each image is a
   * button and loads when tapped; `always`: images load as the post is drawn.
   */
  readerPane: {
    images: "click" | "always";
    /** How a post opens: `web` shows the author's own page inside Obsidian (sandboxed, no scripts; it loads like a visit to that page), `text` draws the
     *  post's text in Obsidian (images follow `images`). A page that refuses to be shown inside another app falls back to `text`. */
    view: "web" | "text";
  };
}

/** `dev` is the development build (manifest id ends in -dev): a fresh install starts with the test route `Studio test/`, so it never claims the real plugin's default folder `blyg/`. */
export function defaultSettings(flavour: "release" | "dev" = "release"): BlygSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    github: {
      owner: "",
      repo: "",
      branch: "main",
      previewBranch: "preview",
      useBranch: "production",
      tokenSecretName: "",
      watchDeploy: true,
    },
    blyg: {
      origin: "",
      previewOrigin: "",
      itemsDir: "src/content/notes",
      fragmentCharCap: 1000,
      threadSoftCap: 50000,
    },
    studio: { baseUrl: "", mount: "", tokenSecretName: "", importFolder: flavour === "dev" ? "Studio test/" : "" },
    // A new install publishes to a Studio (the GitHub-site path is for existing setups; settings/studioOnly.ts). Existing settings keep their routes.
    routes: flavour === "dev" ? [{ vaultPrefix: "Studio test/", mode: "studio", label: "Test item" }] : [{ vaultPrefix: "blyg/", mode: "studio", label: "Blyg item" }],
    attachments: { repoDir: "public/attachments" },
    safety: { outsideLinks: "block" },
    reader: {
      cacheDir: "{plugin dir}/cache/",
      sourcesStore: "repo",
      sourcesVaultPath: "Blyg Reader/sources.json",
      sourcesRepoPath: "data/blyg-sources.json",
      pollMinutes: 60,
      userAgent: "blyg/{version}",
    },
    templates: { fragment: "", thread: "" },
    respond: { draftsPrefix: "blyg/" },
    mentions: { repoPath: "data/mentions.json" },
    webQuote: { ...DEFAULT_WEB_QUOTE },
    readerPane: { images: "click", view: "web" },
  };
}
