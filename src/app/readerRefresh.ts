// "Refresh", the one action of the feed and the digest: ask the Studio to fetch the blygs it reads (readerService.checkForNew keeps the 60 s pause and the back-off),
// watch its change counters until it is done, then the caller reads the list ONCE. The Studio is metered: nothing here polls on its own, and a second tap while
// one runs is refused by the caller. Pure of Obsidian: the clock and the sleep are injected, so it is tested with a fake clock (tests/app/readerRefresh.test.ts).
import type { ChangeMarks, ReaderHost } from "../ui/ReaderView";
import type { InboundMention, ReadingPost } from "../studio/reading";
import { chooseWalk, keepOwnPosts, knownOf, mergeFresh, READER_KEEP, type SyncMemory } from "../ui/readerSync";

export type RefreshPorts = Pick<ReaderHost, "checkForNew" | "changeMarks">;

export interface AskOptions {
  force: boolean;
  /** The caller's own bookkeeping of the counters (the feed notes that the list moved); true when they moved. */
  noteMarks: (now: ChangeMarks) => boolean;
  /** False once this check was replaced by a newer one, or the page is gone. */
  alive: () => boolean;
  status: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** `skipped`: the Studio was not asked (the pause, a back-off, no Studio; `reason` says why when there is one). `done`: asked and waited. `cancelled`: a newer check or a closed page took over. */
export type AskResult = { kind: "skipped"; reason?: string } | { kind: "done" } | { kind: "cancelled" };

const realSleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

export async function askAndWait(ports: RefreshPorts, o: AskOptions): Promise<AskResult> {
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const before = await ports.changeMarks();
  if (before !== null) o.noteMarks(before);
  const asked = await ports.checkForNew(o.force);
  if (!o.alive()) return { kind: "cancelled" };
  if (!asked.asked) return asked.reason ? { kind: "skipped", reason: asked.reason } : { kind: "skipped" };
  // "Checking blygs · 5/25": each blyg the Studio has fetched counts once (its subscriptions counter rises once per blyg), asked about every 1.5 seconds.
  const progress = (reported: number): void => o.status(`Checking blygs · ${Math.min(reported, asked.polling)}/${asked.polling}`);
  progress(0);
  let mark = before;
  const startedAt = now();
  let lastMove = startedAt;
  for (;;) {
    await sleep(1500);
    if (!o.alive()) return { kind: "cancelled" };
    const marks = await ports.changeMarks();
    if (marks !== null) {
      const reset = mark !== null && marks.epoch !== mark.epoch;
      const moved = o.noteMarks(marks) || mark === null || reset;
      if (moved) lastMove = now();
      mark = marks;
      if (reset) break;
    }
    const reported = mark !== null && before !== null ? mark.subscriptions - before.subscriptions : 0;
    progress(reported);
    if (reported >= asked.polling) break;
    if (reported > 0 && now() - lastMove >= 4000) break;
    if (now() - startedAt >= 30_000) break;
  }
  return o.alive() ? { kind: "done" } : { kind: "cancelled" };
}

export interface ListSnapshot {
  posts: ReadingPost[];
  mentions: InboundMention[];
}

/** The digest's side of the read: the newest rows (or the whole window, as the feed would choose) merged into the list the digest holds. null: the Studio did not answer (`message`). */
export async function readListAfter(host: Pick<ReaderHost, "load">, held: ListSnapshot | null, sync: SyncMemory, force: boolean, now: number): Promise<{ ok: true; list: ListSnapshot; studioOrigin: string } | { ok: false; message: string }> {
  const walk = chooseWalk(sync, now, held !== null, force);
  const known = walk === "incremental" && held ? knownOf(held.posts) : null;
  const got = await host.load(undefined, { known, mentions: walk === "full" || held === null, force, own: true });
  if (!got.ok) return { ok: false, message: got.message };
  let posts = got.data.posts;
  if (got.data.incremental && held) posts = mergeFresh(held.posts, posts, READER_KEEP);
  else {
    if (known !== null && held) posts = keepOwnPosts(held.posts, posts);
    sync.lastFullAt = now;
    sync.readingMoved = false;
    sync.movedWithoutNew = false;
  }
  const mentions = got.data.mentionsFetched === false && held ? held.mentions : got.data.mentions;
  return { ok: true, list: { posts, mentions }, studioOrigin: got.data.studioOrigin ?? "" };
}

export type DigestReader = Pick<ReaderHost, "checkForNew" | "changeMarks" | "load" | "writeCache">;

export type DigestRefreshResult = { ok: true; list: ListSnapshot; studioOrigin: string; note?: string } | { ok: false; message: string; cancelled?: true };

/**
 * The digest's Refresh: the same action as the feed's (askAndWait, then one read of the list; the same pause and back-off), nothing else. No AI request is made here
 * (the AI layer is only reached by "Write the digest"). The list read is kept for the next session like the feed's, so the digest and the feed start from the same list.
 */
export function createDigestRefresh(reader: DigestReader, now: () => number = Date.now, after: (list: ListSnapshot, origin: string, at: number) => void = () => undefined, memory: () => SyncMemory = () => ({ lastFullAt: 0, readingMoved: false, movedWithoutNew: false })) {
  let last: ChangeMarks | null = null;
  const noteMarks = (m: ChangeMarks, sync: SyncMemory): boolean => {
    const prev = last;
    last = m;
    if (prev === null) return false;
    if (m.reading !== prev.reading || m.epoch !== prev.epoch) sync.readingMoved = true;
    return m.epoch !== prev.epoch || m.reading !== prev.reading || m.subscriptions !== prev.subscriptions;
  };
  return async (o: { held: ListSnapshot | null; alive: () => boolean; status: (text: string) => void }): Promise<DigestRefreshResult> => {
    const sync = memory(); // read at each tap: the feed's own memory, shared (readerStart.ts)
    const asked = await askAndWait(reader, { force: true, noteMarks: (m) => noteMarks(m, sync), alive: o.alive, status: o.status, now });
    if (asked.kind === "cancelled") return { ok: false, message: "", cancelled: true };
    const read = await readListAfter(reader, o.held, sync, true, now());
    if (!read.ok) return read;
    reader.writeCache(read.list);
    after(read.list, read.studioOrigin, now());
    return { ok: true, list: read.list, studioOrigin: read.studioOrigin, ...(asked.kind === "skipped" && asked.reason ? { note: asked.reason } : {}) };
  };
}
