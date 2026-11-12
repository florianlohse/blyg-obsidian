// Publish a note of a route in mode "studio" through a Blygger Studio's owner API (docs/plans/S2-studio-client.md §4.3).
//
// The order differs from the plan on one point, on purpose: Studio's preview takes the text itself, so the preview and the user's
// confirmation come BEFORE anything is written to the Studio. A cancel therefore leaves the Studio exactly as it was, and no draft
// is created for a note that was never published. Writes then go: create or update the working copy, publish, and only after
// Studio confirmed the publish, stamp the note (CLAUDE.md §3: the local note changes only after the remote write succeeded).
import { itemPagePath } from "../contract";
import { localKind } from "../core/blyg";
import { stripFrontmatter } from "../core/frontmatter";
import { sha256HexBytes } from "../core/hash";
import { canonicalizeStudioMedia, IMAGE_MIME, withStudioAddresses } from "../core/images";
import { normalizeContentMd } from "../core/normalize";
import { routeFor } from "../core/routes";
import { HttpError } from "../platform/http";
import type { NoteRef } from "../platform/ports";
import { studioItemUrl } from "../studio/address";
import { ORIGIN_KEY, readStudioRecord, SENT_KEY, sameOrigin, URL_KEY, type StudioRecord } from "../studio/record";
import { readStubProperty, sameStubTarget, STUB_KEY, stubLabel } from "../studio/stub";
import { localStudioHash, resolveImages, studioTextHash, type ResolvedImage } from "../studio/media";
import { prepareStudioText, refusalFor } from "../studio/text";
import type { StudioItem, StudioItemKind } from "../studio/types";
import { M } from "./messages";
import { fileProperty, logError, stripComments } from "./shared";
import { studioFailureOutcome } from "./studioFailure";
import { pullStudio } from "./studioPull";
import { withRevision } from "./studioRevision";
import { applyHoppers, hopperLines, hoppersOnly, planHoppers } from "./studioHoppers";
import { cancelled, failed, noop, refused, type Outcome, type PublishDeps, type StudioQuoteLine, type WritePreview } from "./types";

/** The change note a user typed: trimmed and kept short; empty means no note. */
const NOTE_MAX = 500;
export const cleanNote = (text: string): string | undefined => {
  const note = text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  return note === "" ? undefined : note;
};

export { studioFailureOutcome } from "./studioFailure";

const hashOfWorkingCopy = (item: StudioItem): Promise<string> => studioTextHash(item.contentMd);
/** A text as the confirmation window shows it: pictures are written in the one form that note and Studio share, so a picture that did not change is not a change. */
const shown = (md: string): string => normalizeContentMd(canonicalizeStudioMedia(md));
const sizeLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const imageLines = (images: ResolvedImage[], noun: string): string[] =>
  images.length === 0 ? [] : [`${images.length === 1 ? "1 image" : `${images.length} images`} uploaded with this ${noun}: ${images.map((i) => `${i.name} (${sizeLabel(i.size)})`).join(", ")}.`];

/**
 * Publish a note to the Studio. With `repost` the note carries the record of ANOTHER blyg (the old GitHub one, or another Studio's): its
 * text is published as a new item, with a new id and today's date, and only after the Studio confirmed is the old record moved into
 * `blyg_previous` (docs/plans/S2-studio-client.md §4.6). The old item is not touched.
 */
