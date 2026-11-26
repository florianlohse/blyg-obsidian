// HK3 Marginalia: the reception rows of a note, in the groups the Reception section shows. Pure.
import type { ReceptionRow } from "./reception";

export type ReceptionGroupId = "paragraph" | "whole" | "replies" | "earlier" | "unknown";

export interface ReceptionGroup {
  id: ReceptionGroupId;
  title: string;
  rows: ReceptionRow[];
}

const ORDER: ReceptionGroupId[] = ["paragraph", "whole", "replies", "earlier", "unknown"];
const TITLES: Record<ReceptionGroupId, string> = { paragraph: "Quoted a paragraph", whole: "Quoted the whole note", replies: "Replies", earlier: "From an earlier version", unknown: "Could not be read" };

/** A reply is a reply wherever its quote sits (its relation is `stub`); every other row goes by where its quote is. A post that could not be read stays unread, whatever it is. */
export function groupOf(row: ReceptionRow): ReceptionGroupId {
  const p = row.placement;
  if (p.kind === "unknown") return "unknown";
  if (p.kind === "reply" || row.mention.relation === "stub") return "replies";
  return p.kind === "paragraph" ? "paragraph" : p.kind;
}

/** The non-empty groups in their fixed order, each with its rows in the order given (newest first). */
export function groupReception(rows: ReceptionRow[]): ReceptionGroup[] {
  const by = new Map<ReceptionGroupId, ReceptionRow[]>();
  for (const r of rows) {
    const id = groupOf(r);
    by.set(id, [...(by.get(id) ?? []), r]);
  }
  return ORDER.flatMap((id) => (by.has(id) ? [{ id, title: TITLES[id], rows: by.get(id)! }] : []));
}
