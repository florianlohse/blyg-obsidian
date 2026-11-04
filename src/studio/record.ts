// What a note says about its Studio item (docs/plans/S2-studio-client.md decisions 5 and 6): the `blyg_*` properties the plugin
// already uses, plus `blyg_origin` (which blyg the id belongs to) and `blyg_sent` (the hash of the text last sent). The id is only
// meaningful together with its origin: an id with another or no origin is the old GitHub record, or another Studio's.
import { isBlygId } from "../core/ids";
import type { NoteRef, VaultPort } from "../platform/ports";

export const ORIGIN_KEY = "blyg_origin";
export const SENT_KEY = "blyg_sent";
export const URL_KEY = "blyg_url";

export type StudioRecord =
  | { kind: "none" }
  /** The id belongs to this Studio. `version` and `sent` are what the last successful publish stamped (null: missing or unreadable). */
  | { kind: "this"; id: string; version: number | null; sent: string | null; withdrawn: boolean }
  /** An id with no origin (the GitHub record) or another origin (another Studio): not this Studio's item. */
  | { kind: "other"; id: string; origin: string | null }
  | { kind: "invalid"; problem: string };

/** Origins compare as URLs, so "https://x.example/" and "https://X.example" are one blyg. Unparseable text compares as itself. */
export function sameOrigin(a: string, b: string): boolean {
  const norm = (s: string): string => {
    try {
      return new URL(s).href;
    } catch {
      return s.trim();
    }
  };
  return norm(a) === norm(b);
}

export function readStudioRecord(vault: Pick<VaultPort, "blygId" | "frontmatterValue">, note: NoteRef, thisOrigin: string): StudioRecord {
  const rawId = vault.blygId(note);
  const rawOrigin = vault.frontmatterValue(note, ORIGIN_KEY);
  const hasId = rawId !== undefined && rawId !== null && rawId !== "" && rawId !== false;
  const hasOrigin = typeof rawOrigin === "string" && rawOrigin.trim() !== "";
  if (!hasId && !hasOrigin) return { kind: "none" };
  if (!hasId) return { kind: "invalid", problem: "the note has a blyg_origin but no blyg_id" };
  if (!isBlygId(rawId)) return { kind: "invalid", problem: `blyg_id “${typeof rawId === "string" ? rawId.slice(0, 40) : JSON.stringify(rawId)}” is not a valid Blyg id` };
  if (!hasOrigin) return { kind: "other", id: rawId, origin: null };
  if (!sameOrigin(rawOrigin, thisOrigin)) return { kind: "other", id: rawId, origin: rawOrigin };
  const version = vault.frontmatterValue(note, "blyg_version");
  const sent = vault.frontmatterValue(note, SENT_KEY);
  return {
    kind: "this",
    id: rawId,
    version: typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : null,
    sent: typeof sent === "string" && sent !== "" ? sent : null,
    withdrawn: vault.frontmatterValue(note, "blyg_withdrawn") === true,
  };
}
