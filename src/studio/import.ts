// Import from the Studio (roadmap S7, docs/plans/S13-hoppers-and-import.md §2.2): which of the owner's Studio items have no note yet, what
// the new notes are called, where they go and what their properties say. Pure; the service (publish/studioImport.ts) does the reading and
// writing. Decisions (Florian, 2026-11-01): drafts go into the Import folder like everything else (D5), withdrawn items are skipped (D6).
import type { Route } from "../settings/schema";
import { studioItemUrl, type StudioAddress } from "./address";
import { ORIGIN_KEY, SENT_KEY, URL_KEY } from "./record";
import { STUB_KEY, stubProperty, type StubTarget } from "./stub";
import type { StudioItemKind, StudioListedItem } from "./types";

/** One item the import offers. */
export interface ImportCandidate {
  id: string;
  kind: StudioItemKind;
  status: "draft" | "public";
  version: number;
  dirty: boolean;
  contentMd: string;
  created: string;
  /** The first line of text, for the list. */
  title: string;
  /** Ticked when the window opens. False for an item the plugin cannot take over faithfully (images), with the reason. */
  preselected: boolean;
  caution: string | null;
  /** What the item is a reply to; the note gets it as `blyg_stub_of` (S10), so the next publish keeps the reply. */
  stubOf: StubTarget | null;
}

export interface ImportScan {
  candidates: ImportCandidate[];
  skipped: { withdrawn: number; ignored: number; unreadable: number };
}

// An image in Markdown or HTML: the plugin does not handle images yet (roadmap S6).
const IMAGE = /!\[[^\]\n]*\]\([^)\n]+\)|<img\b/i;
const DIRECTIVE = /^\s*!\[\[[^\]]*\]\]\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * The items that have no note: not withdrawn, not on the ignore list, and no note in the vault holds the id for this Studio. Fragments first,
 * then threads (a thread's embeds then find the fragment notes made just before), each oldest first.
 */
export function newItems(items: StudioListedItem[], opts: { hasNote: (id: string) => boolean; ignored: ReadonlySet<string>; unreadable?: number }): ImportScan {
  const skipped = { withdrawn: 0, ignored: 0, unreadable: opts.unreadable ?? 0 };
  const candidates: ImportCandidate[] = [];
  for (const item of items) {
    if (opts.hasNote(item.id)) continue;
    if (item.status === "withdrawn") {
      skipped.withdrawn++;
      continue;
    }
    if (opts.ignored.has(item.id)) {
      skipped.ignored++;
      continue;
    }
    const images = IMAGE.test(item.contentMd);
    candidates.push({
      id: item.id,
      kind: item.kind,
      status: item.status,
      version: item.version,
      dirty: item.dirty,
      contentMd: item.contentMd,
      created: item.created,
      title: firstLine(item.contentMd),
      preselected: !images,
      caution: images ? "Has images: the plugin does not handle images yet, so publishing this note again could change them." : null,
      stubOf: item.stubOf,
    });
  }
  const rank = (k: StudioItemKind): number => (k === "fragment" ? 0 : 1);
  candidates.sort((a, b) => rank(a.kind) - rank(b.kind) || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0) || (a.id < b.id ? -1 : 1));
  return { candidates, skipped };
}

