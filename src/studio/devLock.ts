// The development build ("blyg-dev", the manifest id ends in "-dev") may only talk to TEST Studios (decision of Florian, 2026-11-06).
//
// Why: a published id is permanent. A dev build that was handed the address of the live Studio (typed, or arriving through a synced
// data.json) could publish test items there for good. The live Studio keeps `workers_dev` off, so it never answers on a workers.dev
// address; the throwaway test Studio is on one (blyg-studio's invariants). So the rule is generic, with no personal value in the code:
// a dev build accepts an address on `*.workers.dev`, or the local machine (the Studio the CI starts), and refuses everything else.
//
// How: the flavours share ONE main.js (only the manifest differs, scripts/flavour.mjs), so the lock cannot be baked in at build time;
// the plugin switches it on at load from its own manifest id. It acts where every Studio address is checked (`studioBaseProblem`), so
// settings validation, "Check connection" and every Studio call refuse before any network request.
//
// The state is module-level on purpose: the flavour is a property of the whole running plugin (twelve places derive the address from
// the settings), and each installed plugin runs its own bundle, so "blyg" and "blyg-dev" in one vault never share it.

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What the dev build accepts, in words (shown in the settings and in the refusal). */
export const DEV_STUDIO_RULE = "an address ending in .workers.dev, or localhost";

let locked = false;

/** True for the development flavour: a manifest id like "blyg-dev". */
export function isDevBuildId(id: string): boolean {
  return id.endsWith("-dev");
}

/** Switched on once at load by the plugin (and by tests); off means every address passes this check. */
export function setDevStudioLock(on: boolean): void {
  locked = on;
}

export function isDevStudioLock(): boolean {
  return locked;
}

/** A test Studio's host: `something.workers.dev` (a bare `workers.dev` is not one), or the local machine. */
export function isTestStudioHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return LOOPBACK_HOSTS.has(h) || (h.endsWith(".workers.dev") && h.length > ".workers.dev".length);
}

/** Why a dev build refuses this address, or null (the lock is off, the address is a test Studio's, or it is not an address at all: the other checks say that). */
export function devStudioProblem(baseUrl: string): string | null {
  if (!locked) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (isTestStudioHost(url.hostname)) return null;
  return `This development build only connects to test Studios (${DEV_STUDIO_RULE}); it will not use ${url.hostname}.`;
}

/** The id of the real plugin a development build belongs to: "blyg-dev" → "blyg". */
export function realPluginId(devId: string): string {
  return devId.replace(/-dev$/, "");
}

/**
 * Why a development build must stay idle, or null. The two flavours register the same panel view, so they cannot both run in one vault (Obsidian
 * refuses the second registration, and what then happens half-way is not worth finding out); Florian switches one off and the other on for a
 * device test (2026-11-06). The dev build therefore does nothing at all while the real plugin is enabled, and says so; the real plugin is never touched.
 */
export function devGuardProblem(pluginId: string, realPluginEnabled: boolean): string | null {
  if (!isDevBuildId(pluginId) || !realPluginEnabled) return null;
  return "Blyg (dev) is idle: the real Blyg plugin is enabled, and only one of them can run at a time. Turn the real Blyg off (Settings → Community plugins), then reload Obsidian. Nothing was changed.";
}