export async function publishStudio(deps: PublishDeps, note: NoteRef, opts: { repost?: boolean } = {}): Promise<Outcome> {
  const { settings, vault } = deps;
  const studio = deps.studio;
  if (!studio) return refused(deps.studioProblem ?? M.studioNotConfigured);
  const { client, address, pending } = studio;

  if (note.extension !== "md") return refused(M.notMarkdown(note.name));

  const declared = localKind(await fileProperty(deps, note, "blyg_kind"));
  if ("invalid" in declared) return refused(M.unknownKind(declared.invalid));
  const kind: StudioItemKind = declared.kind;
  // A reply (S10): the note names what it answers. Checked before any request; only a thread can be a reply (the Studio refuses otherwise).
  const stubRead = readStubProperty(await fileProperty(deps, note, STUB_KEY));
  if (!stubRead.ok) return refused(M.stubInvalid(stubRead.problem));
  const stub = stubRead.stub;
  if (stub !== null && kind !== "thread") return refused(M.stubNeedsThread);
  /** The note's reply target is not what the item holds: it is sent with the text (the Studio bakes the version itself). */
  const stubDiffers = (it: StudioItem | null): boolean => stub !== null && !sameStubTarget(stub, it?.stubOf ?? null);
  // A drafts-only route sends the text to the Studio's working copy and stops: no publish, no repost, no withdrawal (docs/plans/S12-studio-per-route.md).
  const route = routeFor(settings.routes, note.path);
  const draftsOnly = route?.mode === "studio" && route.draftsOnly === true;
  if (draftsOnly && opts.repost) return refused(M.studioDraftsOnlyNoRepost);

  const found = readStudioRecord(vault, note, address.origin);
  if (found.kind === "invalid") return refused(M.studioInvalidRecord(found.problem));
  if (opts.repost) {
    if (found.kind === "this") return refused(M.studioRepostNotNeeded(found.id));
    if (found.kind === "none") return refused(M.studioRepostNothing);
  } else if (found.kind === "other") {
    return refused(M.studioOtherRecord(found.id, found.origin));
  }
  /** The other blyg's record, when reposting. From here on the note counts as one with no record of this Studio. */
  const repost = opts.repost && found.kind === "other" ? { id: found.id, origin: found.origin ?? (settings.origin || null), version: vault.frontmatterValue(note, "blyg_version") } : null;
  const record: StudioRecord = repost ? { kind: "none" } : found;

  // ---- the text, checked locally before any request ------------------------------------------------------------------------
  const stripped = stripComments(stripFrontmatter(await vault.read(note)));
  if (!stripped.ok) return stripped.outcome;
  // Pictures first: a note's embedded images become `![alt](blyg-media:<sha256>)`, the form the Studio's copy is compared in (core/images.ts).
  const resolved = await resolveImages(normalizeContentMd(stripped.text), { vault, binary: deps.images, fromPath: note.path, folder: routeFor(settings.routes, note.path)?.vaultPrefix ?? "", ...(deps.imageDigests ? { cache: deps.imageDigests } : {}) });
  if (resolved.problems.length > 0) return refused(M.imagesProblems(resolved.problems));
  const images = resolved.images;
  const draft = prepareStudioText(resolved.text, kind, {
    vault,
    routes: settings.routes,
    fromPath: note.path,
    origin: address.origin,
    fragmentCharCap: settings.fragmentCharCap,
  });
  const problem = draft.problems[0];
  if (problem) return refused(refusalFor(problem));
  const contentMd = draft.contentMd;
  const localHash = await localStudioHash(contentMd);

  try {
    // ---- which item, and what the Studio holds now -----------------------------------------------------------------------
    let item: StudioItem | null = null;
    /** The Studio's working copy was edited there since this note last sent it, and differs from the note: the user decides (after the preview). */
    let editedThere = false;
    // Hoppers (S13): read now, so a name the Studio does not know refuses the send before anything is written.
    const hopperPlan = await planHoppers(deps, note, record.kind === "this" ? record.id : null);
    if (!hopperPlan.ok) return hopperPlan.outcome;
    const hoppers = hopperPlan.plan;
    if (record.kind === "this") {
      const got = await client.getItem(record.id);
      if (got.kind === "not-found") return refused(M.studioItemMissing(record.id, address.host));
      if (got.kind !== "ok") return studioFailureOutcome("Publishing", got);
      item = got.value;
      if (item.kind !== kind) return refused(M.studioKindFixed(item.id, kind, item.kind));
      const working = await hashOfWorkingCopy(item);
      editedThere = working !== localHash && working !== record.sent;
      if (draftsOnly) {
        if (item.status === "withdrawn") return refused(M.studioDraftsOnlyWithdrawn(item.id));
        // Only the working copy is ever written here, so "nothing to send" is whether it already holds this text.
        if (working === localHash && !stubDiffers(item)) {
          if (record.sent !== localHash || record.version !== item.version) await restamp(deps, note, item, localHash, kind);
          return hoppersOnly(deps, note, item.id, hoppers, noop(M.studioDraftNoChanges));
        }
      }
      // Studio makes a new version of an unchanged item, so "nothing to send" is decided here, never left to it.
      if (item.status === "public" && !item.dirty && working === localHash && !stubDiffers(item)) {
        if (record.sent !== localHash || record.version !== item.version) await restamp(deps, note, item, localHash, kind);
        return hoppersOnly(deps, note, item.id, hoppers, noop(M.noChanges));
      }
    } else {
      // No record: a draft an earlier, unfinished attempt created for this note may be waiting.
      const draft = await pending.get(note.path);
      if (draft && sameOrigin(draft.origin, address.origin)) {
        const got = await client.getItem(draft.id);
        if (got.kind === "not-found") await pending.clear(note.path);
        else if (got.kind !== "ok") return studioFailureOutcome("Publishing", got);
        else if (got.value.status === "draft" && got.value.version === 0 && got.value.kind === kind) item = got.value;
        else if (got.value.status !== "draft") {
          // The earlier attempt published, but the note was never stamped. Mark it again only when the Studio holds exactly this text.
          if (got.value.kind === kind && !got.value.dirty && (await hashOfWorkingCopy(got.value)) === localHash) {
            return await stamp(deps, note, { id: got.value.id, version: got.value.version, kind, localHash }, M.studioRecovered(got.value.id, got.value.version), "recovered", [], repost !== null);
          }
          return refused(M.studioPendingPublished(draft.id));
        }
      }
    }
    const id = item?.id ?? null;

    // ---- Studio's own rendering and checks, then the user's confirmation --------------------------------------------------
    // The Studio cannot know the pictures' addresses before they are uploaded; the preview gets stand-ins on its own host.
    const standIns = new Map(images.map((i) => [i.sha256, `${address.host}/media/pending/${i.sha256}.${(Object.entries(IMAGE_MIME).find(([, m]) => m === i.mime) ?? ["png"])[0]}`]));
    const previewed = await client.preview({ contentMd: withStudioAddresses(contentMd, standIns), kind, ...(id ? { itemId: id } : {}) });
    if (previewed.kind !== "ok") return studioFailureOutcome("Preview", previewed);
    if (previewed.value.problems.length > 0) {
      return refused(M.studioPreviewProblems(previewed.value.problems.map((p) => (p.directive ? `${p.directive}: ${p.reason}` : p.reason))));
    }

    const publishedBefore = item && item.version > 0 ? item : null;
    const toVersion = (item?.version ?? 0) + 1;
    const quotes: StudioQuoteLine[] = previewed.value.quotes.map((q) => ({
      id: q.id,
      version: q.version,
      passage: q.passage,
      remote: q.origin !== null,
      label: draft.quotes.find((d) => d.id === q.id && d.label !== null)?.label ?? null,
    }));
    const confirmation: WritePreview = draftsOnly
      ? {
          action: "draft",
          channel: "production",
          branch: address.host,
          path: id ? studioItemUrl(address, kind, id) : "(new draft)",
          noteName: note.name,
          label: kind,
          ...(id ? { id } : {}),
          before: item ? shown(item.contentMd) : null,
          after: contentMd,
          changes: [
            "Nothing goes live: a draft is visible only to you in the Studio.",
            ...imageLines(images, "draft"),
            id ? "The Studio's working copy is replaced by this note's text." : "A new draft in the Studio.",
            ...(publishedBefore ? [`The published version ${publishedBefore.version} stays as it is.`] : []),
            ...(stub ? [M.stubReply(stubLabel(stub))] : []),
            ...hopperLines(hoppers),
          ],
          links: [],
          blygNote: false,
          commitMessage: "",
          studio: { host: address.host, html: previewed.value.html, ...(quotes.length > 0 ? { quotes } : {}) },
        }
      : {
      action: id && item && item.version > 0 ? "update" : "create",
      channel: "production",
      branch: address.host,
      path: id ? studioItemUrl(address, kind, id) : "(new item)",
      noteName: note.name,
      label: kind,
      ...(id ? { id } : {}),
      ...(publishedBefore ? { fromVersion: publishedBefore.version } : {}),
      toVersion,
      before: publishedBefore?.published ? shown(publishedBefore.published.contentMd) : null,
      after: contentMd,
      changes: [
        ...(repost
          ? [
              `A NEW item with a new id and today's date. The old item (${repost.id}${typeof repost.version === "number" ? `, version ${repost.version}` : ""}${repost.origin ? ` at ${repost.origin}` : ""}) is not touched.`,
              "The note keeps the old record under blyg_previous.",
            ]
          : []),
        id && publishedBefore ? `Version ${publishedBefore.version} → ${toVersion}` : "Version 1",
        ...imageLines(images, "version"),
        ...(publishedBefore?.status === "withdrawn" ? ["The item is no longer withdrawn"] : []),
        ...(stub ? [M.stubReply(stubLabel(stub))] : []),
        ...hopperLines(hoppers),
      ],
      links: [],
      blygNote: false,
      commitMessage: "",
      studio: { host: address.host, html: previewed.value.html, ...(quotes.length > 0 ? { quotes } : {}), askNote: publishedBefore !== null || repost !== null, ...(repost ? { noteDefault: repostNoteText(repost.origin, vault.frontmatterValue(note, "blyg_created")), repost: { id: repost.id, origin: repost.origin, version: typeof repost.version === "number" ? repost.version : null } } : {}) },
    };
    // Decision 1: work done in the Studio's own editor is never overwritten without being shown, and asked about, first.
    if (editedThere && item) {
      const overwrite: WritePreview = {
        action: "studio-conflict",
        channel: "production",
        branch: address.host,
        path: studioItemUrl(address, kind, item.id),
        noteName: note.name,
        label: kind,
        id: item.id,
        before: shown(item.contentMd),
        after: contentMd,
        changes: [],
        links: [],
        blygNote: false,
        commitMessage: "",
        studio: { host: address.host, html: "" },
      };
      const choice = await deps.confirm(overwrite);
      if (typeof choice === "object" && choice.pull === true) return pullStudio(deps, note, { confirmed: true });
      if (!choice) return cancelled(M.studioChangedThereCancelled(item.id));
    }
    const answer = await deps.confirm(confirmation);
    if (!answer) return cancelled(M.studioCancelled);
    // A first version takes a note only as a repost's provenance; an ordinary first publish has no changelog to add to.
    const changeNote = typeof answer === "object" && (publishedBefore !== null || repost !== null) ? cleanNote(answer.note) : undefined;

    // ---- write: working copy, then publish --------------------------------------------------------------------------------
    let itemId = id;
    /** The revision the next command acts on: what we read, then what each write of ours answered. */
    let revision = item?.revision ?? 0;
    const isNew = itemId === null;
    if (itemId === null) {
      const created = await client.createItem({ kind, contentMd, ...(stub ? { stubOf: stub } : {}) });
      if (created.kind !== "ok") return studioFailureOutcome("Publishing", created);
      itemId = created.value.id;
      revision = created.value.revision;
      try {
        await pending.set(note.path, { origin: address.origin, id: itemId, kind, at: deps.clock.now().toISOString() });
      } catch (err) {
        logError(deps, "remembering the new draft (ignored)", err);
      }
    }

    // Pictures are uploaded to the item (attached, so the version that shows them keeps them), one at a time, each acting on the revision the
    // last one answered. Only then does the text carry their addresses.
    let sendMd = contentMd;
    if (images.length > 0) {
      const binary = deps.images;
      if (!binary) return failed(M.imagesUnavailable);
      const addresses = new Map<string, string>();
      for (const image of images) {
        const bytes = await binary.readBinary(image.path);
        if ((await sha256HexBytes(bytes)) !== image.sha256) return failed(M.imageChanged(image.name));
        const sendRevision = revision;
        const sendItem = itemId;
        const uploaded = await client.uploadMedia({ itemId: sendItem, expectedRevision: sendRevision, bytes, name: image.name, mime: image.mime, alt: image.alt });
        if (uploaded.kind === "conflict") return failed(M.studioChangedWhilePublishing(sendItem));
        if (uploaded.kind !== "ok") {
          const out = studioFailureOutcome("Uploading an image", uploaded);
          return { ...out, notices: [...out.notices, M.imageUploadStopped(sendItem)] };
        }
        addresses.set(image.sha256, uploaded.value.url);
        if (uploaded.value.revision !== null) revision = uploaded.value.revision;
      }
      sendMd = withStudioAddresses(contentMd, addresses);
    }
    const needsText = isNew ? sendMd !== contentMd : item !== null && (item.contentMd !== sendMd || stubDiffers(item));
    if (needsText) {
      const sendId = itemId;
      const working = item ? await hashOfWorkingCopy(item) : localHash;
      const updated = await withRevision(client, sendId, revision, working, (rev) => client.updateItem(sendId, { contentMd: sendMd, ...(item && stubDiffers(item) && stub ? { stubOf: stub } : {}) }, rev));
      if (updated.kind === "changed-there") return failed(M.studioChangedWhilePublishing(sendId));
      if (updated.kind !== "ok") return studioFailureOutcome("Publishing", updated);
      revision = updated.value.revision;
    }

    if (draftsOnly) {
      const notices = [item && item.version > 0 ? M.studioDraftUpdated(itemId, item.version) : M.studioDraftSent(itemId)];
      if (stripped.removed > 0) notices.push(M.commentsLeftOut(stripped.removed));
      const sent = await stamp(deps, note, { id: itemId, version: item?.version ?? 0, kind, localHash }, notices[0] as string, "published", notices.slice(1), false);
      return hoppers && !sent.localStampFailed ? { ...sent, notices: [...sent.notices, ...(await applyHoppers(deps, note, itemId, hoppers))] } : sent;
    }

    const publishId = itemId;
    const published = await withRevision(client, publishId, revision, localHash, (rev) => client.publish(publishId, changeNote, rev));
    if (published.kind === "changed-there") return failed(M.studioChangedWhilePublishing(publishId));
    if (published.kind !== "ok") {
      const out = studioFailureOutcome("Publishing", published);
      return { ...out, notices: [...out.notices, `The text is saved as a draft of ${itemId} in the Studio; the note is untouched.`] };
    }

    const notices: string[] = [];
    if (published.value.warning) notices.push(M.studioWarning(published.value.warning));
    const url = studioItemUrl(address, kind, itemId);
    const message = repost
      ? M.studioReposted(itemId, published.value.version, url, repost.id)
      : id !== null && record.kind === "this"
        ? M.studioPublishedUpdate(published.value.version, url)
        : M.studioPublishedNew(itemId, published.value.version, url);
    if (stripped.removed > 0) notices.push(M.commentsLeftOut(stripped.removed));
    const done = await stamp(deps, note, { id: itemId, version: published.value.version, kind, localHash }, message, "published", notices, repost !== null);
    return hoppers && !done.localStampFailed ? { ...done, notices: [...done.notices, ...(await applyHoppers(deps, note, itemId, hoppers))] } : done;
  } catch (err) {
    logError(deps, "publishing to the Studio", err);
    return failed(err instanceof HttpError ? err.message : M.studioNetworkSafe);
  }
}

