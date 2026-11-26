// The one place the plugin asks the registry before it registers a switchable feature's entry points (commands, ribbon icons, views). Off: the feature's
// register function is not called, so nothing of it exists. Switching takes effect after a reload (the settings tab says so).
import type { Plugin } from "obsidian";
import { registerDigest, type DigestDeps } from "../digest/register";
import { registerShareEntry, type ShareEntryDeps } from "../app/shareEntry";
import { registerDevCommands } from "../dev/drawBench";
import { registerTangleEntries, type TangleEntryDeps } from "../tangle/register";
import type { ReaderContrast } from "../ui/readerLook";
import type { Features } from "./registry";

export interface FeatureEntryDeps {
  digest: DigestDeps;
  share: ShareEntryDeps;
  contrast: () => ReaderContrast;
  tangle: TangleEntryDeps;
}

export function registerFeatureEntries(plugin: Plugin, features: Features, deps: FeatureEntryDeps): void {
  if (features.enabled("daily")) registerDigest(plugin, features.enabled("digest-ai") ? deps.digest : { font: deps.digest.font, time: deps.digest.time, readList: deps.digest.readList, ...(deps.digest.reader ? { reader: deps.digest.reader } : {}), mode: deps.digest.mode, ...(deps.digest.notes ? { notes: deps.digest.notes } : {}), ...(deps.digest.markRead ? { markRead: deps.digest.markRead } : {}), ...(deps.digest.markUnread ? { markUnread: deps.digest.markUnread } : {}), ...(deps.digest.replyTo ? { replyTo: deps.digest.replyTo } : {}), ...(deps.digest.shelf ? { shelf: deps.digest.shelf } : {}), ...(deps.digest.data ? { data: deps.digest.data } : {}) });
  if (features.enabled("share-open")) registerShareEntry(plugin, { ...deps.share, enabled: () => features.enabled("share-open") });
  if (features.enabled("tangle")) registerTangleEntries(plugin, deps.tangle);
  registerDevCommands(plugin, deps.contrast, (id) => features.enabled(id));
}
