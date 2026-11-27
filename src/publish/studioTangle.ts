// V1-C: what a publish of a thread with `![[+ …]]` spans and `[[+ …]]` placeholders adds to the Studio flow (publish/studio.ts calls these).
// The Studio makes the new items itself, inside the thread's publish, after the one confirmation (`tangle: true`); the plugin's part is the
// count it shows, and, once the Studio answered, the same rewrite the Studio did to its working copy, done to the note, so that the next publish
// does not make the same items a second time (a published id is permanent).
import { stripFrontmatter } from "../core/frontmatter";
import type { NoteRef } from "../platform/ports";
import { scanTangle, rewriteTangled, spanLabel, TANGLE_MAX, type TanglePart } from "../tangle/analyse";
import type { StudioClient } from "../studio/client";
import { studioTextHash } from "../studio/media";
import { M } from "./messages";
import { logError } from "./shared";
import { refused, type Outcome, type PublishDeps, type TangleRow } from "./types";

const words = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 70 ? `${flat.slice(0, 69).trimEnd()}…` : flat;
};

/** The rows of the confirmation window, in source order. */
export const tangleRows = (parts: readonly TanglePart[]): TangleRow[] => parts.map((p) => ({ kind: p.kind, line: p.line, words: words(p.text) }));

/** The `studio` part of the window and the lines of its list of changes. */
export function tangleWindow(parts: readonly TanglePart[]): { tangle: { rows: TangleRow[]; max: number }; changes: string[] } {
  const n = parts.length;
  return {
    tangle: { rows: tangleRows(parts), max: TANGLE_MAX },
    changes: [
      `${n} new item${n === 1 ? "" : "s"} will be made and published first, then the thread.`,
      `Your note changes after that: each span or placeholder becomes a link to its item, so it is never made twice.`,
    ],
  };
}

/** The property that remembers a rewrite that could not be done: one entry per new item, in source order ("span <id>" or "placeholder <id>"). It is removed when the rewrite is done. */
export const REWRITE_PENDING_KEY = "blyg_tangle_pending";

const entryOf = (kind: TanglePart["kind"], id: string): string => `${kind} ${id}`;
const readPendingRewrite = (value: unknown): Array<{ kind: TanglePart["kind"]; id: string }> | null => {
  if (!Array.isArray(value)) return null;
  const out: Array<{ kind: TanglePart["kind"]; id: string }> = [];
  for (const v of value) {
    const m = typeof v === "string" ? /^(span|placeholder) ([0-9a-hjkmnp-tv-z]{26})$/.exec(v) : null;
    if (!m) return null;
    out.push({ kind: m[1] as TanglePart["kind"], id: m[2] as string });
  }
  return out.length > 0 ? out : null;
};

/** What each part becomes in the note, for the line a person can paste when the note could not be rewritten. */
const manualLine = (part: TanglePart, id: string): string => (part.kind === "span" ? (spanLabel(part.text) === "" ? `![[${id}]]` : `![[${id} | ${spanLabel(part.text)}]]`) : `[[${id} | ${part.text}]]`);

/**
 * After the Studio made `made` (its `parts`, in source order) and published the thread: the hash of the Studio's working copy as it now is (what `blyg_sent`
 * takes, so the rewrite the Studio did is not taken for an edit made there), and the note rewritten the same way. Never throws; says what happened.
 */
export async function finishTangle(
  deps: PublishDeps,
  client: StudioClient,
  note: NoteRef,
  itemId: string,
  sent: readonly TanglePart[],
  made: ReadonlyArray<{ id: string }>,
): Promise<{ notices: string[]; sentHash: string | null }> {
  let sentHash: string | null = null;
  const got = await client.getItem(itemId);
  if (got.kind === "ok") sentHash = await studioTextHash(got.value.contentMd);
  const ids = made.map((m) => m.id);
  /** The note could not be rewritten: remember the new items in the note's properties, so the next publish finishes the rewrite instead of making them again. */
  const manual = async (): Promise<string[]> => {
    if (ids.length === sent.length) {
      try {
        await deps.vault.updateFrontmatter(note, (fm) => {
          fm[REWRITE_PENDING_KEY] = sent.map((p, n) => entryOf(p.kind, ids[n] as string));
        });
      } catch (err) {
        logError(deps, "remembering the rewrite that is still to do", err);
      }
    }
    return [M.tangleNotRewritten(ids.length === sent.length ? sent.map((p, n) => manualLine(p, ids[n] as string)) : ids.map((id) => `![[${id}]]`))];
  };
  if (ids.length !== sent.length || !deps.edit) return { notices: await manual(), sentHash };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = stripFrontmatter(await deps.vault.read(note));
      const now = scanTangle(body);
      // The note may have been edited while publishing: it is rewritten only if it still holds the same parts, in the same order.
      if (now.issues.length > 0 || now.parts.length !== sent.length || now.parts.some((p, n) => p.kind !== sent[n]?.kind)) break;
      const rewritten = rewriteTangled(body, ids);
      if (!rewritten.ok) break;
      await deps.edit.replaceBody(note, body, rewritten.text);
      return { notices: [M.tangleDone(ids.length), M.tangleRewritten(ids.length)], sentHash };
    } catch (err) {
      logError(deps, "rewriting the note after tangling", err);
    }
  }
  return { notices: await manual(), sentHash };
}

/**
 * Before a publish: an earlier publish made new items but could not rewrite the note (`blyg_tangle_pending`). Finish that first, so the spans are never made a
 * second time. Null: nothing was pending, or it is finished now (the property is removed) and the publish may go on. Otherwise the outcome that stops it.
 */
export async function finishPendingRewrite(deps: PublishDeps, note: NoteRef): Promise<Outcome | null> {
  const pending = readPendingRewrite(deps.vault.frontmatterValue(note, REWRITE_PENDING_KEY));
  if (deps.vault.frontmatterValue(note, REWRITE_PENDING_KEY) === undefined) return null;
  const clear = async (): Promise<void> => {
    await deps.vault.updateFrontmatter(note, (fm) => {
      delete fm[REWRITE_PENDING_KEY];
    });
  };
  try {
    const body = stripFrontmatter(await deps.vault.read(note));
    const now = scanTangle(body);
    if (pending === null || now.issues.length > 0) return refused(M.tangleRewriteStillPending([]));
    // Nothing left to rewrite (the person replaced the spans by hand): the record has done its job.
    if (now.parts.length === 0) {
      await clear();
      return null;
    }
    const manualLines = pending.map((p) => (p.kind === "span" ? `![[${p.id}]]` : `[[${p.id}]]`));
    if (now.parts.length !== pending.length || now.parts.some((p, n) => p.kind !== pending[n]?.kind) || !deps.edit) return refused(M.tangleRewriteStillPending(manualLines));
    const rewritten = rewriteTangled(body, pending.map((p) => p.id));
    if (!rewritten.ok) return refused(M.tangleRewriteStillPending(manualLines));
    await deps.edit.replaceBody(note, body, rewritten.text);
    await clear();
    return null;
  } catch (err) {
    logError(deps, "finishing the rewrite that was still to do", err);
    return refused(M.tangleRewriteStillPending([]));
  }
}
