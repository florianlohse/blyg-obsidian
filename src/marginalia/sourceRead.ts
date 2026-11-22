// HK3 Marginalia: the Markdown of a post that quotes a note. The reader's held copy first (when it has Markdown); otherwise the Studio's imported-item read:
// a peek says which subscription holds the blyg, then `GET /imports/{sub}/{id}` carries `contentMd`. A blyg the Studio does not import, a failed read
// or a post without Markdown gives null (the lookup says "unknown"); a withdrawn post says so. Read-only.
import type { StudioClient } from "../studio/client";
import type { ReadingPost } from "../studio/reading";
import { sameOrigin } from "../ui/readerMentions";
import type { SourceReader } from "./lookup";

export interface SourceReadDeps {
  /** The Studio's client, or null when there is no Studio set up. */
  client(): StudioClient | null;
  /** A post the reader holds, by its id. */
  heldPost(id: string): Promise<ReadingPost | null>;
}

export function makeSourceReader(host: SourceReadDeps): SourceReader {
  return async (m) => {
    const post = m.sourceId ? await host.heldPost(m.sourceId) : null;
    if (post && sameOrigin(post.origin, m.sourceOrigin) && post.contentMd.trim() !== "") return { version: post.version, markdown: post.contentMd, withdrawn: post.withdrawn };
    const client = host.client();
    if (!client || !m.sourceOrigin || !m.sourceId) return null;
    const peek = await client.peekItem(m.sourceOrigin, m.sourceId);
    if (peek.kind !== "ok") return null;
    if (peek.value.kind === "withdrawn") return { version: peek.value.version, markdown: null, withdrawn: true };
    if (peek.value.subscriptionId === null) return null;
    const got = await client.getImported(peek.value.subscriptionId, m.sourceId);
    if (got.kind !== "ok") return null;
    return { version: got.value.version, markdown: got.value.contentMd?.trim() ? got.value.contentMd : null, withdrawn: got.value.state === "tombstone" };
  };
}
