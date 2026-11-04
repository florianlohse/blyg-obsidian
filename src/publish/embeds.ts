// Names in the vault, ids on the wire (decided with Florian, 2026-10-10, after he saw `![[<26-character id>]]` stay unresolved
// in Obsidian's editor and Reading view).
//
// In the vault a quote of another Blyg note is an ordinary Obsidian embed, `![[Note name]]`, so Obsidian shows the note itself and
// follows renames. At publish this module translates it to the protocol's directive `![[<blyg_id>]]`; an inline `[[Note name]]`
// that names a Blyg note becomes the plain item link `[[<blyg_id>]]`. Everything after this step (the grammar scan, the snapshots,
// the committed bytes) sees only ids, so the wire format and the contract are unchanged, and a note that already uses ids keeps
// working. Translation keeps every line where it was, so line numbers in messages match the note.
import { isBlygId } from "../core/ids";
import { routeFor } from "../core/routes";
import type { NoteRef, VaultPort } from "../platform/ports";
import type { Route } from "../settings/schema";
import { M } from "./messages";

/** An id, or an id with an explicit version: written as ids already, left for the grammar scan to judge. */
const ID_FORM = /^[0-9a-hjkmnp-tv-z]{26}(?:@v\d+)?$/;
const EMBED_LINE = /^\s*!\[\[([^[\]\n]+)\]\]\s*$/;
const INLINE_LINK = /\[\[([^[\]|#^\n]+)\]\]/g;

export interface TranslatedEmbeds {
  text: string;
  /** What stops the publish (each says which line), empty when the text may go on. */
  problems: string[];
  /** How many names were turned into ids. */
  count: number;
}

type Lookup = { kind: "id"; id: string } | { kind: "problem"; message: string } | { kind: "leave" };

const noteRefOf = (path: string, extension: string): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension });

export function translateNameEmbeds(contentMd: string, ctx: { vault: VaultPort; routes: Route[]; fromPath: string }): TranslatedEmbeds {
  const { vault, routes, fromPath } = ctx;
  const problems: string[] = [];
  let count = 0;

  /** `embed`: the target was written as an embed on its own line; only there is a note that is not a Blyg note a problem. */
  const lookup = (target: string, embed: boolean): Lookup => {
    const resolved = vault.resolveLink(target, fromPath);
    if (!resolved || resolved.extension !== "md") return { kind: "leave" };
    const route = routeFor(routes, resolved.path);
    if (!route) return { kind: "leave" }; // not in a publish folder: the link check has its say
    if (route.mode !== "blyg") return embed ? { kind: "problem", message: M.embedNotBlyg(target) } : { kind: "leave" };
    const ref = noteRefOf(resolved.path, resolved.extension);
    if (vault.frontmatterValue(ref, "blyg_withdrawn") === true) return { kind: "problem", message: M.embedWithdrawn(target) };
    const id = vault.blygId(ref);
    return isBlygId(id) ? { kind: "id", id } : { kind: "problem", message: M.embedNotPublished(target) };
  };

  const lines = contentMd.split("\n").map((line, i) => {
    const where = `line ${i + 1}`;
    const embed = EMBED_LINE.exec(line);
    if (embed) {
      const inner = (embed[1] ?? "").trim();
      if (ID_FORM.test(inner)) return line;
      const target = (inner.split(/[|#^]/)[0] ?? "").trim();
      if (target === "") return line;
      const found = lookup(target, true);
      if (found.kind === "leave") return line;
      if (found.kind === "problem") {
        problems.push(`${where}: ${found.message}`);
        return line;
      }
      if (/[|#^]/.test(inner)) {
        problems.push(`${where}: ${M.embedForm(inner)}`);
        return line;
      }
      count++;
      return `![[${found.id}]]`;
    }
    // Inline `[[Name]]` (the bare form; an alias, heading or block is not an item link). A leading `!` is an inline embed: plain text.
    return line.replace(INLINE_LINK, (whole, name: string, at: number) => {
      if (line[at - 1] === "!" || ID_FORM.test(name.trim())) return whole;
      const found = lookup(name.trim(), false);
      if (found.kind === "leave") return whole;
      if (found.kind === "problem") {
        problems.push(`${where}: ${found.message}`);
        return whole;
      }
      count++;
      return `[[${found.id}]]`;
    });
  });

  return { text: lines.join("\n"), problems, count };
}
