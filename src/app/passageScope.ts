// "Send passage to note": which notes the destination picker offers. The writer chooses the folders in the settings (one per line, several allowed); with no
// folder chosen nothing is offered (fail closed: a stranger's words are quoted only into a note in a folder the writer named). Recent destinations come first.
// Pure: the picker window is src/ui/PassageSendModal.ts, the vault is read in src/app/passageEntry.ts.
import type { ReadingPost } from "../studio/reading";
import { isUnfollowedPost } from "../ui/readerFollow";
import { PM } from "./passageMessages";
import { extractionVerdict } from "./threadCommands";

/** The setting's text (one folder per line) as clean folder paths without leading or trailing slashes. Entries that climb (`..`) or are empty are dropped. */
export function parseFolders(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0 || parts.includes("..")) continue;
    const folder = parts.join("/");
    if (!out.includes(folder)) out.push(folder);
  }
  return out;
}

/** Is this vault path inside one of the folders? An empty list is no folder at all: nothing is inside. */
export function inFolders(path: string, folders: readonly string[]): boolean {
  return folders.some((f) => path.startsWith(`${f}/`));
}

export interface DestinationNote {
  path: string;
  name: string;
  /** Last change, for ordering the notes that were not used lately. */
  mtime: number;
}

export interface RecentDestination {
  path: string;
  at: number;
}

export const RECENT_MAX = 8;
const OTHERS_MAX = 200;

/** The recent list with `path` first (used now), without repeats, at most RECENT_MAX long. */
export function withRecent(list: readonly RecentDestination[], path: string, now: number): RecentDestination[] {
  return [{ path, at: now }, ...list.filter((r) => r.path !== path)].slice(0, RECENT_MAX);
}

/** A stored list read back: anything that is not a list of `{path, at}` is dropped, never trusted. */
export function readRecent(raw: unknown): RecentDestination[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentDestination[] = [];
  for (const r of raw) {
    if (typeof r === "object" && r !== null && typeof (r as { path?: unknown }).path === "string" && typeof (r as { at?: unknown }).at === "number") out.push({ path: (r as RecentDestination).path, at: (r as RecentDestination).at });
  }
  return out.slice(0, RECENT_MAX);
}

export interface DestinationList {
  recent: DestinationNote[];
  others: DestinationNote[];
  /** The folders the list was made from (after narrowing). */
  folders: string[];
}

/**
 * The notes to offer. `folders` is the setting; `narrowed` is a choice made in this window and can only take folders away (a name that is not in `folders` is
 * ignored; none left standing means all of them). A query keeps the notes whose name or path contains it (case ignored).
 */
export function destinationList(notes: readonly DestinationNote[], opts: { folders: readonly string[]; narrowed?: readonly string[]; recent: readonly RecentDestination[]; query?: string }): DestinationList {
  const narrowed = (opts.narrowed ?? []).filter((f) => opts.folders.includes(f));
  const folders = narrowed.length > 0 ? narrowed : [...opts.folders];
  const q = (opts.query ?? "").trim().toLowerCase();
  const fits = notes.filter((n) => inFolders(n.path, folders) && (q === "" || n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)));
  const byPath = new Map(fits.map((n) => [n.path, n]));
  const recent: DestinationNote[] = [];
  for (const r of opts.recent) {
    const n = byPath.get(r.path);
    if (n && !recent.includes(n)) recent.push(n);
  }
  const others = fits.filter((n) => !recent.includes(n)).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).slice(0, OTHERS_MAX);
  return { recent, others, folders };
}

/** What the picked note allows: the same rule as moving a selection out of a note (essays and pages cannot hold a quote; a fragment cannot either). */
export type DestinationVerdict = { ok: true } | { ok: false; reason: "plain-route" | "fragment" | "published-fragment" };

export function destinationVerdict(note: { routeMode: "blyg" | "plain" | "studio" | null; kind: "fragment" | "thread"; hasId: boolean }): DestinationVerdict {
  return extractionVerdict(note);
}

/** Why a post cannot be quoted, or null. Quoting follows reading (spec 0.4 §10.2): only a post the Studio holds can be quoted. */
export function passageBlocked(post: ReadingPost): string | null {
  if (post.own === true) return PM.dockOwn;
  if (post.withdrawn) return PM.dockWithdrawn;
  if (isUnfollowedPost(post)) return PM.dockNotFollowed;
  return null;
}

/** The folder (as the writer named it, the longest that holds the path) a note is in; null when it is in none. */
const rootOf = (path: string, folders: readonly string[]): string | null => folders.filter((f) => path.startsWith(`${f}/`)).sort((a, b) => b.length - a.length)[0] ?? null;

/**
 * Notes grouped by SUBFOLDER under the configured folders, for the picker's list. Only when at least one note sits in a subfolder (else null: one plain list, as before).
 * Groups follow the order of the configured folders, the folder's own notes first, then its subfolders A to Z; the notes inside a group keep the order they came in.
 * `title` is the folder's path, so two folders with the same subfolder name stay apart.
 */
export function clusterBySubfolder(notes: readonly DestinationNote[], folders: readonly string[]): Array<{ title: string; notes: DestinationNote[] }> | null {
  const groups = new Map<string, { root: number; dir: string; notes: DestinationNote[] }>();
  let nested = false;
  for (const n of notes) {
    const root = rootOf(n.path, folders);
    if (root === null) continue;
    const rest = n.path.slice(root.length + 1);
    const dir = rest.includes("/") ? rest.slice(0, rest.lastIndexOf("/")) : "";
    if (dir !== "") nested = true;
    const title = dir === "" ? root : `${root}/${dir}`;
    const g = groups.get(title) ?? { root: folders.indexOf(root), dir, notes: [] };
    g.notes.push(n);
    groups.set(title, g);
  }
  if (!nested) return null;
  return [...groups.entries()].sort(([, a], [, b]) => a.root - b.root || (a.dir === "" ? -1 : b.dir === "" ? 1 : a.dir.localeCompare(b.dir))).map(([title, g]) => ({ title, notes: g.notes }));
}
