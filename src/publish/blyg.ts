// Blyg-route publish (fragments): the legacy macro's flow plus R2's safety and honesty: comments stripped, links
// checked, the user confirms what will change, the channel is recorded on notes published to the test channel.
import { checkFragmentBody, decideBlygPublish, localKind } from "../core/blyg";
import { buildBlygFileText, stripFrontmatter } from "../core/frontmatter";
import { contentHash } from "../core/hash";
import { isBlygId, mintBlygId } from "../core/ids";
import { normalizeContentMd } from "../core/normalize";
import { renderLinksYaml, renderSourcesYaml } from "../core/sources";
import { leftoverEmbeds, scanThread } from "../core/thread";
import type { NoteRef } from "../platform/ports";
import { translateNameEmbeds } from "./embeds";
import { prepareItems, type PreparedItems } from "./items";
import { M } from "./messages";
import { classifyLinks, logError, lookupCommittedBlyg, outsideLinksVerdict, stripComments } from "./shared";
import { cancelled, commitRecord, failed, noop, refused, type Outcome, type PublishDeps, type WritePreview } from "./types";

/** The `blyg_id` a note carries, if any. Falsy values count as "none" (as in the macro); anything else must be a valid id. */
export function localBlygId(raw: unknown): { id: string | undefined } | { invalid: string } {
  if (!raw) return { id: undefined };
  if (!isBlygId(raw)) return { invalid: typeof raw === "string" ? raw : JSON.stringify(raw) };
  return { id: raw };
}

/** Local-only marker on notes published to the test channel: such a note must never be published to production. */
export const CHANNEL_KEY = "blyg_channel";

