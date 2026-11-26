// V1-C.2: paragraphs of notes as items. `makeBlockItem` makes (or updates) the item of one paragraph and marks the note; `publishParagraph` is the
// command "Publish this paragraph"; `translateBlockEmbeds` turns `![[Note#^id]]` lines of a thread into quotes of those items, and lists the ones that
// are not published yet (publish/studio.ts publishes those first, after the one confirmation).
//
// Where the record lives: the note's `blyg_blocks` property (block id to item id) and `blyg_blocks_origin`: an id is permanent, so it travels with the
// note and with Sync. The block id itself (`^ab12`) is Obsidian's, at the end of the paragraph; it is written FIRST, because it is the paragraph's identity.
import { stripFrontmatter } from "../core/frontmatter";
import { normalizeContentMd } from "../core/normalize";
import { routeFor } from "../core/routes";
import type { NoteRef } from "../platform/ports";
import { studioItemUrl } from "../studio/address";
import { localStudioHash, studioTextHash } from "../studio/media";
import { sameOrigin } from "../studio/record";
import { prepareStudioText, refusalFor } from "../studio/text";
import type { StudioItem } from "../studio/types";
import { blockEmbeds, newBlockId, paragraphAt, paragraphOfBlock, readBlockMap, withBlockId } from "../tangle/blocks";
import { M } from "./messages";
import { logError, stripComments } from "./shared";
import { studioFailureOutcome } from "./studioFailure";
import { withRevision } from "./studioRevision";
import { cancelled, failed, noop, refused, type Outcome, type PublishDeps, type WritePreview } from "./types";

export const BLOCKS_KEY = "blyg_blocks";
export const BLOCKS_ORIGIN_KEY = "blyg_blocks_origin";

const refNote = (path: string): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension: path.split(".").pop() ?? "" });

