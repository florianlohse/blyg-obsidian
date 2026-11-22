// What the reader's `FollowHost` does, with the plugin's pieces handed in (so main.ts only wires): open "Blygs I follow", follow a blyg from a post.
// Also re-exports `replyPlan`, the reader's Reply for a post of a blyg that is not followed.
import type { App } from "obsidian";
import { openSubscriptions } from "../ui/SubscriptionsModal";
import type { FollowHost } from "../ui/readerFollow";
import { followBlyg, followText } from "./followFlow";
import type { ReaderStudio } from "./readerService";

export { replyPlan } from "./replyToPost";

export function createFollowHost(deps: { app: App; build: () => ReaderStudio }): FollowHost {
  return {
    openFollowed: (prefill) => openSubscriptions(deps.app, { build: deps.build, ...(prefill !== undefined ? { prefill } : {}) }),
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
