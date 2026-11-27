// Feature toggles (FT0). One list of the features that can be switched, and one pure accessor that says whether a feature is on.
// Stages: `stable` is always on and has no switch; `experimental` is off in the release build and on in the development build, and has a switch under
// Settings -> Experimental features; `dev` exists only when the manifest id ends in "-dev" and has no switch.
// Off means ABSENT: nothing registered, no request, no write. A switch never deletes what the feature stored.
import { isDevBuildId } from "../studio/devLock";

export type FeatureStage = "stable" | "experimental" | "dev";

export interface FeatureDef {
  id: string;
  title: string;
  /** One plain line for the switch. */
  description: string;
  stage: FeatureStage;
  /** Another feature that must be on too (the AI layer lives inside the Daily). */
  requires?: string;
  /** Source files (relative to the repository root) that register this feature's commands, ribbon icons, views or editor extensions. tests/features/entry-points.test.ts reads this. */
  modules: string[];
}

export const FEATURES: readonly FeatureDef[] = [
  { id: "daily", title: "Daily", description: "A Daily view of what the blygs you follow posted, with a ribbon icon and the command “Open Daily”.", stage: "experimental", modules: ["src/digest/register.ts"] },
  { id: "digest-ai", title: "Daily digest with an AI model", description: "The optional AI summary in the Daily: its settings, “Write the digest” and “Show what the digest sent”. It also keeps its own opt-in.", stage: "experimental", requires: "daily", modules: ["src/digest/register.ts"] },
  { id: "shelf", title: "Save posts for later", description: "A Save action in the reader and the Daily, and a Saved view in the feed, kept on your Studio's shelf and shared with your other devices.", stage: "experimental", modules: [] },
  { id: "marginalia", title: "Marginalia", description: "Where a published item was quoted or answered: markers in the text, a Reception section at the end of the note, and the Reception list in the panel.", stage: "experimental", modules: [] },
  { id: "share-open", title: "Open a shared address", description: "The Share inbox folder and the command “Open post address from clipboard”.", stage: "experimental", modules: ["src/app/shareEntry.ts"] },
  { id: "tangle", title: "New items from a thread", description: "Publish a thread that contains the Studio's new-item spans (![[+ …]]) and placeholders ([[+ …]]): one confirmation, then the new items are made and the thread is published last. Needs a Studio with API contract 5.12 or newer (Studio 0.63 or newer).", stage: "experimental", modules: [] },
  { id: "passages", title: "Send passage to note", description: "Select a passage in the reader and send it, as a native quote, to a note in the folders you choose, under a heading you pick. A dock appears under the post while text is selected, and the command “Send selected passage to a note” does the same. In a note, selected words can be drafted as a Blyg fragment or thread (editor menu and commands).", stage: "experimental", modules: ["src/app/passageEntry.ts", "src/app/passageDraftEntry.ts"] },
  { id: "author-look", title: "Author look (prototype)", description: "A chooser that switches the look of the open post.", stage: "dev", modules: ["src/dev/authorStyle.ts"] },
  { id: "reader-timing", title: "Reader timing", description: "A command that draws invented posts and times it.", stage: "dev", modules: ["src/dev/drawBench.ts"] },
];

/** Registration calls that belong to no feature: the plugin's core. tests/features/entry-points.test.ts fails on any call outside these counts and the modules above; a new core entry is added here on purpose. */
export const CORE_ENTRIES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "src/main.ts": { addCommand: 25, addRibbonIcon: 2, registerView: 2, registerEditorExtension: 1 },
};

export type FeatureOverrides = Readonly<Record<string, boolean>> | undefined;

/** Pure: is `id` on, given the user's switches and the build flavour? An unknown id is off (fail closed). */
export function featureEnabled(id: string, overrides: FeatureOverrides, dev: boolean): boolean {
  const def = FEATURES.find((f) => f.id === id);
  if (!def) return false;
  if (def.stage === "dev") return dev;
  if (def.requires !== undefined && !featureEnabled(def.requires, overrides, dev)) return false;
  if (def.stage === "stable") return true;
  const set = overrides?.[id];
  return typeof set === "boolean" ? set : dev;
}

export interface Features {
  enabled(id: string): boolean;
}

/** The accessor a plugin holds: reads the live settings every time, so a switch counts at once for what is checked at call time. */
export function createFeatures(overrides: () => FeatureOverrides, manifestId: string): Features {
  const dev = isDevBuildId(manifestId);
  return { enabled: (id) => featureEnabled(id, overrides(), dev) };
}

/** Keep only boolean switches (a value from a later version or a hand edit never turns anything on by accident). */
export function cleanFeatureFlags(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean") out[k] = v;
  return out;
}
