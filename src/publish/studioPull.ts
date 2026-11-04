// Take a Studio item's working copy into the note (roadmap S2.7; Florian, 2026-10-23: "sometimes the online draft should overwrite the local
// version"). The reverse of a publish, and just as careful: the window shows both texts first, nothing is sent to the Studio, and the note's
// record is marked afterwards so the panel stops saying "changed there". Ids in the Studio's text become note names again where a note of
// this Studio holds that id; every other id stays (ids stay valid).
import { localKind } from "../core/blyg";
import { contentHash } from "../core/hash";
import { normalizeContentMd } from "../core/normalize";
import { stripObsidianComments } from "../core/comments";
import { HttpError } from "../platform/http";
import type { NoteRef } from "../platform/ports";
import { studioItemUrl } from "../studio/address";
import { readStudioRecord, SENT_KEY } from "../studio/record";
import { namesFromIds, prepareStudioText } from "../studio/text";
import { M } from "./messages";
import { logError } from "./shared";
import { studioFailureOutcome } from "./studioFailure";
import { cancelled, failed, noop, refused, type Outcome, type PublishDeps, type WritePreview } from "./types";
import { stripFrontmatter } from "../core/frontmatter";
import { takeStudioHoppers } from "./studioHoppers";
import { readStubProperty, sameStubTarget, STUB_KEY, stubProperty, type StubTarget } from "../studio/stub";

/** `confirmed`: the user already chose "use the Studio's copy" in the publish's conflict window, which showed both texts. */
export async function pullStudio(deps: PublishDeps, note: NoteRef, opts: { confirmed?: boolean } = {}): Promise<Outcome> {
  const { settings, vault } = deps;
  const studio = deps.studio;
  if (!studio) return refused(deps.studioProblem ?? M.studioNotConfigured);
  if (!deps.edit) return failed(M.studioPullNoEdit);
  const { client, address } = studio;
  if (note.extension !== "md") return refused(M.notMarkdown(note.name));

  const declared = localKind(vault.frontmatterValue(note, "blyg_kind"));
  if ("invalid" in declared) return refused(M.unknownKind(declared.invalid));
  const found = readStudioRecord(vault, note, address.origin);
  if (found.kind === "invalid") return refused(M.studioInvalidRecord(found.problem));
  if (found.kind === "other") return refused(M.studioOtherRecord(found.id, found.origin));
  if (found.kind === "none") return refused(M.studioPullNoRecord);

  try {
    const got = await client.getItem(found.id);
    if (got.kind === "not-found") return refused(M.studioItemMissing(found.id, address.host));
    if (got.kind !== "ok") return studioFailureOutcome("Reading the Studio's copy", got);
    const item = got.value;
    const working = normalizeContentMd(item.contentMd);
    const workingHash = await contentHash(working);

    const raw = await vault.read(note);
    const current = stripFrontmatter(raw);
    const ctx = { vault, routes: settings.routes, fromPath: note.path, origin: address.origin, fragmentCharCap: settings.fragmentCharCap };
    const pulled = namesFromIds(working, ctx, deps.edit);
    // Same as what a publish would send? Then there is nothing to bring over (the record may only be out of date).
    const commented = stripObsidianComments(current);
    if (commented.ok) {
      const sendable = prepareStudioText(normalizeContentMd(commented.text), item.kind, ctx);
      if (sendable.problems.length === 0 && (await contentHash(sendable.contentMd)) === workingHash) {
        await mark(deps, note, item.version, item.dirty, workingHash, item.stubOf);
        return noop(M.studioPullSame);
      }
    }

    const lostComments = commented.ok ? commented.removed : 0;
    const lostIds = commented.ok ? commented.blockIds : [];
    // Without its own window (the conflict window's third choice) the ids are always written down: they must not vanish unseen.
    let appendIds = opts.confirmed === true && lostIds.length > 0;
    if (!opts.confirmed) {
      const preview: WritePreview = {
        action: "studio-pull",
        channel: "production",
        branch: address.host,
        path: studioItemUrl(address, item.kind, item.id),
        noteName: note.name,
        label: item.kind,
        id: item.id,
        before: normalizeContentMd(current),
        after: pulled.text,
        changes: [
          "The note’s text is replaced by the Studio’s working copy. The note’s properties stay.",
          "Nothing is sent to the Studio.",
          ...(pulled.named > 0 ? [`${pulled.named} link${pulled.named === 1 ? "" : "s"} to other items will show by note name.`] : []),
          ...(lostComments > 0 ? [`${lostComments} comment${lostComments === 1 ? "" : "s"} (%% … %%) in the note will be lost.`] : []),
          ...(lostIds.length > 0 ? [`${lostIds.length} block id${lostIds.length === 1 ? "" : "s"} (^…) in the note will be lost.`] : []),
        ],
        links: [],
        blygNote: false,
        commitMessage: "",
        ...(lostIds.length > 0 ? { blockIds: lostIds } : {}),
        studio: { host: address.host, html: "" },
      };
      const answer = await deps.confirm(preview);
      if (!answer) return cancelled(M.studioPullCancelled);
      appendIds = typeof answer === "object" && answer.appendIds === true && lostIds.length > 0;
    }

    // Keep the blank line a note usually has between its properties and its text.
    const lead = /^(\r?\n)*/.exec(current)?.[0] ?? "";
    try {
      const kept = `${lead}${pulled.text}${pulled.text.endsWith("\n") ? "" : "\n"}`;
      await deps.edit.replaceBody(note, current, appendIds ? `${kept}\n${idRecord(lostIds)}\n` : kept);
    } catch (err) {
      logError(deps, "replacing the note's text", err);
      return failed(M.studioPullChangedMeanwhile);
    }
    await mark(deps, note, item.version, item.dirty, workingHash, item.stubOf);
    const notices = [M.studioPullDone(item.id, pulled.named, pulled.left)];
    // The hoppers come along (S13): the note then says what the Studio says, text and collections. A failure here leaves them as they were.
    try {
      const taken = await takeStudioHoppers(deps, note, item.id);
      if (taken.ok && taken.changed) notices.push(M.hoppersTaken(taken.names));
    } catch (err) {
      logError(deps, "reading the item's hoppers after the pull (ignored)", err);
    }
    if (lostIds.length > 0) notices.push(M.studioPullIds(lostIds.length, appendIds));
    return { status: "published", notices, id: item.id, version: item.version };
  } catch (err) {
    logError(deps, "pulling the Studio's copy", err);
    return failed(err instanceof HttpError ? err.message : M.studioNetworkSafe);
  }
}

