import { readCommittedBlyg, type CommittedBlyg } from "../core/blyg";
import { stripObsidianComments } from "../core/comments";
import { extractFrontmatterBlock, stripFrontmatter } from "../core/frontmatter";
import { extractWikilinks } from "../core/links";
import { normalizeContentMd } from "../core/normalize";
import { routeFor } from "../core/routes";
import { HttpError } from "../platform/http";
import type { NoteRef } from "../platform/ports";
import { M } from "./messages";
import type { LinkReport, Outcome, PublishDeps } from "./types";
import { failed, refused } from "./types";

export type CommittedLookup =
  | { kind: "found"; sha: string; committed: CommittedBlyg; /** content_md as committed ("" for an endcap) */ body: string }
  | { kind: "missing" }
  | { kind: "stop"; outcome: Outcome };

/** Read and validate the committed item file for `path`: the true last-published state. */
export async function lookupCommittedBlyg(deps: PublishDeps, path: string): Promise<CommittedLookup> {
  const { github, settings, yaml, logger } = deps;
  if (!github) return { kind: "stop", outcome: refused(deps.githubProblem ?? M.githubNotSetUp) };
  try {
    const res = await github.getFile(path, settings.branch);
    if (res.kind === "not-found") return { kind: "missing" };
    if (res.kind === "error") {
      logger?.warn(`GET ${path} failed: ${res.status} ${res.message}`);
      return { kind: "stop", outcome: failed(M.unexpectedGet(res.status)) };
    }
    const block = extractFrontmatterBlock(res.text);
    if (block === null) {
      logger?.warn(`committed file ${path} has no frontmatter block`);
      return { kind: "stop", outcome: failed(M.noFrontmatter) };
    }
    const parsed = readCommittedBlyg(yaml.parse(block));
    if (!parsed.ok) return { kind: "stop", outcome: failed(M.malformedCommitted(parsed.problem)) };
    return {
      kind: "found",
      sha: res.sha,
      committed: parsed.committed,
      body: normalizeContentMd(stripFrontmatter(res.text)),
    };
  } catch (err) {
    logger?.warn(`reading ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "stop", outcome: failed(M.networkRead) };
  }
}

export function logError(deps: PublishDeps, what: string, err: unknown): void {
  deps.logger?.warn(`${what}: ${err instanceof HttpError || err instanceof Error ? err.message : String(err)}`);
}

/** Strip `%%…%%` comments from text that will be published; an unclosed one is refused (the rest might be private). */
export function stripComments(text: string): { ok: true; text: string; removed: number } | { ok: false; outcome: Outcome } {
  const r = stripObsidianComments(text);
  if (!r.ok) return { ok: false, outcome: { status: "refused", notices: [M.unclosedComment(r.line)] } };
  return r;
}

/** Judge every wikilink in `body`: where does it point, and is that a note a publish folder covers? */
export function classifyLinks(deps: Pick<PublishDeps, "vault" | "settings">, note: NoteRef, body: string): LinkReport[] {
  return extractWikilinks(body).map((link): LinkReport => {
    const base = { target: link.target, embed: link.embed, ...(link.target.includes("/") ? { folder: true } : {}) };
    const resolved = deps.vault.resolveLink(link.target, note.path);
    if (!resolved) return { ...base, kind: "unresolved" };
    if (resolved.extension !== "md") return { ...base, kind: "file", path: resolved.path };
    const covered = routeFor(deps.settings.routes, resolved.path) !== null;
    return { ...base, kind: covered ? "published" : "outside", path: resolved.path };
  });
}

/**
 * Links the site cannot honour: to notes that no publish folder covers (their titles would appear on the site) and to
 * notes that do not exist (yet): dead `[[text]]` today, and a title on the web if such a note is created later outside the
 * publish folders. Non-note files (images, PDFs) are fine. Empty when the check is off.
 */
export function problemLinks(deps: Pick<PublishDeps, "vault" | "settings">, note: NoteRef, body: string): LinkReport[] {
  if (deps.settings.outsideLinks === "off") return [];
  return classifyLinks(deps, note, body).filter((l) => l.kind === "outside" || l.kind === "unresolved");
}

/** The problem links as short readable pieces (at most five, then "+N more"): what the refusal, the heads-up and the panel say. */
export function shownProblemLinks(problems: LinkReport[]): string[] {
  const shown = problems.slice(0, 5).map((l) => `${l.embed ? "!" : ""}[[${l.target}]] (${l.kind === "outside" ? "not in a publish folder" : "no such note yet"})`);
  if (problems.length > 5) shown.push(`(+${problems.length - 5} more)`);
  return shown;
}

/** The refusal for problem links, or null when publishing may go on (a warning is returned separately). */
export function outsideLinksVerdict(
  deps: PublishDeps,
  note: NoteRef,
  body: string,
): { refusal: Outcome | null; warning: string | null } {
  const problems = problemLinks(deps, note, body);
  if (problems.length === 0) return { refusal: null, warning: null };
  const shown = shownProblemLinks(problems);
  if (deps.settings.outsideLinks === "block") return { refusal: { status: "refused", notices: [M.outsideLinks(shown)] }, warning: null };
  return { refusal: null, warning: M.outsideLinksWarning(shown) };
}

/** Tell the panel's record that `text` is on the branch now. Never throws and never blocks a publish: it only feeds a status line. */
export async function rememberPublished(deps: PublishDeps, branch: string, path: string, text: string): Promise<void> {
  if (!deps.rememberPublished) return;
  try {
    await deps.rememberPublished(branch, path, text);
  } catch (err) {
    logError(deps, "remembering what was published (ignored)", err);
  }
}

/**
 * A property of the note as the FILE says it, not as Obsidian's metadata cache does. The cache is updated a moment after the file is saved,
 * so a property typed just before tapping Publish can still read as its old value there (seen on the iPad, 2026-11-02: a hopper name typed by
 * hand was ignored, and then written over). Reading what is about to be sent from the file makes the send agree with what is on screen.
 * Falls back to the cache when the file cannot be read or its properties cannot be parsed.
 */
export async function fileProperty(deps: PublishDeps, note: NoteRef, key: string): Promise<unknown> {
  try {
    const block = extractFrontmatterBlock(await deps.vault.read(note));
    if (block !== null) {
      const parsed = deps.yaml.parse(block);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return (parsed as Record<string, unknown>)[key];
    }
  } catch {
    // unreadable: the cache is better than nothing
  }
  return deps.vault.frontmatterValue(note, key);
}
