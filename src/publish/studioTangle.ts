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
import type { PendingBlock } from "./studioBlocks";
import type { PublishDeps, TangleRow } from "./types";

const words = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 70 ? `${flat.slice(0, 69).trimEnd()}…` : flat;
};

/** The rows of the confirmation window, in source order. */
export const tangleRows = (parts: readonly TanglePart[]): TangleRow[] => parts.map((p) => ({ kind: p.kind, line: p.line, words: words(p.text) }));

/** The `studio` part of the window and the lines of its list of changes. Paragraphs of notes come first (the plugin publishes them), then the Studio's own new items. */
export function tangleWindow(parts: readonly TanglePart[], blocks: readonly PendingBlock[] = []): { tangle: { rows: TangleRow[]; max: number }; changes: string[] } {
  const n = parts.length + blocks.length;
  const blockRows: TangleRow[] = blocks.map((b) => ({ kind: "block", line: b.line, words: words(b.text), block: { host: b.hostName, id: b.blockId } }));
  return {
    tangle: { rows: [...blockRows, ...tangleRows(parts)], max: TANGLE_MAX },
    changes: [
      `${n} new item${n === 1 ? "" : "s"} will be made and published first, then the thread.`,
      ...(blocks.length > 0 ? [`Each paragraph gets a block id (^…) if it has none and is marked in its note; the paragraph stays where it is.`] : []),
      ...(parts.length > 0 ? [`Your note changes after that: each span or placeholder becomes a link to its item, so it is never made twice.`] : []),
    ],
  };
}

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
  const manual = (): string[] => [M.tangleNotRewritten(ids.length === sent.length ? sent.map((p, n) => manualLine(p, ids[n] as string)) : ids.map((id) => `![[${id}]]`))];
  if (ids.length !== sent.length || !deps.edit) return { notices: manual(), sentHash };
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
  return { notices: manual(), sentHash };
}
