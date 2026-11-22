// "Load older posts" (HK4): the reader's list reaches past the newest 200 on demand. The Studio's reading list has no "older than" parameter, only a cursor that
// continues a walk, and a cursor dies when the list changes (409 cursor-expired). So this keeps where the last walk ended; when that cursor is gone, it reads the
// list again from the top down to the depth held and on from there (more requests, never wrong rows). Pure of Obsidian: the Studio is injected, tests use a fake.
import type { ReadingPost } from "../studio/reading";
import { OLDER_MAX, OLDER_PAGES, READER_PAGE, type OlderResult } from "../ui/readerSync";
import { readerBuildMessage, readerText } from "./readerMessages";
import type { ReaderStudio } from "./readerService";

/** At most this many pages in one go, however deep the held list is (the walk from the top costs one request per page). */
const MAX_WALK_PAGES = Math.ceil(OLDER_MAX / READER_PAGE) + OLDER_PAGES;

interface Mark {
  origin: string;
  /** Where the last walk ended (the cursor of the page after the deepest one read); null when it is gone or never was. */
  cursor: string | null;
  /** How many posts the walks have reached in all. */
  depth: number;
  /** The list ended: nothing lies beyond `depth`. */
  ended: boolean;
}

export interface OlderReader {
  /** A whole walk of the newest window finished: note how far it went. A walk that stopped early (a quick look) says nothing about depth. */
  noteWalk(origin: string, walk: { count: number; next: string | null; complete: boolean; stopped: boolean }): void;
  /** Is there anything older to load, as far as the last walk knows? */
  more(): boolean;
  /** Read the next older posts. Never two at once: a second call gets the first one's answer. */
  loadOlder(): Promise<OlderResult>;
}

export function createOlderReader(deps: { build: () => ReaderStudio; rememberPosts: (posts: ReadingPost[]) => void; failed: () => void; worked: () => void }): OlderReader {
  let mark: Mark | null = null;
  let running: Promise<OlderResult> | null = null;
  const moreAfter = (m: Mark): boolean => !m.ended && m.depth < OLDER_MAX;

  const run = async (): Promise<OlderResult> => {
    const built = deps.build();
    if (!built.ok) return { ok: false, message: readerBuildMessage(built.message) };
    const origin = built.studio.address.origin;
    const was = mark;
    if (was === null || was.origin !== origin || was.ended) return { ok: true, posts: [], more: false, capped: false };
    if (was.depth >= OLDER_MAX) return { ok: true, posts: [], more: false, capped: true };
    const { client } = built.studio;
    try {
      let rewalked = false;
      let got = was.cursor !== null ? await client.listReading(OLDER_PAGES, undefined, { pageSize: READER_PAGE, cursor: was.cursor }) : null;
      if (got === null || (got.kind === "error" && got.status === 409)) {
        rewalked = true;
        got = await client.listReading(Math.min(MAX_WALK_PAGES, Math.ceil(was.depth / READER_PAGE) + OLDER_PAGES), undefined, { pageSize: READER_PAGE });
      }
      if (got.kind !== "ok") {
        if (got.kind === "error") deps.failed();
        return { ok: false, message: "message" in got ? got.message : readerText.listFailed };
      }
      deps.worked();
      // The Markdown of a post is never shown: older posts are kept without it, as the saved list is.
      const posts = got.value.posts.map((p) => ({ ...p, contentMd: "" }));
      const next: Mark = { origin, cursor: got.value.next, depth: rewalked ? posts.length : was.depth + posts.length, ended: got.value.complete };
      mark = next;
      deps.rememberPosts(posts);
      return { ok: true, posts, more: moreAfter(next), capped: !next.ended && next.depth >= OLDER_MAX };
    } catch {
      deps.failed();
      return { ok: false, message: readerText.loadUnreachable };
    }
  };

  return {
    noteWalk(origin, walk) {
      if (walk.stopped) return;
      if (walk.complete) {
        mark = { origin, cursor: null, depth: walk.count, ended: true };
        return;
      }
      // Older posts were loaded before and this walk only brought the newest window: its cursor does not reach the deepest of them, so the next load walks from the top.
      const deeper = mark !== null && mark.origin === origin && mark.depth > walk.count;
      mark = deeper && mark !== null ? { ...mark, cursor: null, ended: false } : { origin, cursor: walk.next, depth: walk.count, ended: false };
    },
    more: () => mark !== null && moreAfter(mark),
    loadOlder() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
