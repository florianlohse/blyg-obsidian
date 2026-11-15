// A device-local copy of the settings, so a settings file that is missing or replaced (a plugin folder reinstalled or overwritten by an update tool,
// a "discard changes and pull" in a synced vault) does not send the plugin back to its defaults: the token entry names, the Studio address and the routes
// are restored from this device's copy, once, with a notice. The copy lives in the app's per-vault local storage (not in the plugin folder, not synced),
// and holds only settings: tokens stay in the keychain, which holds them by name.
import { isRecord } from "../core/frontmatter";

/** True when what was read from the settings file carries no settings at all (missing, empty, or only other data): only then is the copy used. */
export function isEmptySettingsData(raw: unknown): boolean {
  if (!isRecord(raw)) return true;
  return !("studio" in raw) && !("routes" in raw) && !("github" in raw) && !("blyg" in raw) && !("readerPane" in raw) && typeof raw.schemaVersion !== "number";
}

/** The copy as stored (a JSON text), or null when it is not one we can use. */
export function readMirror(stored: unknown): unknown {
  if (typeof stored !== "string" || stored === "") return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isRecord(parsed) && typeof parsed.schemaVersion === "number" ? parsed : null;
  } catch {
    return null;
  }
}
