// The reader's two small writes to the Studio (moved out of main.ts, unchanged in behaviour): dismiss an inbound mention, and mark a post read or unread.
// Each answers a result the reader can act on: it shows the change first and puts it back with this message on a refusal.
import type { StudioClient } from "../studio/client";
import type { InboundMention, ReadingPost } from "../studio/reading";
import type { ReadResult } from "../ui/ReaderView";

type Build = () => { ok: true; studio: { client: StudioClient } } | { ok: false; message: string };

export function createReaderWrites(build: Build): { hideMention(m: InboundMention): Promise<ReadResult>; mark(post: ReadingPost, read: boolean): Promise<ReadResult> } {
  return {
    /** Hide an inbound mention in the Studio. The mention comes back on a refusal. */
    hideMention: async (m) => {
      try {
        const built = build();
        if (!built.ok) return { ok: false, message: built.message };
        const done = await built.studio.client.hideMention(m.id, true);
        if (done.kind === "ok") return { ok: true };
        if (done.kind === "forbidden") return { ok: false, message: "Your token cannot dismiss mentions. It needs the permission “owner:manage”: make a new token with every permission." };
        return { ok: false, message: "message" in done ? done.message : "Could not dismiss the mention." };
      } catch {
        return { ok: false, message: "The Studio could not be reached, so the mention was not dismissed." };
      }
    },
    /** Mark a post read or unread in the Studio. */
    mark: async (post, read) => {
      try {
        const built = build();
        if (!built.ok) return { ok: false, message: built.message };
        const { client } = built.studio;
        const done = read ? await client.markRead(post.subscriptionId, post.remoteId, post.version) : await client.markUnread(post.subscriptionId, post.remoteId);
        if (done.kind === "ok") return { ok: true };
        if (done.kind === "forbidden") return { ok: false, message: "Your token cannot mark posts read. It needs the permission “reading:state”: make a new token with every permission." };
        return { ok: false, message: "message" in done ? done.message : "Could not change the read mark." };
      } catch {
        return { ok: false, message: "The Studio could not be reached, so the read mark was not changed." };
      }
    },
  };
}
