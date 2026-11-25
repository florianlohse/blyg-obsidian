// What the reader's `FollowHost` does, with the plugin's pieces handed in (so main.ts only wires): open "Blygs I follow", follow a blyg from a post.
// Also re-exports `replyPlan`, the reader's Reply for a post of a blyg that is not followed.
import { normalizePath, type App } from "obsidian";
import { openSubscriptions } from "../ui/SubscriptionsModal";
import type { FollowHost } from "../ui/readerFollow";
import { followBlyg, followText } from "./followFlow";
import type { ReaderStudio } from "./readerService";
import { followedCacheOf, parseFollowedCache, type FollowedStore } from "./followedList";

export { replyPlan } from "./replyToPost";

/** The "Sources" list kept in the plugin's own folder (inside the vault's configuration folder, never in a note), for the Studio it came from only. */
export function followedStore(deps: { app: App; build: () => ReaderStudio; manifest: { id: string; dir?: string } }): FollowedStore {
  const path = normalizePath(`${deps.manifest.dir ?? `${deps.app.vault.configDir}/plugins/${deps.manifest.id}`}/followed-cache.json`);
  const adapter = deps.app.vault.adapter;
  return {
    read: async () => {
      try {
        const built = deps.build();
        if (!built.ok || !(await adapter.exists(path))) return null;
        return parseFollowedCache(JSON.parse(await adapter.read(path)) as unknown, built.studio.address.origin);
      } catch {
        return null;
      }
    },
    write: (subscriptions, complete) => {
      try {
        const built = deps.build();
        if (built.ok) void adapter.write(path, JSON.stringify(followedCacheOf(subscriptions, complete, built.studio.address.origin, Date.now()))).catch(() => undefined);
      } catch {
        /* a list that cannot be kept is read again next time */
      }
    },
  };
}

export function createFollowHost(deps: { app: App; build: () => ReaderStudio; manifest: { id: string; dir?: string } }): FollowHost {
  const store = followedStore(deps);
  return {
    openSettings: () => {
      // Obsidian's own settings window, on this plugin's tab (an internal handle: when it is absent nothing happens, the entry is then not offered).
      const setting = (deps.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(deps.manifest.id);
    },
    openFollowed: (prefill) => openSubscriptions(deps.app, { build: deps.build, store, ...(prefill !== undefined ? { prefill } : {}) }),
    followBlyg: async (origin) => {
      const built = deps.build();
      if (!built.ok) return { kind: "problem", message: built.message };
      try {
        return await followBlyg(built.studio.client, origin);
      } catch {
        return { kind: "problem", message: followText.unreachable };
      }
    },
  };
}
