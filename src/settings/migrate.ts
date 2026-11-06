import { defaultSettings, SCHEMA_VERSION, type BlygSettings, type Route } from "./schema";

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const posInt = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

function readRoute(raw: unknown): Route | null {
  if (!isPlain(raw)) return null;
  const mode = oneOf(raw.mode, ["blyg", "plain", "studio"] as const, "blyg");
  const route: Route = {
    vaultPrefix: str(raw.vaultPrefix, ""),
    mode,
    label: str(raw.label, mode === "plain" ? "Page" : mode === "studio" ? "Blyg item" : "Blyg note"),
  };
  if (typeof raw.dest === "string") route.dest = raw.dest;
  if (typeof raw.requireTitle === "boolean") route.requireTitle = raw.requireTitle;
  if (typeof raw.webUrl === "string") route.webUrl = raw.webUrl;
  if (mode === "studio" && raw.draftsOnly === true) route.draftsOnly = true;
  return route;
}

export interface LoadedSettings {
  settings: BlygSettings;
  /**
   * The stored data was written by a newer plugin version (e.g. another device already updated). We read what we
   * understand, but the caller must not save over it.
   */
  fromNewerVersion: boolean;
}

/**
 * Turn whatever `loadData()` returned into a complete, well-typed settings object. Missing or malformed fields fall
 * back to the generic defaults. Never throws.
 */
export function migrateSettings(raw: unknown, flavour: "release" | "dev" = "release"): LoadedSettings {
  const d = defaultSettings(flavour);
  if (!isPlain(raw)) return { settings: d, fromNewerVersion: false };

  const fromNewerVersion = typeof raw.schemaVersion === "number" && raw.schemaVersion > SCHEMA_VERSION;

  const gh = isPlain(raw.github) ? raw.github : {};
  const bl = isPlain(raw.blyg) ? raw.blyg : {};
  const rd = isPlain(raw.reader) ? raw.reader : {};
  const at = isPlain(raw.attachments) ? raw.attachments : {};
  const sf = isPlain(raw.safety) ? raw.safety : {};
  const tp = isPlain(raw.templates) ? raw.templates : {};
  const st = isPlain(raw.studio) ? raw.studio : {};
  const rs = isPlain(raw.respond) ? raw.respond : {};
  const mn = isPlain(raw.mentions) ? raw.mentions : {};

  const settings: BlygSettings = {
    schemaVersion: SCHEMA_VERSION,
    github: {
      owner: str(gh.owner, d.github.owner),
      repo: str(gh.repo, d.github.repo),
      branch: str(gh.branch, d.github.branch),
      previewBranch: str(gh.previewBranch, d.github.previewBranch),
      useBranch: oneOf(gh.useBranch, ["production", "preview"] as const, d.github.useBranch),
      tokenSecretName: str(gh.tokenSecretName, d.github.tokenSecretName),
      watchDeploy: typeof gh.watchDeploy === "boolean" ? gh.watchDeploy : d.github.watchDeploy,
    },
    blyg: {
      origin: str(bl.origin, d.blyg.origin),
      previewOrigin: str(bl.previewOrigin, d.blyg.previewOrigin),
      itemsDir: str(bl.itemsDir, d.blyg.itemsDir),
      fragmentCharCap: posInt(bl.fragmentCharCap, d.blyg.fragmentCharCap),
      threadSoftCap: posInt(bl.threadSoftCap, d.blyg.threadSoftCap),
    },
    studio: {
      baseUrl: str(st.baseUrl, d.studio.baseUrl),
      mount: str(st.mount, d.studio.mount),
      tokenSecretName: str(st.tokenSecretName, d.studio.tokenSecretName),
      importFolder: str(st.importFolder, d.studio.importFolder),
    },
    routes: Array.isArray(raw.routes)
      ? raw.routes.map(readRoute).filter((r): r is Route => r !== null)
      : d.routes,
    attachments: { repoDir: str(at.repoDir, d.attachments.repoDir) },
    safety: { outsideLinks: oneOf(sf.outsideLinks, ["block", "warn", "off"] as const, d.safety.outsideLinks) },
    reader: {
      cacheDir: str(rd.cacheDir, d.reader.cacheDir),
      sourcesStore: oneOf(rd.sourcesStore, ["vault", "repo"] as const, d.reader.sourcesStore),
      sourcesVaultPath: str(rd.sourcesVaultPath, d.reader.sourcesVaultPath),
      sourcesRepoPath: str(rd.sourcesRepoPath, d.reader.sourcesRepoPath),
      pollMinutes: posInt(rd.pollMinutes, d.reader.pollMinutes),
      userAgent: str(rd.userAgent, d.reader.userAgent),
    },
    templates: { fragment: str(tp.fragment, d.templates.fragment), thread: str(tp.thread, d.templates.thread) },
    respond: { draftsPrefix: str(rs.draftsPrefix, d.respond.draftsPrefix) },
    mentions: { repoPath: str(mn.repoPath, d.mentions.repoPath) },
  };

  if (isPlain(bl.author) && typeof bl.author.name === "string") {
    settings.blyg.author = { name: bl.author.name };
    if (typeof bl.author.url === "string") settings.blyg.author.url = bl.author.url;
  }

  return { settings, fromNewerVersion };
}