export async function publishBlyg(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const { settings, github, vault, yaml, clock, random } = deps;
  if (!github) return refused(deps.githubProblem ?? M.githubNotSetUp);

  // Only Markdown notes: an image or a canvas file in a publish folder must never be read as text and committed.
  if (note.extension !== "md") return refused(M.notMarkdown(note.name));

  if (settings.channel === "production" && vault.frontmatterValue(note, CHANNEL_KEY) === "preview") {
    return refused(M.previewNote(note.path));
  }

  const declared = localKind(vault.frontmatterValue(note, "blyg_kind"));
  if ("invalid" in declared) return refused(M.unknownKind(declared.invalid));
  const kind = declared.kind;

  const raw = await vault.read(note);
  const stripped = stripComments(stripFrontmatter(raw));
  if (!stripped.ok) return stripped.outcome;
  // Names in the vault, ids on the wire: `![[Note name]]` of a published Blyg note becomes `![[<id>]]` here (publish/embeds.ts).
  const embeds = translateNameEmbeds(normalizeContentMd(stripped.text), { vault, routes: settings.routes, fromPath: note.path });
  if (embeds.problems.length > 0) return refused(M.itemProblems(embeds.problems));
  const contentMd = embeds.text;
  if (kind === "thread") {
    if (contentMd.length === 0) return refused(M.emptyThread);
  } else {
    const body = checkFragmentBody(contentMd, settings.fragmentCharCap);
    if (!body.ok) {
      return refused(body.reason === "empty" ? M.emptyBody : M.tooLong(body.length, body.cap));
    }
  }

  // Quotes (`![[id]]`) and item links (`[[id]]`): where the plugin cannot be sure what is code, it refuses (core/thread.ts).
  const scan = scanThread(contentMd);
  if (!scan.ok) return refused(M.grammarRefused(scan.problems));
  const firstDirective = scan.directives[0];
  if (kind === "fragment" && firstDirective) return refused(M.fragmentQuotes(firstDirective.line));
  const leftover = leftoverEmbeds(contentMd, scan.directives);
  if (leftover.length > 0) return refused(M.embedsLeft(leftover));

  const links = outsideLinksVerdict(deps, note, contentMd);
  if (links.refusal) return links.refusal;

  const local = localBlygId(vault.blygId(note));
  if ("invalid" in local) return refused(M.invalidId(local.invalid));

  const hash = await contentHash(contentMd);
  const path = local.id ? `${settings.itemsDir}/${local.id}.md` : null;

  let committedSha: string | undefined;
  let committed = null;
  let committedBody: string | null = null;
  if (path) {
    const lookup = await lookupCommittedBlyg(deps, path);
    if (lookup.kind === "stop") return lookup.outcome;
    if (lookup.kind === "found") {
      committedSha = lookup.sha;
      committed = lookup.committed;
      committedBody = lookup.body;
    }
  }

  // The kind of a published item never changes (contract §3.1): say so before any read of the quoted items.
  if (committed && committed.kind !== kind) return refused(M.kindChanged(local.id ?? "", kind, committed.kind));

  let prepared: PreparedItems | null = null;
  if (kind === "thread" || scan.links.length > 0) {
    const resolved = await prepareItems(deps, { kind, directives: scan.directives, linkIds: scan.links, selfId: local.id, committed });
    if (!resolved.ok) return resolved.outcome;
    prepared = resolved.prepared;
  }

  const decision = decideBlygPublish(
    { contentHash: hash, existingId: local.id, now: clock.now().toISOString(), newId: () => mintBlygId(random), kind, sourcesChanged: prepared?.sourcesChanged ?? false },
    committed,
  );

  if (decision.action === "noop") return noop(M.noChanges);
  if (decision.action === "refuse") {
    return refused(
      decision.reason === "kind-changed"
        ? M.kindChanged(local.id ?? "", kind, decision.committedKind)
        : M.committedMissing(local.id ?? "", path ?? "", settings.branch),
    );
  }

  const id = decision.id;
  const version = decision.action === "create" ? 1 : decision.version;
  const commitPath = `${settings.itemsDir}/${id}.md`;
  const noun = kind === "thread" ? "thread" : "note";
  const message = decision.action === "create" ? `content: publish ${noun} ${id}` : `content: update ${noun} ${id} to v${version}`;

  const changes =
    decision.action === "create"
      ? [`New ${noun} ${id}`, "Version 1"]
      : [
          `Version ${committed?.version ?? 0} → ${version}`,
          "Changelog: one entry added",
          ...(committed?.withdrawn ? ["The item is no longer withdrawn"] : []),
        ];
  if (prepared) changes.push(...prepared.changes);
  const preview: WritePreview = {
    action: decision.action === "create" ? "create" : "update",
    channel: settings.channel,
    branch: settings.branch,
    path: commitPath,
    noteName: note.name,
    label: kind,
    id,
    ...(committed ? { fromVersion: committed.version } : {}),
    toVersion: version,
    before: committedBody,
    after: contentMd,
    changes,
    links: classifyLinks(deps, note, contentMd),
    blygNote: true,
    ...(prepared ? { thread: prepared.preview } : {}),
    commitMessage: message,
  };
  if (!(await deps.confirm(preview))) return cancelled(M.cancelled);

  let commitSha: string | undefined;
  try {
    const put = await github.putFile({
      path: commitPath,
      text: buildBlygFileText(yaml, decision.frontmatter, contentMd, prepared ? (kind === "thread" ? renderSourcesYaml(prepared.sources) : "") + renderLinksYaml(prepared.links) : ""),
      message,
      branch: settings.branch,
      ...(committedSha ? { sha: committedSha } : {}),
    });
    if (put.kind === "conflict") return failed(M.conflict(put.status));
    if (put.kind === "not-found") return failed(M.writeNotFound(settings.branch));
    if (put.kind === "error") {
      deps.logger?.warn(`PUT ${commitPath} failed: ${put.status} ${put.message}`);
      return failed(M.publishFailed(put.status));
    }
    commitSha = put.commitSha;
  } catch (err) {
    logError(deps, `PUT ${commitPath}`, err);
    return failed(M.networkWrite);
  }

  const notices = [
    decision.action === "create" ? M.publishedNew(id, version, settings.branch, settings.channel) : M.publishedUpdate(version, settings.branch, settings.channel),
  ];
  if (stripped.removed > 0) notices.push(M.commentsLeftOut(stripped.removed));
  const warnings = [...(links.warning ? [links.warning] : []), ...(kind === "thread" && contentMd.length > settings.threadSoftCap ? [M.threadSoftCap(contentMd.length, settings.threadSoftCap)] : [])];
  if (warnings.length > 0) notices.push(M.headsUp(warnings));
  const done: Outcome = { status: "committed", notices, commit: commitRecord(commitPath, message, settings.branch, commitSha), id, version };

  // Only reflect success locally once the commit actually landed.
  try {
    await vault.updateFrontmatter(note, (fm) => {
      delete fm.blyg_withdrawn; // a publish after a withdrawal un-withdraws
      Object.assign(fm, decision.frontmatter);
      if (settings.channel === "preview") fm[CHANNEL_KEY] = "preview";
      else delete fm[CHANNEL_KEY];
    });
  } catch (err) {
    logError(deps, "writing local frontmatter after a successful publish", err);
    return {
      ...done,
      notices: [decision.action === "create" ? M.stampFailedNew(id, settings.branch) : M.stampFailedUpdate(id, version, settings.branch)],
      localStampFailed: true,
    };
  }
  return done;
}