/** Mark the note with what the Studio now holds; the outcome carries `message` first, then `extra`. */
async function stamp(
  deps: PublishDeps,
  note: NoteRef,
  done: { id: string; version: number; kind: StudioItemKind; localHash: string },
  message: string,
  status: "published" | "recovered",
  extra: string[] = [],
  reposting = false,
): Promise<Outcome> {
  const studio = deps.studio;
  if (!studio) return failed(M.studioNotConfigured);
  const { address, pending } = studio;
  const outcome: Outcome = { status: status === "recovered" ? "noop" : "published", notices: [message, ...extra], id: done.id, version: done.version };
  try {
    await deps.vault.updateFrontmatter(note, (fm) => {
      if (reposting) movePreviousRecord(fm, deps.settings.origin);
      delete fm.blyg_withdrawn; // a publish after a withdrawal un-withdraws
      fm[ORIGIN_KEY] = address.origin;
      fm.blyg_id = done.id;
      if (done.kind === "thread") fm.blyg_kind = "thread";
      fm.blyg_version = done.version;
      // A draft has no public address yet: only a published item gets one.
      if (done.version > 0) fm[URL_KEY] = studioItemUrl(address, done.kind, done.id);
      fm[SENT_KEY] = done.localHash;
    });
  } catch (err) {
    logError(deps, "writing local frontmatter after a successful Studio publish", err);
    // The draft record stays: it is what lets the next publish find this item instead of making a second one.
    return { ...outcome, notices: [M.studioStampFailed(done.id, done.version, address.origin)], localStampFailed: true };
  }
  try {
    await pending.clear(note.path);
  } catch (err) {
    logError(deps, "clearing the draft record (ignored)", err);
  }
  return outcome;
}

