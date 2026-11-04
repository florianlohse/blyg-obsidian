// Import from the Studio (roadmap S7): make notes for the owner's Studio items that have none (written in the Studio's own editor, or lost
// from the vault). The reverse of a first publish: nothing is sent to the Studio; each new note says afterwards what a send would have
// stamped, so the panel reads "up to date" and the next publish has nothing to send. An existing note is never touched.
import { buildBlygFileText } from "../core/frontmatter";
import { contentHash } from "../core/hash";
import { normalizeContentMd } from "../core/normalize";
import { HttpError } from "../platform/http";
import type { Logger, NoteEditPort, NoteRef, VaultPort, Yaml } from "../platform/ports";
import type { Route } from "../settings/schema";
import type { StudioAddress } from "../studio/address";
import type { StudioClient } from "../studio/client";
import { importProperties, importRoute, newItems, noteName, templateExtras, type ImportCandidate, type ImportScan } from "../studio/import";
import { namesFromIds, type DraftContext } from "../studio/text";
import { M } from "./messages";
import { studioFailureOutcome } from "./studioFailure";
import type { Outcome } from "./types";

/** Creating notes: the one write the import makes. */
export interface NoteFiles {
  /** A note with this vault path exists, ignoring case (iOS and macOS file systems do). */
  exists(path: string): boolean;
  /** Creates the folder (and its parents) when it is missing. */
  ensureFolder(path: string): Promise<void>;
  /** Creates a new note; throws when the path is taken. */
  create(path: string, text: string): Promise<NoteRef>;
}

export interface ImportDeps {
  client: StudioClient;
  address: StudioAddress;
  routes: Route[];
  /** Settings → Studio → Import folder: a Studio route's folder, or "" for the default. */
  importFolder: string;
  fragmentCharCap: number;
  vault: VaultPort;
  edit: NoteEditPort;
  yaml: Yaml;
  files: NoteFiles;
  /** The properties of the author's template for the kind, placeholders filled; {} without one. Only non-`blyg_` keys are used. */
  templateProps?: (kind: "fragment" | "thread", title: string) => Promise<Record<string, unknown>>;
  logger?: Logger;
}

export type ScanResult = { ok: true; scan: ImportScan; route: Route; complete: boolean } | { ok: false; outcome: Outcome };

/** Which items have no note. Reads the Studio's list; writes nothing. */
export async function scanStudioImport(deps: ImportDeps, ignored: ReadonlySet<string>): Promise<ScanResult> {
  const target = importRoute(deps.routes, deps.importFolder);
  if (!target.ok) return { ok: false, outcome: { status: "refused", notices: [target.message] } };
  try {
    const listed = await deps.client.listItems();
    if (listed.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Reading the Studio's items", listed) };
    // Any note holding the id counts, whatever its origin: two notes with one id would make a publish refuse both.
    const hasNote = (id: string): boolean => deps.edit.notesWithBlygId(id).some((n) => n.extension === "md");
    const scan = newItems(listed.value.items, { hasNote, ignored, unreadable: listed.value.unreadable });
    return { ok: true, scan, route: target.route, complete: listed.value.complete };
  } catch (err) {
    deps.logger?.warn(`reading the Studio's items failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, outcome: { status: "failed", notices: [err instanceof HttpError ? err.message : M.studioImportUnreachable] } };
  }
}

/**
 * Make one note per chosen item in the route's folder, fragments before threads, and say what was made. A failure stops the run; the notes
 * made before it stay (each is complete on its own) and the message names them.
 */
export async function importStudioItems(deps: ImportDeps, chosen: ImportCandidate[], route: Route): Promise<Outcome & { created: NoteRef[] }> {
  const created: NoteRef[] = [];
  const folder = route.vaultPrefix;
  const order = [...chosen].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "fragment" ? -1 : 1));

  // Notes made in this run, by path: the metadata cache learns their properties only later, so the name mapping reads them from here.
  const madeByPath = new Map<string, Record<string, unknown>>();
  const madeById = new Map<string, NoteRef>();
  const vault: VaultPort = {
    ...deps.vault,
    blygId: (n) => (madeByPath.has(n.path) ? madeByPath.get(n.path)?.blyg_id : deps.vault.blygId(n)),
    frontmatterValue: (n, key) => (madeByPath.has(n.path) ? madeByPath.get(n.path)?.[key] : deps.vault.frontmatterValue(n, key)),
  };
  const edit: NoteEditPort = {
    ...deps.edit,
    notesWithBlygId: (id) => {
      const known = deps.edit.notesWithBlygId(id).filter((n) => !madeByPath.has(n.path));
      const made = madeById.get(id);
      return made ? [...known, made] : known;
    },
  };
  const takenNames = new Set<string>();
  const taken = (name: string): boolean => takenNames.has(name.toLowerCase()) || deps.files.exists(`${folder}${name}.md`);

  let named = 0;
  let skipped = 0;
  try {
    if (folder !== "") await deps.files.ensureFolder(folder.replace(/\/+$/, ""));
    for (const c of order) {
      // Re-checked here: another device may have imported it meanwhile (data.json and notes sync).
      if (deps.edit.notesWithBlygId(c.id).some((n) => n.extension === "md") || madeById.has(c.id)) {
        skipped++;
        continue;
      }
      const name = noteName(c.contentMd, c.kind, c.id, taken);
      if (name === null) {
        skipped++;
        continue;
      }
      const path = `${folder}${name}.md`;
      const working = normalizeContentMd(c.contentMd);
      const ctx: DraftContext = { vault, routes: deps.routes, fromPath: path, origin: deps.address.origin, fragmentCharCap: deps.fragmentCharCap };
      const text = namesFromIds(working, ctx, edit);
      named += text.named;
      const props = importProperties(c, deps.address, await contentHash(working));
      const extras = deps.templateProps ? templateExtras(await deps.templateProps(c.kind, name)) : {};
      const ref = await deps.files.create(path, buildBlygFileText(deps.yaml, { ...extras, ...props }, text.text));
      takenNames.add(name.toLowerCase());
      madeByPath.set(ref.path, props);
      madeById.set(c.id, ref);
      created.push(ref);
    }
  } catch (err) {
    deps.logger?.warn(`creating an imported note failed: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "failed", notices: [M.studioImportFailed(created.length, folder)], created };
  }
  if (created.length === 0) return { status: "noop", notices: [M.studioImportNothing(skipped)], created };
  const notices = [M.studioImportDone(created.length, folder, named)];
  if (skipped > 0) notices.push(M.studioImportSkipped(skipped));
  return { status: "published", notices, created };
}
