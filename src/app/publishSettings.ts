// From the user's settings to what the publish services need, and the checks that must pass before any publish.
import type { PublishSettings, Channel } from "../publish/types";
import type { BlygSettings } from "../settings/schema";
import { describeField, validateSettings } from "../settings/validate";

export function activeChannel(s: BlygSettings): Channel {
  return s.github.useBranch === "preview" ? "preview" : "production";
}

export function activeBranch(s: BlygSettings): string {
  return activeChannel(s) === "preview" ? s.github.previewBranch : s.github.branch;
}

export function toPublishSettings(s: BlygSettings): PublishSettings {
  return {
    channel: activeChannel(s),
    branch: activeBranch(s),
    outsideLinks: s.safety.outsideLinks,
    itemsDir: s.blyg.itemsDir,
    origin: activeChannel(s) === "preview" ? s.blyg.previewOrigin : s.blyg.origin,
    fragmentCharCap: s.blyg.fragmentCharCap,
    threadSoftCap: s.blyg.threadSoftCap,
    attachmentsDir: s.attachments.repoDir,
    routes: s.routes,
    // The whitespace-only no-op rule (decided in R2): three taps after adding a trailing space made three deploys.
    ignoreTrailingWhitespace: true,
  };
}

/** A message when the settings are not usable for publishing (every error counts), or null. */
export function preflight(s: BlygSettings): string | null {
  const errors = validateSettings(s).filter((i) => i.severity === "error");
  if (errors.length === 0) return null;
  const shown = errors.slice(0, 3).map((i) => `${describeField(i.field)}: ${i.message}`);
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : "";
  return `The plugin settings need attention before publishing — ${shown.join(" · ")}${more}. Open Settings → Blyg.`;
}

export function describeTarget(s: BlygSettings): string {
  return activeChannel(s) === "preview"
    ? `Preview — the test channel (branch “${s.github.previewBranch}”)`
    : `Production — your real site (branch “${s.github.branch}”)`;
}
