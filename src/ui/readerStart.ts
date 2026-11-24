// What the reader does when it opens, in one place, so it can be tested without Obsidian. The rule (DG8): the Studio is asked for the list only when the reader opens from
// nothing for the first time in this session (nothing was read yet, and no post is being opened), and when the person presses Refresh. A reader made again to show a post (from
// the digest, from a share) or again for the feed, or Back, reads the list saved on this device and asks nothing: no walk, no check, no list of your own posts.
import { applyMarks } from "../digest/markQueue";
import type { InboundMention, ReadingPost } from "../studio/reading";
import type { SyncMemory } from "./readerSync";

/** Plugin-session memory: the Studio has been asked for the list once, whatever it answered (by any reader view). Not stored: a restart of Obsidian is a new session. */
export interface Saved {
  posts: ReadingPost[];
  mentions: InboundMention[];
  savedAt: number;
  studioOrigin: string;
}

/** `list`: the last list a reader view held, so a reader made again (Feed after Digest) starts from it, newer than the file and also when the file has no posts to keep. */
const memory: { loaded: boolean; list: Saved | null; sync: SyncMemory } = { loaded: false, list: null, sync: freshSync() };
function freshSync(): SyncMemory {
  return { lastFullAt: 0, readingMoved: false, movedWithoutNew: false };
}
/** What the Studio's list reads have found out so far this session (when the whole window was last read, whether the counters moved): the feed and the digest share it, so a Refresh in one chooses its read as it would in the other. */
export const sessionSync = (): SyncMemory => memory.sync;
export function noteListLoaded(list?: Saved): void {
  memory.loaded = true;
  if (list) memory.list = list;
}
/** The list a reader view would start from now (this session's last, else nothing): what a post opened from another page uses at once, so its header is drawn with its place in the feed already known. */
export function heldList(): Saved | null {
  if (memory.list) applyMarks(memory.list.posts, memory.list.savedAt);
  return memory.list;
}
/** The digest read the saved list: a reader made for a post starts from it too (never marks the session as asked). */
export function seedSaved(list: Saved | null): Saved | null {
  if (list && !memory.list) memory.list = list;
  return list;
}
export const listLoadedThisSession = (): boolean => memory.loaded;
/** For tests. */
export const forgetSession = (): void => void ((memory.loaded = false), (memory.list = null), (memory.sync = freshSync()));

export interface StartPorts {
  /** False once the view was closed while Obsidian was still starting. */
  alive(): boolean;
  /** A post is shown, or Back goes somewhere else (the reader was made to show a post). */
  forPost(): boolean;
  hasData(): boolean;
  readCache(): Promise<Saved | null>;
  /** Show the saved list. `updating`: the Studio is about to be asked, behind it. */
  showSaved(saved: Saved, updating: boolean): void;
  /** Read the list from the Studio behind the saved one (the whole window). */
  walk(): Promise<void>;
  /** Read the list from the Studio, as for a reader with nothing to show. */
  load(): Promise<void>;
  /** The person's own items, for the replies chip: asked of the Studio only when `ask`, else only what was kept this session. */
  mine(ask: boolean): void;
  failed(): void;
}

export async function startReader(p: StartPorts): Promise<void> {
  if (!p.alive()) return;
  try {
    const ask = !p.forPost() && !listLoadedThisSession();
    p.mine(ask);
    const saved = memory.list ?? (await p.readCache().catch(() => null));
    if (saved) applyMarks(saved.posts, saved.savedAt); // a mark made in an open post since that list was saved
    if (saved && !p.hasData()) {
      p.showSaved(saved, ask);
      if (ask) {
        noteListLoaded(); // asked once: a Studio that answers badly is not asked again at every opening, Refresh is the way to try again
        await p.walk();
      }
      return;
    }
    // Nothing saved and nothing shown: a first load is the only way to have a list (also for a post opened from nowhere).
    if (!p.hasData() || ask) {
      noteListLoaded();
      await p.load();
    }
  } catch {
    p.failed();
  }
}

/** What the feed's body says while it has no list: "Loading…" until the first answer (the saved list or the Studio's) is in, "nothing to show" only for a real empty one. */
export const emptyFeedNote = (busy: boolean, loadingFirst: boolean): string => (busy || loadingFirst ? "Loading…" : "The reader has nothing to show yet.");
