// The plugin's id changed from "obsidian-blyg" to "blyg" (Obsidian's directory rules do not allow "obsidian" in an id). Obsidian keeps a
// plugin's data.json in the folder named after its id, so the renamed plugin starts with no data.json of its own. This takes over the old
// install's file once: the settings, the published records, the pending drafts. The old folder is only read, never changed or deleted, so
// undoing the rename loses nothing. Keychain entries are found by name and need no move.
export const OLD_PLUGIN_ID = "obsidian-blyg";
/** Only the release id takes over: a development build ("blyg-dev") lives in a test vault and must never inherit the live settings (M1 plan §3.1). */
export const ADOPTING_PLUGIN_ID = "blyg";

export interface AdoptPorts {
  /** This plugin's own data.json: null when there is none yet. */
  loadOwn(): Promise<unknown>;
  saveOwn(data: Record<string, unknown>): Promise<void>;
  /** The old install's data.json as text, or null when the folder or file does not exist or cannot be read. */
  readOld(): Promise<string | null>;
  /** Is the old plugin ENABLED in this vault right now? Both register the same view type, so they must not run side by side. */
  oldPluginEnabled(): boolean;
  ownId: string;
}

/** Whether Obsidian's plugin manager lists `id` as enabled. The manager is not in the public typings, so it is read defensively; anything unexpected reads as "not enabled". */
export function isPluginEnabled(app: unknown, id: string): boolean {
  const plugins = typeof app === "object" && app !== null ? (app as { plugins?: unknown }).plugins : undefined;
  const enabled = typeof plugins === "object" && plugins !== null ? (plugins as { enabledPlugins?: unknown }).enabledPlugins : undefined;
  return enabled instanceof Set && enabled.has(id);
}

export type AdoptResult = "not-needed" | "adopted" | "nothing-to-adopt" | "unreadable" | "old-plugin-enabled" | "write-failed";

export async function adoptOldInstall(ports: AdoptPorts): Promise<AdoptResult> {
  if (ports.ownId !== ADOPTING_PLUGIN_ID) return "not-needed";
  // Checked first: with the old plugin running, the caller stops loading altogether (a second registration of the view type is refused), so nothing is taken over yet.
  if (ports.oldPluginEnabled()) return "old-plugin-enabled";
  const own = await ports.loadOwn();
  if (typeof own === "object" && own !== null && Object.keys(own).length > 0) return "not-needed";
  let text: string | null;
  try {
    text = await ports.readOld();
  } catch {
    return "unreadable";
  }
  if (text === null) return "nothing-to-adopt";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unreadable";
  try {
    await ports.saveOwn(parsed as Record<string, unknown>);
  } catch {
    return "write-failed";
  }
  return "adopted";
}
