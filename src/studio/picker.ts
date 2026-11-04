// The Studio quote picker's data (docs/plans/S2-studio-client.md §4.5, decisions 9 and 10): the notes of this Studio that are in the vault
// (written by name, as always), and everything the Studio's search offers (own items that have no note here, and items of the blygs the
// owner reads, written as `id | label`). Pure: the window is src/ui/StudioPicker.ts, the network is src/studio/client.ts.
import type { PickerCandidate, PickerEntry } from "../app/threadCommands";
import { pickerCandidates } from "../app/threadCommands";
import { cleanLabel } from "./text";
import { sameOrigin } from "./record";
import type { StudioHit, StudioItemKind } from "./types";

export interface StudioPick {
  /** vault — a note of this Studio in the vault (written by its name); studio — written as `id | label`. */
  source: "vault" | "studio";
  id: string;
  kind: StudioItemKind | null;
  /** The first line of the row. */
  title: string;
  /** The second line: where it comes from. */
  detail: string;
  /** vault: the note's path and name. */
  path?: string;
  name?: string;
  /** studio: the subscription an imported item belongs to (null: one of this Studio's own items). */
  subscriptionId: string | null;
  /** What goes after the bar: the Studio's own label, prefixed with the blyg's title for an item of another blyg. */
  label: string;
  /** The blyg the item belongs to: null for this Studio's own items; absent when not known yet (a search row: asked when a reply needs it). */
  origin?: string | null;
  /** The version the picker saw; a reply names it. */
  version?: number | null;
  /** False for an item of a blyg this Studio does not read (found by its address): it can be answered but not quoted or linked (quoting follows reading, spec §10.2). */
  quotable?: boolean;
}

/** A note of the vault as the picker reads it: `blyg_origin` says which blyg its id belongs to. */
export interface StudioVaultNote extends PickerEntry {
  frontmatter: PickerEntry["frontmatter"] & { blyg_origin?: unknown; blyg_kind?: unknown };
}

/** The vault's notes that belong to this Studio (their id is this Studio's item), not withdrawn, other than the open one. */
export function vaultPicks(notes: StudioVaultNote[], opts: { activePath: string | undefined; origin: string }): StudioPick[] {
  const mine = notes.filter((n) => typeof n.frontmatter.blyg_origin === "string" && sameOrigin(n.frontmatter.blyg_origin, opts.origin));
  const kinds = new Map(mine.map((n) => [n.path, n.frontmatter.blyg_kind === "thread" ? "thread" : "fragment"] as const));
  return pickerCandidates(mine, { activePath: opts.activePath, channel: "production" }).map((c: PickerCandidate): StudioPick => ({
    source: "vault",
    id: c.id,
    kind: kinds.get(c.path) ?? null,
    title: c.excerpt === "" ? c.name : c.excerpt,
    detail: `Your note “${c.name}”`,
    path: c.path,
    name: c.name,
    subscriptionId: null,
    label: cleanLabel(c.excerpt === "" ? c.name : c.excerpt),
    origin: null,
  }));
}

/** One hit of the Studio's search as a row. */
export function hitPick(hit: StudioHit): StudioPick {
  const own = hit.source === "mine";
  const text = hit.label !== "" ? hit.label : hit.excerpt;
  return {
    source: "studio",
    id: hit.id,
    kind: hit.kind,
    title: hit.excerpt !== "" ? hit.excerpt : text,
    detail: own ? `In your Studio · ${hit.kind}` : `${hit.sourceTitle ?? "Another blyg"} · ${hit.kind}`,
    subscriptionId: own ? null : hit.subscriptionId,
    label: cleanLabel(!own && hit.sourceTitle ? `${hit.sourceTitle}: ${text}` : text),
    ...(own ? { origin: null } : {}),
    version: hit.version,
  };
}

/** Vault rows that match what was typed (every word, anywhere in the row), in their order. */
export function filterVault(picks: StudioPick[], query: string): StudioPick[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return picks;
  return picks.filter((p) => {
    const hay = `${p.title} ${p.name ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Vault notes first (they read as names), then what the search found that the vault does not already show. */
export function mergePicks(vault: StudioPick[], found: StudioPick[]): StudioPick[] {
  const known = new Set(vault.map((p) => p.id));
  return [...vault, ...found.filter((p) => !known.has(p.id))];
}

/**
 * What stands between `![[` and `]]` (or `[[` and `]]`) for a pick: the note's link text for a vault note, `id | label` for the rest.
 * `linkText` is what Obsidian links the note by (its name, or its path when the name is ambiguous).
 */
export function writtenRef(pick: StudioPick, linkText: string): string {
  return pick.source === "vault" ? linkText : pick.label === "" ? pick.id : `${pick.id} | ${pick.label}`;
}
