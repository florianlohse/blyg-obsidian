// Withdraw (spec §9 endcap): the legacy macro's flow plus an explicit confirmation. The local note's body is never touched.
import { decideWithdraw } from "../core/blyg";
import { buildEndcapFileText } from "../core/frontmatter";
import { renderSourcesYaml } from "../core/sources";
import type { NoteRef } from "../platform/ports";
import { M } from "./messages";
import { CHANNEL_KEY, localBlygId } from "./blyg";
import { logError, lookupCommittedBlyg } from "./shared";
import { cancelled, commitRecord, failed, noop, refused, type Outcome, type PublishDeps, type WritePreview } from "./types";

export async function withdrawBlyg(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const { settings, github, vault, yaml, clock } = deps;
  if (!github) return refused(deps.githubProblem ?? M.githubNotSetUp);

  if (settings.channel === "production" && vault.frontmatterValue(note, CHANNEL_KEY) === "preview") {
    return refused(M.previewNote(note.path));
  }

  const local = localBlygId(vault.blygId(note));
  if ("invalid" in local) return refused(M.invalidId(local.invalid));
  if (!local.id) return refused(M.noIdToWithdraw);
  const id = local.id;

  const path = `${settings.itemsDir}/${id}.md`;
  const lookup = await lookupCommittedBlyg(deps, path);
  if (lookup.kind === "stop") return lookup.outcome;
  if (lookup.kind === "missing") return failed(M.withdrawCommittedMissing(id, path, settings.branch));

  const decision = decideWithdraw({ id, now: clock.now().toISOString() }, lookup.committed);
  if (decision.action === "already-withdrawn") return noop(M.alreadyWithdrawn);

  const message = `content: withdraw ${lookup.committed.kind === "thread" ? "thread" : "note"} ${id} (v${decision.version})`;
  const preview: WritePreview = {
    action: "withdraw",
    channel: settings.channel,
    branch: settings.branch,
    path,
    noteName: note.name,
    label: lookup.committed.kind,
    id,
    fromVersion: lookup.committed.version,
    toVersion: decision.version,
    before: lookup.body,
    after: "",
    changes: [
      `Version ${lookup.committed.version} → ${decision.version}`,
      "Marked as withdrawn; the published text is emptied",
      ...(lookup.committed.kind === "thread" ? ["The quotes in the thread are removed; its page stays where it was"] : []),
      `The id ${id} stays public forever, as “withdrawn”`,
      "The note in your vault keeps its text",
    ],
    links: [],
    blygNote: false,
    commitMessage: message,
  };
  if (!(await deps.confirm(preview))) return cancelled(M.cancelled);

  let commitSha: string | undefined;
  try {
    const put = await github.putFile({
      path,
      // A withdrawn thread keeps its kind (in the frontmatter) and has no quotes: `blyg_sources: []` (contract §3.5).
      text: buildEndcapFileText(yaml, decision.frontmatter, lookup.committed.kind === "thread" ? renderSourcesYaml([]) : ""),
      message,
      branch: settings.branch,
      sha: lookup.sha,
    });
    if (put.kind === "conflict") return failed(M.conflict(put.status));
    if (put.kind === "not-found") return failed(M.writeNotFound(settings.branch));
    if (put.kind === "error") {
      deps.logger?.warn(`PUT ${path} failed: ${put.status} ${put.message}`);
      return failed(M.withdrawFailed(put.status));
    }
    commitSha = put.commitSha;
  } catch (err) {
    logError(deps, `PUT ${path}`, err);
    return failed(M.networkWithdraw);
  }

  const done: Outcome = {
    status: "committed",
    notices: [M.withdrawn(decision.version, settings.branch, settings.channel)],
    commit: commitRecord(path, message, settings.branch, commitSha),
    id,
    version: decision.version,
  };
  try {
    await vault.updateFrontmatter(note, (fm) => void Object.assign(fm, decision.frontmatter));
  } catch (err) {
    logError(deps, "writing local frontmatter after a successful withdraw", err);
    return { ...done, notices: [M.stampFailedWithdraw(id, decision.version, settings.branch)], localStampFailed: true };
  }
  return done;
}