/** The first line of prose: not a quote directive, a `>` line, a code fence or a rule; Markdown marks removed. "" when there is none. */
export function firstLine(contentMd: string): string {
  let inFence = false;
  for (const raw of contentMd.split("\n")) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || raw.trim() === "" || DIRECTIVE.test(raw) || /^\s*>/.test(raw) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    const text = raw
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/!?\[\[([^\]|]*?)\s*\|\s*([^\]]*)\]\]/g, "$2")
      .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__|~~|`|\*|_)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

const NAME_MAX = 60;

/** A file name from the first line: characters a note name cannot hold removed, at most 60 characters, cut at a word where it can be. */
export function baseName(contentMd: string, kind: StudioItemKind, id: string): string {
  let name = firstLine(contentMd)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (name.length > NAME_MAX) {
    const cut = name.slice(0, NAME_MAX);
    const space = cut.lastIndexOf(" ");
    name = space >= NAME_MAX / 2 ? cut.slice(0, space) : cut;
  }
  name = name.replace(/[\s.,;:!?-]+$/, "").trim();
  return name !== "" ? name : `${kind === "thread" ? "Thread" : "Fragment"} ${idTail(id)}`;
}

/** The end of the id: Studio ids begin with the time, so items made close together share their start, not their end. */
const idTail = (id: string): string => id.slice(-6);

/**
 * The note's name: the base name; on a clash (ignoring case: iOS and macOS file systems do) the base name with the end of the id, then with
 * the whole id; null when even that is taken. Derived from the item only, so two devices importing the same item choose the same name.
 */
export function noteName(contentMd: string, kind: StudioItemKind, id: string, taken: (name: string) => boolean): string | null {
  const base = baseName(contentMd, kind, id);
  for (const name of [base, `${base} (${idTail(id)})`, `${base} (${id})`]) if (!taken(name)) return name;
  return null;
}

/** The folder imported notes go to (D5: drafts too): the one chosen in the settings, else the first Studio folder that is not Drafts-only, else the first Studio folder. */
export function importRoute(routes: Route[], chosen: string): { ok: true; route: Route } | { ok: false; message: string } {
  const studio = routes.filter((r) => r.mode === "studio");
  if (chosen !== "") {
    const route = studio.find((r) => r.vaultPrefix === chosen);
    return route ? { ok: true, route } : { ok: false, message: `The Import folder “${chosen}” is not a Studio folder in the settings any more. Choose another one in Settings → Blyg → Studio.` };
  }
  const route = studio.find((r) => r.draftsOnly !== true) ?? studio[0];
  return route ? { ok: true, route } : { ok: false, message: "No folder publishes to the Studio: add a Studio folder in Settings → Blyg first." };
}

/**
 * The choices for the Import folder, in the settings and in the import window: every Studio folder (Drafts-only ones marked), read from the
 * routes as they are now. `current` is kept as a choice even when it is no longer a Studio folder, so the setting never shows a value it
 * does not list.
 */
export function importFolderChoices(routes: Route[], current: string): Array<{ value: string; label: string }> {
  const choices = routes
    .filter((r) => r.mode === "studio" && r.vaultPrefix !== "")
    .map((r) => ({ value: r.vaultPrefix, label: `${r.vaultPrefix}${r.draftsOnly === true ? " (Drafts only)" : ""}` }));
  if (current !== "" && !choices.some((c) => c.value === current)) choices.push({ value: current, label: `${current} (not a Studio folder any more)` });
  return choices;
}

/**
 * The properties of an imported note, as a send would have stamped them: the id with this Studio's origin, the kind for a thread, the version
 * the Studio is at (0 for a draft), the public address once published, and the hash of the Studio's working copy as "sent". A working copy
 * ahead of the published version reads like a draft sent from the plugin and not yet published.
 */
export function importProperties(c: Pick<ImportCandidate, "id" | "kind" | "version"> & { stubOf?: StubTarget | null }, address: StudioAddress, sentHash: string): Record<string, unknown> {
  return {
    ...(c.kind === "thread" && c.stubOf ? { [STUB_KEY]: stubProperty(c.stubOf) } : {}),
    blyg_id: c.id,
    [ORIGIN_KEY]: address.origin,
    ...(c.kind === "thread" ? { blyg_kind: "thread" } : {}),
    blyg_version: c.version,
    ...(c.version > 0 ? { [URL_KEY]: studioItemUrl(address, c.kind, c.id) } : {}),
    [SENT_KEY]: sentHash,
  };
}

/** The author's template properties a new note gets too (date, tags …): every key but the plugin's own `blyg_*` ones. */
export function templateExtras(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !key.startsWith("blyg_")));
}
