// Marking posts read from the digest, politely. Each mark is one Studio write (D1 rows), so: only posts that are unread are marked, a post is never marked twice,
// the marks go one after the other with a pause between them (no burst), nothing polls, and the new state shows at once (the caller paints it before the first request).
// A refusal or failure stops the rest of its batch and puts every mark of the batch that was not made back. Pure: the Studio call, the clock and the pause are injected.
import { isUnread, type ReadingPost } from "../studio/reading";

/** The pause between two writes of a batch, in milliseconds. */
export const MARK_GAP_MS = 400;

export interface MarkResult {
  ok: boolean;
  message?: string;
}

export interface MarkDeps {
  /** The reader's own mark-read path (permission `reading:state`, one request per post). */
  mark(post: ReadingPost): Promise<MarkResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Called when a mark was put back (the Studio refused it, or the call failed) with the reason; and when the whole queue is idle. */
  onReverted(posts: readonly ReadingPost[], message: string): void;
  onChange(): void;
}

export const markKey = (p: Pick<ReadingPost, "subscriptionId" | "remoteId">): string => `${p.subscriptionId}/${p.remoteId}`;
const keyOf = markKey;

/** The posts of `posts` a mark would change: unread, not withdrawn, not the owner's own. */
export const markable = (posts: readonly ReadingPost[]): ReadingPost[] => posts.filter((p) => isUnread(p) && !p.withdrawn && p.own !== true);

export class MarkQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();
  /** Marks made on this device, with the time: the reader's saved list does not know them until the reader saves again (see `apply`). */
  private readonly made = new Map<string, { version: number; at: number }>();
  constructor(private readonly deps: MarkDeps) {}

  /**
   * Mark these posts read. Their state changes here and now (`readVersion` becomes the version); the Studio is asked one post at a time. Posts that are read already, or
   * are already waiting, are left alone. Resolves when the batch is done.
   */
  enqueue(posts: readonly ReadingPost[]): Promise<void> {
    const batch = markable(posts).filter((p) => !this.pending.has(keyOf(p)));
    if (batch.length === 0) return this.tail;
    const before = new Map(batch.map((p) => [keyOf(p), p.readVersion] as const));
    const sent = new Map(batch.map((p) => [keyOf(p), p.version] as const));
    const at = this.deps.now();
    for (const p of batch) {
      this.pending.add(keyOf(p));
      this.made.set(keyOf(p), { version: p.version, at });
      p.readVersion = p.version;
    }
    this.deps.onChange();
    const run = this.tail.then(async () => {
      let failed = "";
      const undone: ReadingPost[] = [];
      for (const [i, p] of batch.entries()) {
        const k = keyOf(p);
        if (failed === "") {
          if (i > 0) await this.deps.sleep(MARK_GAP_MS);
          const done = await this.deps.mark({ ...p, version: sent.get(k) ?? p.version }).catch((): MarkResult => ({ ok: false, message: "The read mark could not be changed." }));
          if (!done.ok) failed = done.message ?? "The read mark could not be changed.";
        }
        if (failed !== "") undone.push(p);
        this.pending.delete(k);
      }
      for (const p of undone) {
        p.readVersion = before.get(keyOf(p)) ?? null;
        this.made.delete(keyOf(p));
      }
      if (undone.length > 0) this.deps.onReverted(undone, failed);
      this.deps.onChange();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Put the marks made here onto a list read from the reader's saved copy (saved at `savedAt`), unless that copy is newer than the mark (then it knows). Nothing is asked of the Studio. */
  apply(posts: readonly ReadingPost[], savedAt: number): void {
    for (const p of posts) {
      const m = this.made.get(markKey(p));
      if (m && m.at >= savedAt && p.version <= m.version && isUnread(p)) p.readVersion = p.version;
    }
  }
}

/** The pause, on the real clock. */
export const realSleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** One queue for the whole plugin session: a batch goes on when the Daily is left for a post (the view is made again on Back) and a post is never marked twice. */
let shared: MarkQueue | null = null;
let listener: { change(): void; reverted(message: string): void } | null = null;
export function sharedMarks(mark: MarkDeps["mark"], sleep: MarkDeps["sleep"], now: () => number = Date.now): MarkQueue {
  shared ??= new MarkQueue({ mark, sleep, now, onChange: () => listener?.change(), onReverted: (_p, m) => listener?.reverted(m) });
  return shared;
}
/** The open Daily view, to repaint when a mark changes; null when it is closed. */
export const watchMarks = (l: typeof listener): void => void (listener = l);
/** For tests. */
export const resetMarks = (): void => {
  shared = null;
  listener = null;
};
