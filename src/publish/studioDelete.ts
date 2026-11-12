// Delete a draft in a Studio: an item that was never published (version 0). A published item can only be withdrawn (protocol: a published id is
// 200 forever); the Studio refuses to delete it, and so does this, after asking the Studio first. The note keeps its text and loses its record.
import { localKind } from "../core/blyg";
import { normalizeContentMd } from "../core/normalize";
import { HttpError } from "../platform/http";
import type { NoteRef } from "../platform/ports";
import { studioItemUrl } from "../studio/address";
import { ORIGIN_KEY, readStudioRecord, SENT_KEY, sameOrigin, URL_KEY } from "../studio/record";
import { M } from "./messages";
import { logError } from "./shared";
import { studioFailureOutcome } from "./studioFailure";
import { withRevision } from "./studioRevision";
import { studioTextHash } from "../studio/media";
import { cancelled, failed, refused, type Outcome, type PublishDeps, type WritePreview } from "./types";

export async function deleteDraftStudio(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const { vault } = deps;
  const studio = deps.studio;
  if (!studio) return refused(deps.studioProblem ?? M.studioNotConfigured);
  const { client, address, pending } = studio;
  if (note.extension !== "md") return refused(M.notMarkdown(note.name));

  const declared = localKind(vault.frontmatterValue(note, "blyg_kind"));
  if ("invalid" in declared) return refused(M.unknownKind(declared.invalid));
  const record = readStudioRecord(vault, note, address.origin);
  if (record.kind === "invalid") return refused(M.studioInvalidRecord(record.problem));
  if (record.kind === "other") return refused(M.studioOtherRecord(record.id, record.origin));

  try {
    // The draft's id: the note's record, or the plugin's own memory of a draft it made for a note that was never stamped.
    let id: string | null = record.kind === "this" ? record.id : null;
    if (id === null) {
      const draft = await pending.get(note.path);
      if (draft && sameOrigin(draft.origin, address.origin)) id = draft.id;
    }
    if (id === null) return refused(M.studioNoDraftToDelete);

    const got = await client.getItem(id);
    if (got.kind === "not-found") {
      await pending.clear(note.path);
      return refused(M.studioItemMissing(id, address.host));
    }
    if (got.kind !== "ok") return studioFailureOutcome("Deleting the draft", got);
    const item = got.value;
    if (item.status !== "draft" || item.version !== 0) return refused(M.studioDraftPublished(item.id));

    const kind = item.kind;
    const preview: WritePreview = {
      action: "delete-draft",
      channel: "production",
      branch: address.host,
      path: studioItemUrl(address, kind, item.id),
      noteName: note.name,
      label: kind,
      id: item.id,
      before: normalizeContentMd(item.contentMd),
      after: "",
      changes: [
        "The draft is deleted from the Studio. It was never published, so nothing public changes.",
        "The note in your vault keeps its text; only its Studio record (blyg_id and the related properties) is removed.",
      ],
      links: [],
      blygNote: false,
      commitMessage: "",
      studio: { host: address.host, html: "" },
    };
    if (!(await deps.confirm(preview))) return cancelled(M.studioCancelled);

    const deleted = await withRevision(client, item.id, item.revision, await studioTextHash(item.contentMd), (rev) => client.deleteItem(item.id, rev));
    if (deleted.kind === "changed-there") return failed(M.studioChangedWhilePublishing(item.id));
    // Gone already is as good as deleted; anything else (a 409 because it was published meanwhile) stops here with the note untouched.
    if (deleted.kind !== "ok" && deleted.kind !== "not-found") return studioFailureOutcome("Deleting the draft", deleted);

    try {
      await vault.updateFrontmatter(note, (fm) => {
        for (const key of ["blyg_id", "blyg_version", "blyg_withdrawn", ORIGIN_KEY, SENT_KEY, URL_KEY]) delete fm[key];
      });
    } catch (err) {
      logError(deps, "removing the note's record after deleting its draft", err);
      return { status: "published", notices: [M.studioDraftDeleted(item.id), "The note's own record could not be removed: delete blyg_id, blyg_origin, blyg_version, blyg_sent and blyg_url from its properties by hand."], id: item.id };
    }
    try {
      await pending.clear(note.path);
    } catch (err) {
      logError(deps, "clearing the draft record (ignored)", err);
    }
    return { status: "published", notices: [M.studioDraftDeleted(item.id)], id: item.id };
  } catch (err) {
    logError(deps, "deleting a draft in the Studio", err);
    return failed(err instanceof HttpError ? err.message : M.studioNetworkSafe);
  }
}
