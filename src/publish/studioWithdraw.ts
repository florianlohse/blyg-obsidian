// Withdraw an item that lives in a Studio (docs/plans/S2-studio-client.md §4.4; spec §9: a withdrawal is an endcap, never a delete). The
// Studio makes the endcap itself; the note keeps its text and is marked only after the Studio confirmed.
import { localKind } from "../core/blyg";
import { routeFor } from "../core/routes";
import { HttpError } from "../platform/http";
import type { NoteRef } from "../platform/ports";
import { studioItemUrl } from "../studio/address";
import { readStudioRecord } from "../studio/record";
import type { StudioItemKind } from "../studio/types";
import { M } from "./messages";
import { cleanNote, studioFailureOutcome } from "./studio";
import { withRevision } from "./studioRevision";
import { studioTextHash } from "../studio/media";
import { logError } from "./shared";
import { cancelled, failed, noop, refused, type Outcome, type PublishDeps, type WritePreview } from "./types";
import { normalizeContentMd } from "../core/normalize";

export async function withdrawStudio(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const { vault } = deps;
  const studio = deps.studio;
  if (!studio) return refused(deps.studioProblem ?? M.studioNotConfigured);
  const { client, address } = studio;
  if (note.extension !== "md") return refused(M.notMarkdown(note.name));
  // A withdrawal is a public change: a drafts-only folder never makes one.
  const route = routeFor(deps.settings.routes, note.path);
  if (route?.mode === "studio" && route.draftsOnly === true) return refused(M.studioDraftsOnlyNoWithdraw);

  const declared = localKind(vault.frontmatterValue(note, "blyg_kind"));
  if ("invalid" in declared) return refused(M.unknownKind(declared.invalid));
  const record = readStudioRecord(vault, note, address.origin);
  if (record.kind === "none") return refused(M.noIdToWithdraw);
  if (record.kind === "invalid") return refused(M.studioInvalidRecord(record.problem));
  if (record.kind === "other") return refused(M.studioOtherRecord(record.id, record.origin));

  try {
    const got = await client.getItem(record.id);
    if (got.kind === "not-found") return refused(M.studioItemMissing(record.id, address.host));
    if (got.kind !== "ok") return studioFailureOutcome("Withdrawing", got);
    const item = got.value;
    const kind: StudioItemKind = item.kind;
    if (item.status === "withdrawn") {
      // Withdrawn already (there, or by an earlier try whose stamp failed): only the note's own mark may be missing.
      if (!record.withdrawn) await mark(deps, note, item.version);
      return noop(M.alreadyWithdrawn);
    }
    if (item.status === "draft" || item.version === 0) return refused(M.studioNothingToWithdraw(item.id));

    const url = studioItemUrl(address, kind, item.id);
    const preview: WritePreview = {
      action: "withdraw",
      channel: "production",
      branch: address.host,
      path: url,
      noteName: note.name,
      label: kind,
      id: item.id,
      fromVersion: item.version,
      toVersion: item.version + 1,
      before: item.published ? normalizeContentMd(item.published.contentMd) : null,
      after: "",
      changes: [
        `Version ${item.version} → ${item.version + 1}`,
        "Marked as withdrawn; the published text is emptied",
        `The address stays up as “withdrawn” for good: ${url}`,
        "The note in your vault keeps its text",
      ],
      links: [],
      blygNote: false,
      commitMessage: "",
      studio: { host: address.host, html: "", askNote: true },
    };
    const answer = await deps.confirm(preview);
    if (!answer) return cancelled(M.studioWithdrawCancelled);
    const changeNote = typeof answer === "object" ? cleanNote(answer.note) : undefined;

    const done = await withRevision(client, item.id, item.revision, await studioTextHash(item.contentMd), (rev) => client.withdraw(item.id, changeNote, rev));
    if (done.kind === "changed-there") return failed(M.studioChangedWhilePublishing(item.id));
    if (done.kind !== "ok") return studioFailureOutcome("Withdrawing", done);
    const outcome: Outcome = { status: "published", notices: [M.studioWithdrawn(done.value.version, url)], id: item.id, version: done.value.version };
    try {
      await mark(deps, note, done.value.version);
    } catch (err) {
      logError(deps, "writing local frontmatter after a successful Studio withdraw", err);
      return { ...outcome, notices: [M.studioWithdrawStampFailed(item.id, done.value.version)], localStampFailed: true };
    }
    return outcome;
  } catch (err) {
    logError(deps, "withdrawing in the Studio", err);
    return failed(err instanceof HttpError ? err.message : M.studioNetworkSafe);
  }
}

async function mark(deps: PublishDeps, note: NoteRef, version: number): Promise<void> {
  await deps.vault.updateFrontmatter(note, (fm) => {
    fm.blyg_version = version;
    fm.blyg_withdrawn = true;
  });
}
