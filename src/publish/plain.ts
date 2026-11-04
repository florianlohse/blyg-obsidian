// Plain-route publish (essays, pages): the legacy macro's flow, with the whitespace-only no-op (when enabled), comments
// stripped from the body, links checked, and the user confirming what will change.
import { embeddedImages, plainCommitText, plainTextsEquivalent, validatePlain } from "../core/plain";
import { normalizeLineEndings } from "../core/normalize";
import { resolvePlainTarget } from "../core/routes";
import type { NoteRef } from "../platform/ports";
import type { Route } from "../settings/schema";
import { M } from "./messages";
import { classifyLinks, logError, outsideLinksVerdict, rememberPublished } from "./shared";
import { cancelled, commitRecord, failed, noop, refused, type Outcome, type PublishDeps, type WritePreview } from "./types";

export async function publishPlain(deps: PublishDeps, note: NoteRef, route: Route): Promise<Outcome> {
  const { settings, github, vault, yaml } = deps;
  if (!github) return refused(deps.githubProblem ?? M.githubNotSetUp);

  const target = resolvePlainTarget(route, note, settings.itemsDir);
  if (!target.ok) {
    switch (target.reason) {
      case "not-markdown":
        return refused(M.notMarkdown(note.name));
      case "unusable-path":
        return refused(M.unusablePath(note.path));
      case "no-destination":
        return refused(M.noDestination(route.label));
      case "inside-blyg-folder":
        return refused(M.insideBlygFolder(`${route.dest ?? ""}${note.path.slice(route.vaultPrefix.length)}`));
    }
  }
  const { rel, destPath } = target;

  // Frontmatter is copied as it is; comments are stripped from the body only (the panel computes the same text).
  const commit = plainCommitText(await vault.read(note));
  if (!commit.ok) return refused(M.unclosedComment(commit.line));
  const stripped = { text: commit.body, removed: commit.removed };
  const text = commit.text;
  if (text.trim().length === 0) return refused(M.emptyNote);

  const { errors, warnings } = validatePlain(text, route, yaml);
  if (errors.length > 0) return refused(M.notPublished(errors));

  const links = outsideLinksVerdict(deps, note, stripped.text);
  if (links.refusal) return links.refusal;
  if (links.warning) warnings.push(links.warning);

  let committedSha: string | undefined;
  let committedText: string | null = null;
  try {
    const res = await github.getFile(destPath, settings.branch);
    if (res.kind === "found") {
      committedSha = res.sha;
      committedText = normalizeLineEndings(res.text);
    } else if (res.kind === "error") {
      deps.logger?.warn(`GET ${destPath} failed: ${res.status} ${res.message}`);
      return failed(M.unexpectedGet(res.status));
    }
  } catch (err) {
    logError(deps, `GET ${destPath}`, err);
    return failed(M.networkReadPlain);
  }

  if (committedText !== null && plainTextsEquivalent(text, committedText, { ignoreTrailingWhitespace: settings.ignoreTrailingWhitespace })) {
    // The repo already holds this text: remember that, so the panel can say "published" for essays the macro sent.
    await rememberPublished(deps, settings.branch, destPath, text);
    return noop(M.noChanges);
  }

  const verb = committedSha ? "update" : "publish";
  const message = `content: ${verb} ${route.label} ${rel}`;
  const preview: WritePreview = {
    action: committedSha ? "plain-update" : "plain-create",
    channel: settings.channel,
    branch: settings.branch,
    path: destPath,
    noteName: note.name,
    label: route.label,
    before: committedText,
    after: text,
    changes: [],
    links: classifyLinks(deps, note, stripped.text),
    blygNote: false,
    commitMessage: message,
  };
  if (!(await deps.confirm(preview))) return cancelled(M.cancelled);

  let commitSha: string | undefined;
  try {
    const put = await github.putFile({
      path: destPath,
      text,
      message,
      branch: settings.branch,
      ...(committedSha ? { sha: committedSha } : {}),
    });
    if (put.kind === "conflict") return failed(M.conflict(put.status));
    if (put.kind === "not-found") return failed(M.writeNotFound(settings.branch));
    if (put.kind === "error") {
      deps.logger?.warn(`PUT ${destPath} failed: ${put.status} ${put.message}`);
      return failed(M.publishFailed(put.status));
    }
    commitSha = put.commitSha;
  } catch (err) {
    logError(deps, `PUT ${destPath}`, err);
    return failed(M.networkWritePlain);
  }

  await rememberPublished(deps, settings.branch, destPath, text);

  const notices = [M.plainDone(verb, route.label, rel, settings.branch, settings.channel)];
  if (stripped.removed > 0) notices.push(M.commentsLeftOut(stripped.removed));

  // Non-blocking heads-ups, after the commit landed.
  const wanted = embeddedImages(text);
  if (wanted.length > 0) {
    try {
      const dir = await github.listDir(settings.attachmentsDir, settings.branch);
      if (dir.kind !== "found") throw new Error(`attachments listing returned ${dir.kind}`);
      const present = new Set(dir.names.map((n) => n.toLowerCase()));
      const missing = wanted.filter((name) => !present.has(name));
      if (missing.length > 0) {
        const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ` (+${missing.length - 5} more)` : "");
        warnings.push(M.missingImages(settings.attachmentsDir, shown));
      }
    } catch (err) {
      logError(deps, "image check (ignored)", err);
    }
  }
  if (warnings.length > 0) notices.push(M.headsUp(warnings));

  return { status: "committed", notices, commit: commitRecord(destPath, message, settings.branch, commitSha) };
}
