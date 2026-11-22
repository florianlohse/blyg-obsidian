// The reader's conversation with the Studio: when to ask it to fetch, how to leave it alone when it fails (Burrow's rule), and how the list is read.
// Moved out of main.ts unchanged in behaviour; every dependency is injected, so it is tested with a fake Studio and a fake clock (tests/app/readerService.test.ts).
import type { InboundMention, ReadingPost } from "../studio/reading";
import type { StudioClient } from "../studio/client";
import type { ReaderHost } from "../ui/ReaderView";
import { backoffDelay, READER_PAGE, READER_PAGES, reachedKnown } from "../ui/readerSync";
import { readerBuildMessage, readerText } from "./readerMessages";

/** What the service needs of the Studio build: the client, and the origin its answers came from. */
export type ReaderStudio = { ok: true; studio: { client: StudioClient; address: { origin: string } } } | { ok: false; message: string };

export interface ReaderServiceDeps {
  /** A fresh Studio client for the settings as they are now, or why there is none. */
  build: () => ReaderStudio;
  now: () => number;
  /** The posts loaded, kept for replies (see rememberPosts in main.ts). */
  rememberPosts: (posts: ReadingPost[]) => void;
  warn: (line: string) => void;
}

export type ReaderService = Pick<ReaderHost, "checkForNew" | "changeMarks" | "load">;

/** A pause between checks: every check makes the Studio fetch every blyg it reads, so opening the reader again and again must not hammer them. */
export const CHECK_PAUSE_MS = 60_000;

export function createReaderService(deps: ReaderServiceDeps): ReaderService {
  let trouble = { failures: 0, until: 0 };
  let checkedAt = 0;

  /** In words, why the reader is not asking the Studio now, or null. */
  const backedOff = (): string | null => {
    const wait = trouble.until - deps.now();
    return wait > 0 ? readerText.backedOff(Math.max(1, Math.ceil(wait / 60_000))) : null;
  };
  const failed = (): void => {
    trouble.failures++;
    trouble.until = deps.now() + backoffDelay(trouble.failures);
  };
  const worked = (): void => {
    trouble = { failures: 0, until: 0 };
  };

  return {
    checkForNew: async (force) => {
      // (The reader asks only when the person pressed Refresh: the Studio fetches the blygs itself every half hour.)
      if (deps.now() - checkedAt < CHECK_PAUSE_MS) return { asked: false };
      const waiting = force ? null : backedOff();
      if (waiting) return { asked: false, reason: waiting };
      const built = deps.build();
      if (!built.ok) return { asked: false, reason: readerBuildMessage(built.message) };
      try {
        const got = await built.studio.client.pollSubscriptions();
        if (got.kind === "ok") {
          checkedAt = deps.now();
          worked();
          return { asked: true, polling: got.value.polling };
        }
        if (got.kind === "forbidden") return { asked: false, reason: readerText.pollForbidden };
        if (got.kind === "error") failed();
        return { asked: false, reason: readerText.pollFailed };
      } catch {
        failed();
        return { asked: false, reason: readerText.pollUnreachable };
      }
    },
    changeMarks: async () => {
      if (backedOff()) return null;
      const built = deps.build();
      if (!built.ok) return null;
      try {
        const got = await built.studio.client.changes();
        if (got.kind !== "ok") {
          if (got.kind === "error") failed();
          return null;
        }
        worked();
        return { epoch: got.value.epoch, reading: got.value.domains.reading ?? 0, subscriptions: got.value.domains.subscriptions ?? 0 };
      } catch {
        failed();
        return null;
      }
    },
    load: async (onProgress, opts) => {
      const waiting = opts?.force ? null : backedOff();
      if (waiting) return { ok: false, message: waiting };
      const built = deps.build();
      if (!built.ok) return { ok: false, message: readerBuildMessage(built.message) };
      try {
        const { client } = built.studio;
        const known = opts?.known ?? null;
        const wantMentions = opts?.mentions !== false;
        // The owner's own posts (increment 8b) come from the Studio's merged list, with a whole read only: a quick look keeps the ones held.
        const wantOwn = opts?.own === true && known === null;
        const [reading, mentions, own] = await Promise.all([
          client.listReading(READER_PAGES, onProgress, { pageSize: READER_PAGE, ...(known ? { stopAfter: (rows: ReadingPost[]) => reachedKnown(rows, known) } : {}) }),
          wantMentions ? client.listInboundMentions() : Promise.resolve(null),
          wantOwn ? client.listOwnReading() : Promise.resolve(null),
        ]);
        if (reading.kind !== "ok") {
          if (reading.kind === "error") failed();
          return { ok: false, message: "message" in reading ? reading.message : readerText.listFailed };
        }
        worked();
        // The window is the newest posts only: older unread posts are not reachable yet ("load older" is planned).
        const bad = reading.value.unreadable + (mentions !== null && mentions.kind === "ok" ? mentions.value.unreadable : 0);
        const note = [bad > 0 ? readerText.unreadable(bad) : "", mentions !== null && mentions.kind !== "ok" ? readerText.mentionsUnavailable : ""].filter(Boolean).join(" ");
        deps.rememberPosts(reading.value.posts);
        const mentionList: InboundMention[] = mentions !== null && mentions.kind === "ok" ? mentions.value.mentions : [];
        return {
          ok: true,
          data: { posts: own !== null && own.kind === "ok" ? [...reading.value.posts, ...own.value.posts] : reading.value.posts, mentions: mentionList, mentionsFetched: mentions !== null && mentions.kind === "ok", note, studioOrigin: built.studio.address.origin, incremental: reading.value.stopped },
        };
      } catch (err) {
        failed();
        deps.warn(`reader load failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, message: readerText.loadUnreachable };
      }
    },
  };
}