/** What a paragraph is sent as: comments out, normalised, names turned into ids, as any fragment. A reason when it cannot be sent (also what the panel compares against). */
export function blockContentMd(text: string, ctx: { vault: PublishDeps["vault"]; routes: PublishDeps["settings"]["routes"]; fromPath: string; origin: string; fragmentCharCap: number }): { ok: true; contentMd: string; removed: number } | { ok: false; refusal: string } {
  const stripped = stripComments(text);
  if (!stripped.ok) return { ok: false, refusal: stripped.outcome.notices.join(" ") };
  const words = normalizeContentMd(stripped.text);
  if (/!\[[^\]]*\]\(|!\[\[/.test(words)) return { ok: false, refusal: M.blockPicture };
  const draft = prepareStudioText(words, "fragment", ctx);
  const problem = draft.problems[0];
  return problem ? { ok: false, refusal: refusalFor(problem) } : { ok: true, contentMd: draft.contentMd, removed: stripped.removed };
}

export interface PendingBlock {
  /** The line of the thread that embeds it (1-based). */
  line: number;
  host: NoteRef;
  /** The note's name as written in the embed. */
  hostName: string;
  blockId: string;
  /** The paragraph's words as they will be published (filled by `describeBlocks`). */
  text: string;
}

export interface BlockEmbedContext {
  vault: PublishDeps["vault"];
  routes: PublishDeps["settings"]["routes"];
  fromPath: string;
  origin: string;
  /** Blocks published a moment ago, whose record the metadata cache may not show yet: `${host path}#^${block id}` to item id. */
  known?: ReadonlyMap<string, string>;
}

/**
 * The thread's text with each own-line `![[Note#^id]]` turned into `![[<item id>]]` where the paragraph is published, and into an empty line where it is not
 * (so line numbers stay); those are returned as `pending`. Heading embeds and the other things that cannot be published are problems.
 */
export function translateBlockEmbeds(text: string, ctx: BlockEmbedContext): { text: string; pending: PendingBlock[]; problems: string[] } {
  const { blocks, headings } = blockEmbeds(text);
  if (blocks.length === 0 && headings.length === 0) return { text, pending: [], problems: [] };
  const lines = text.split("\n");
  const problems: string[] = [];
  const pending: PendingBlock[] = [];
  for (const h of headings) problems.push(M.blockHeading(h.line, h.target).replace(/^Not published — /, "").replace(/ Nothing was sent\.$/, ""));
  for (const b of blocks) {
    if (b.host === "") {
      problems.push(M.blockSameNote(b.line).replace(/^Not published — /, "").replace(/ Nothing was sent\.$/, ""));
      continue;
    }
    const resolved = ctx.vault.resolveLink(b.host, ctx.fromPath);
    if (!resolved || resolved.extension !== "md") {
      problems.push(M.blockHostMissing(b.line, b.host));
      continue;
    }
    if (resolved.path === ctx.fromPath) {
      problems.push(M.blockSameNote(b.line).replace(/^Not published — /, "").replace(/ Nothing was sent\.$/, ""));
      continue;
    }
    const route = routeFor(ctx.routes, resolved.path);
    if (route?.mode !== "studio" || route.draftsOnly === true) {
      problems.push(M.blockHostNotStudio(b.line, b.host));
      continue;
    }
    const host = refNote(resolved.path);
    const map = readBlockMap(ctx.vault.frontmatterValue(host, BLOCKS_KEY));
    const origin = ctx.vault.frontmatterValue(host, BLOCKS_ORIGIN_KEY);
    const mine = Object.keys(map).length === 0 || (typeof origin === "string" && sameOrigin(origin, ctx.origin));
    const id = ctx.known?.get(`${resolved.path}#^${b.blockId}`) ?? (mine ? map[b.blockId] : undefined);
    if (id) {
      lines[b.line - 1] = `![[${id}]]`;
      continue;
    }
    if (!mine) {
      problems.push(M.blockOtherStudio(b.host).replace(/ Nothing was sent\.$/, ""));
      continue;
    }
    if (/^\s*>/.test(lines[b.line] ?? "")) {
      problems.push(M.blockQuoteOfNew(b.line));
      continue;
    }
    lines[b.line - 1] = "";
    if (!pending.some((p) => p.host.path === resolved.path && p.blockId === b.blockId)) pending.push({ line: b.line, host, hostName: b.host, blockId: b.blockId, text: "" });
  }
  return { text: lines.join("\n"), pending, problems };
}

/** Read each pending block's paragraph from its note. A block that is not there, or is not a plain paragraph, is a problem. */
export async function describeBlocks(deps: PublishDeps, pending: PendingBlock[]): Promise<{ ok: true } | { ok: false; problems: string[] }> {
  const problems: string[] = [];
  for (const p of pending) {
    const found = paragraphOfBlock(await deps.vault.read(p.host), p.blockId);
    if (!found) problems.push(M.blockNotFound(p.line, p.hostName, p.blockId));
    else p.text = found.text;
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

type Made = { ok: true; id: string; version: number; blockId: string; created: boolean; changed: boolean } | { ok: false; outcome: Outcome };

/**
 * Make or update the item of one paragraph and mark the note. `blockId` is the paragraph's own id, or null for a paragraph that has none yet (one is made). No
 * window: the callers asked. The id is written into the note first and the record second; a draft made before a failure is remembered by the paragraph's words,
 * so the retry finishes it instead of making a second item.
 */
export async function makeBlockItem(deps: PublishDeps, host: NoteRef, want: { blockId: string | null; text: string }): Promise<Made> {
  const studio = deps.studio;
  if (!studio) return { ok: false, outcome: refused(deps.studioProblem ?? M.studioNotConfigured) };
  if (!deps.edit) return { ok: false, outcome: refused(M.blockNotInRoute) };
  const { client, address, pending } = studio;
  const route = routeFor(deps.settings.routes, host.path);
  if (route?.mode !== "studio" || route.draftsOnly === true) return { ok: false, outcome: refused(M.blockNotInRoute) };

  const prepared = blockContentMd(want.text, { vault: deps.vault, routes: deps.settings.routes, fromPath: host.path, origin: address.origin, fragmentCharCap: deps.settings.fragmentCharCap });
  if (!prepared.ok) return { ok: false, outcome: refused(prepared.refusal) };
  const contentMd = prepared.contentMd;
  const localHash = await localStudioHash(contentMd);

  const raw = await deps.vault.read(host);
  const blockId = want.blockId ?? newBlockId(deps.random, raw);
  const map = readBlockMap(deps.vault.frontmatterValue(host, BLOCKS_KEY));
  const origin = deps.vault.frontmatterValue(host, BLOCKS_ORIGIN_KEY);
  if (Object.keys(map).length > 0 && !(typeof origin === "string" && sameOrigin(origin, address.origin))) return { ok: false, outcome: refused(M.blockOtherStudio(host.name)) };

  try {
    let item: StudioItem | null = null;
    let itemId = map[blockId] ?? null;
    const key = `${host.path}#${localHash}`;
    if (itemId) {
      const got = await client.getItem(itemId);
      if (got.kind === "not-found") return { ok: false, outcome: refused(M.studioItemMissing(itemId, address.host)) };
      if (got.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Publishing", got) };
      item = got.value;
      if (item.status === "withdrawn") return { ok: false, outcome: refused(M.blockWithdrawn(item.id)) };
      if (item.status === "public" && !item.dirty && (await studioTextHash(item.contentMd)) === localHash) return { ok: true, id: item.id, version: item.version, blockId, created: false, changed: false };
    } else {
      const left = await pending.get(key);
      if (left) {
        const got = await client.getItem(left.id);
        if (got.kind === "not-found") await pending.clear(key);
        else if (got.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Publishing", got) };
        else if (got.value.kind === "fragment") {
          item = got.value;
          itemId = item.id;
        }
      }
    }
    let revision = item?.revision ?? 0;
    let version = item?.version ?? 0;
    let created = false;
    const alreadyLive = item !== null && item.status === "public" && !item.dirty && (await studioTextHash(item.contentMd)) === localHash;
    if (itemId === null) {
      const made = await client.createItem({ kind: "fragment", contentMd });
      if (made.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Publishing", made) };
      itemId = made.value.id;
      revision = made.value.revision;
      created = true;
      try {
        await pending.set(key, { origin: address.origin, id: itemId, kind: "fragment", at: deps.clock.now().toISOString() });
      } catch (err) {
        logError(deps, "remembering the new draft (ignored)", err);
      }
    }
    if (!alreadyLive) {
      const id = itemId;
      if (item !== null && item.contentMd !== contentMd) {
        const updated = await withRevision(client, id, revision, await studioTextHash(item.contentMd), (rev) => client.updateItem(id, { contentMd }, rev));
        if (updated.kind === "changed-there") return { ok: false, outcome: failed(M.studioChangedWhilePublishing(id)) };
        if (updated.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Publishing", updated) };
        revision = updated.value.revision;
      }
      const published = await withRevision(client, id, revision, localHash, (rev) => client.publish(id, undefined, rev));
      if (published.kind === "changed-there") return { ok: false, outcome: failed(M.studioChangedWhilePublishing(id)) };
      if (published.kind !== "ok") return { ok: false, outcome: { ...studioFailureOutcome("Publishing", published), notices: [...studioFailureOutcome("Publishing", published).notices, `The text is saved as a draft of ${id} in the Studio; the note is untouched.`] } };
      version = published.value.version;
    }

    // Mark the note: the block id first (it is the paragraph's identity), then the record.
    if (want.blockId === null) {
      const swapped = await (async (): Promise<boolean> => {
        const body = stripFrontmatter(await deps.vault.read(host));
        const next = withBlockId(body, want.text, blockId);
        if (next === null || !deps.edit) return false;
        try {
          await deps.edit.replaceBody(host, body, next);
          return true;
        } catch (err) {
          logError(deps, "writing the block id", err);
          return false;
        }
      })();
      if (!swapped) return { ok: false, outcome: failed(M.blockStampFailed(itemId)) };
    }
    try {
      const idNow = itemId;
      await deps.vault.updateFrontmatter(host, (fm) => {
        fm[BLOCKS_KEY] = { ...readBlockMap(fm[BLOCKS_KEY]), [blockId]: idNow };
        fm[BLOCKS_ORIGIN_KEY] = address.origin;
      });
    } catch (err) {
      logError(deps, "writing the block record", err);
      return { ok: false, outcome: failed(M.blockStampFailed(itemId)) };
    }
    try {
      await pending.clear(key);
    } catch (err) {
      logError(deps, "clearing the draft record (ignored)", err);
    }
    return { ok: true, id: itemId, version, blockId, created, changed: true };
  } catch (err) {
    logError(deps, "publishing a paragraph", err);
    return { ok: false, outcome: failed(M.studioNetworkSafe) };
  }
}

/** The command "Publish this paragraph": the paragraph at `line` (1-based) of the note. One window, then the item is made and the note is marked. */
export async function publishParagraph(deps: PublishDeps, note: NoteRef, line: number): Promise<Outcome> {
  if (deps.tangle?.() !== true) return refused(M.blockSwitchedOff);
  const studio = deps.studio;
  if (!studio) return refused(deps.studioProblem ?? M.studioNotConfigured);
  const route = routeFor(deps.settings.routes, note.path);
  if (note.extension !== "md" || route?.mode !== "studio" || route.draftsOnly === true) return refused(M.blockNotInRoute);
  const found = paragraphAt(await deps.vault.read(note), line);
  if (!found.ok) return refused(M.blockNotParagraph(found.problem));
  const { paragraph } = found;
  const { client, address } = studio;

  // What the window shows, decided before anything is written.
  const map = readBlockMap(deps.vault.frontmatterValue(note, BLOCKS_KEY));
  const existing = paragraph.blockId ? map[paragraph.blockId] : undefined;
  let item: StudioItem | null = null;
  if (existing) {
    const got = await client.getItem(existing);
    if (got.kind === "not-found") return refused(M.studioItemMissing(existing, address.host));
    if (got.kind !== "ok") return studioFailureOutcome("Publishing", got);
    item = got.value;
  }
  const stripped = stripComments(paragraph.text);
  if (!stripped.ok) return stripped.outcome;
  const words = normalizeContentMd(stripped.text);
  const previewed = await client.preview({ contentMd: words, kind: "fragment" });
  if (previewed.kind !== "ok") return studioFailureOutcome("Preview", previewed);
  if (previewed.value.problems.length > 0) return refused(M.studioPreviewProblems(previewed.value.problems.map((p) => (p.directive ? `${p.directive}: ${p.reason}` : p.reason))));
  if (item && item.status === "public" && !item.dirty && (await studioTextHash(item.contentMd)) === (await localStudioHash(words))) return noop(M.blockNoChanges(paragraph.blockId ?? ""));
  const updating = item !== null && item.version > 0;
  const preview: WritePreview = {
    action: updating ? "update" : "create",
    channel: "production",
    branch: address.host,
    path: item ? studioItemUrl(address, "fragment", item.id) : "(new item)",
    noteName: note.name,
    label: "fragment",
    ...(item ? { id: item.id } : {}),
    ...(updating && item ? { fromVersion: item.version, toVersion: item.version + 1 } : { toVersion: 1 }),
    before: updating && item?.published ? normalizeContentMd(item.published.contentMd) : null,
    after: words,
    changes: [
      updating && item ? `Version ${item.version} → ${item.version + 1}` : "Version 1",
      ...(paragraph.blockId ? [] : ["Adds a block id (^…) to the end of this paragraph in your note. The paragraph stays where it is."]),
    ],
    links: [],
    blygNote: false,
    commitMessage: "",
    studio: { host: address.host, html: previewed.value.html, askNote: false },
  };
  if (!(await deps.confirm(preview))) return cancelled(M.studioCancelled);
  const made = await makeBlockItem(deps, note, { blockId: paragraph.blockId, text: paragraph.text });
  if (!made.ok) return made.outcome;
  if (!made.changed) return noop(M.blockNoChanges(made.blockId));
  return { status: "published", notices: [M.blockPublished(made.blockId, note.name.replace(/\.md$/, ""), made.id, made.version, made.created)], id: made.id, version: made.version };
}

/** Publish the pending blocks one at a time, in the order they appear; each is marked in its note before the next starts. Stops at the first failure. */
export async function publishPendingBlocks(deps: PublishDeps, pending: PendingBlock[]): Promise<{ ok: true; known: Map<string, string> } | { ok: false; outcome: Outcome }> {
  const known = new Map<string, string>();
  for (const [n, p] of pending.entries()) {
    const made = await makeBlockItem(deps, p.host, { blockId: p.blockId, text: p.text });
    if (!made.ok) return { ok: false, outcome: { ...made.outcome, notices: [...made.outcome.notices, ...(n > 0 ? [M.blocksProgress(n, pending.length)] : [])] } };
    known.set(`${p.host.path}#^${p.blockId}`, made.id);
  }
  return { ok: true, known };
}
