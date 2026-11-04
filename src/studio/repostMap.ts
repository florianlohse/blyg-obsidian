// The map from the old blyg's items to their reposts in the Studio (roadmap S3.1): what the site's redirect rules need on the day of the
// move, and what exists only in the vault (each reposted note keeps the old record as `blyg_previous` and holds the new id). Pure.
import { itemPagePath } from "../contract";
import { isBlygId } from "../core/ids";
import type { StudioAddress } from "./address";
import { ORIGIN_KEY, sameOrigin, URL_KEY } from "./record";

export interface RepostLine {
  kind: "fragment" | "thread";
  oldId: string;
  newId: string;
  /** The old item's page address, or null when neither the record nor the settings know its origin. */
  oldPage: string | null;
  newPage: string;
  name: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** One line per note of this Studio that was reposted (it has a `blyg_previous` with an id), sorted by note name. `oldOrigin` is the old blyg's address from the settings, for a record that never stored one. */
export function repostMap(notes: { name: string; frontmatter: Record<string, unknown> }[], address: StudioAddress, oldOrigin: string): RepostLine[] {
  const lines: RepostLine[] = [];
  for (const note of notes) {
    const fm = note.frontmatter;
    const origin = fm[ORIGIN_KEY];
    if (typeof origin !== "string" || !sameOrigin(origin, address.origin) || !isBlygId(fm.blyg_id)) continue;
    const previous = asRecord(fm.blyg_previous);
    if (!previous || !isBlygId(previous.id)) continue;
    const kind = fm.blyg_kind === "thread" ? "thread" : "fragment";
    const from = typeof previous.origin === "string" && previous.origin !== "" ? previous.origin : oldOrigin;
    const oldPage =
      typeof previous.url === "string" && previous.url !== ""
        ? previous.url
        : from !== ""
          ? `${from.endsWith("/") ? from : `${from}/`}${itemPagePath(kind, previous.id)}`
          : null;
    const newPage = typeof fm[URL_KEY] === "string" && fm[URL_KEY] !== "" ? fm[URL_KEY] : `${address.origin}${itemPagePath(kind, fm.blyg_id)}`;
    lines.push({ kind, oldId: previous.id, newId: fm.blyg_id, oldPage, newPage, name: note.name });
  }
  return lines.sort((a, b) => a.name.localeCompare(b.name));
}

/** The text to copy: a header, then `kind old-id new-id old-page new-page # note name` per line (the name last, because it may hold spaces). */
export function repostMapText(lines: RepostLine[], studioOrigin: string): string {
  const head = `# Reposted items: kind old-id new-id old-page new-page # note name. Studio ${studioOrigin}`;
  return [head, ...lines.map((l) => `${l.kind} ${l.oldId} ${l.newId} ${l.oldPage ?? "-"} ${l.newPage} # ${l.name}`)].join("\n");
}