/** The day an old record says its item was first published, as `YYYY-MM-DD` (Obsidian's YAML hands back a string or a Date), or null. */
function firstPublishedDay(value: unknown): string | null {
  const text = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : typeof value === "string" ? value : "";
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/**
 * The line a repost offers as the first version's change note (Florian, 2026-10-23: dates do not matter to him, but where an item came from is
 * worth keeping): where it was published before, and when. `origin` is shown without its scheme; with no known origin the text says "the old blyg".
 */
export function repostNoteText(origin: string | null, created: unknown): string {
  const where = origin ? origin.replace(/^https?:\/\//i, "") : "the old blyg";
  const day = firstPublishedDay(created);
  return `Reposted from ${where}${day ? ` — first published ${day}` : ""}`;
}

/** Keys of the old GitHub record that mean nothing for a Studio item: they go with the record into `blyg_previous`. */
const OLD_RECORD_KEYS = ["blyg_created", "blyg_updated", "blyg_hash", "blyg_channel"] as const;

/**
 * Reposting: the old record (`blyg_id`, `blyg_version`, and where it lived) becomes one property, `blyg_previous`, so nothing is lost and
 * nothing of it is mistaken for the new item. `oldOrigin` is the old blyg's address from the settings, for a record that never stored one.
 */
export function movePreviousRecord(fm: Record<string, unknown>, oldOrigin: string): void {
  const origin = typeof fm[ORIGIN_KEY] === "string" && fm[ORIGIN_KEY] !== "" ? fm[ORIGIN_KEY] : oldOrigin !== "" ? oldOrigin : null;
  const kind = fm.blyg_kind === "thread" ? "thread" : "fragment";
  const previous: Record<string, unknown> = {
    ...(origin ? { origin } : {}),
    id: fm.blyg_id,
    ...(typeof fm.blyg_version === "number" ? { version: fm.blyg_version } : {}),
    ...(typeof fm[URL_KEY] === "string" ? { url: fm[URL_KEY] } : origin ? { url: `${origin.endsWith("/") ? origin : `${origin}/`}${itemPagePath(kind, String(fm.blyg_id))}` } : {}),
    ...(fm.blyg_withdrawn === true ? { withdrawn: true } : {}),
  };
  fm.blyg_previous = previous;
  for (const key of OLD_RECORD_KEYS) delete fm[key];
  delete fm[SENT_KEY];
}

/** The Studio already holds this text: only the note's own record is out of date. Never fails the publish. */
async function restamp(deps: PublishDeps, note: NoteRef, item: StudioItem, localHash: string, kind: StudioItemKind): Promise<void> {
  const studio = deps.studio;
  if (!studio) return;
  try {
    await deps.vault.updateFrontmatter(note, (fm) => {
      fm.blyg_version = item.version;
      fm[SENT_KEY] = localHash;
      if (item.version > 0) fm[URL_KEY] = studioItemUrl(studio.address, kind, item.id);
    });
  } catch (err) {
    logError(deps, "refreshing the note's Studio record (ignored)", err);
  }
}
