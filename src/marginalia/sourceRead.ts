// HK3 Marginalia: the Markdown of a post that quotes a note. The reader's held copy first (when it has Markdown); otherwise the Studio's imported-item read:
// a peek says which subscription holds the blyg, then `GET /imports/{sub}/{id}` carries `contentMd`. A post the Studio does not import falls back to the peek's rendered HTML (the lookup reads the quote
// from its blockquote); a failed peek gives null (the lookup says "unknown"); a withdrawn post says so. Read-only.
import type { StudioClient } from "../studio/client";
import type { ReadingPost } from "../studio/reading";
import { sameOrigin } from "../ui/readerMentions";
import type { SourcePost, SourceReader } from "./lookup";

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
    // The peek's rendered HTML is the fallback: it exists for any blyg, followed or not, while the Markdown is only held for posts the Studio imported (measured on a
    // real Studio 0.51.0: a post of a blyg that is not followed has no subscription, and a followed blyg's post answers 404 on the imported read until it is imported).
    const fromPeek: SourcePost = { version: peek.value.version, markdown: null, html: peek.value.contentHtml, withdrawn: false };
    if (peek.value.subscriptionId === null) return fromPeek;
    const got = await client.getImported(peek.value.subscriptionId, m.sourceId);
    if (got.kind !== "ok") return fromPeek;
    if (got.value.state === "tombstone") return { version: got.value.version, markdown: null, withdrawn: true };
    return got.value.contentMd?.trim() ? { version: got.value.version, markdown: got.value.contentMd, withdrawn: false } : { ...fromPeek, version: got.value.version, html: got.value.contentHtml || peek.value.contentHtml };
  };
}