/**
 * The note now says what the Studio holds: so the Studio's working copy counts as "sent". When that copy is also what is published
 * (nothing waiting in the Studio), the version is brought up to date too. Never fails the pull.
 */
async function mark(deps: PublishDeps, note: NoteRef, version: number, dirty: boolean, workingHash: string, stubOf: StubTarget | null): Promise<void> {
  try {
    await deps.vault.updateFrontmatter(note, (fm) => {
      fm[SENT_KEY] = workingHash;
      // What the item answers comes along (S10). A note that names a reply target the Studio does not have yet keeps it: nothing is removed here.
      if (stubOf) {
        const had = readStubProperty(fm[STUB_KEY]);
        const label = had.ok && had.stub && sameStubTarget(had.stub, stubOf) ? had.stub.label : undefined;
        fm[STUB_KEY] = stubProperty({ ...stubOf, ...(label ? { label } : {}) });
      }
      if (!dirty && version > 0) fm.blyg_version = version;
    });
  } catch (err) {
    logError(deps, "marking the note after pulling the Studio's copy (ignored)", err);
  }
}

/** The removed ids as one private comment (it is never published): each id with the start of the paragraph it belonged to. A `%%` in an excerpt is broken up so the comment cannot end early. */
export function idRecord(ids: ReadonlyArray<{ id: string; excerpt: string }>): string {
  const items = ids.map((i) => `^${i.id}${i.excerpt ? ` (${i.excerpt.replace(/%%/g, "% %")})` : ""}`);
  return `%% Block ids removed when this note was replaced with the online text: ${items.join(", ")} %%`;
}
