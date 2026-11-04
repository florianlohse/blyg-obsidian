// Contract 5 makes every item command say which revision it acts on (docs/plans/S16-contract-5.md §3.3). A command whose revision is stale
// comes back as a `conflict`: the item changed in the Studio between our read and our write. This is the one rule for all commands:
// read the item again; if its text is still the text we compared (only unrelated state moved), run the command once more with the new
// revision; if the text differs, stop. Never repeat a write over text the user has not seen (Burrow's rule, adopted in the plan).
import { contentHash } from "../core/hash";
import { normalizeContentMd } from "../core/normalize";
import type { StudioClient } from "../studio/client";
import type { StudioResult } from "../studio/types";

/** The text of the Studio's working copy changed under us: nothing further was sent. */
export type ChangedThere = { kind: "changed-there" };

/** `expectedHash` is the hash (core/hash, of normalised text) of the working copy the caller compared or wrote before this command. */
export async function withRevision<T>(
  client: StudioClient,
  id: string,
  revision: number,
  expectedHash: string,
  run: (revision: number) => Promise<StudioResult<T>>,
): Promise<StudioResult<T> | ChangedThere> {
  const first = await run(revision);
  if (first.kind !== "conflict") return first;
  const fresh = await client.getItem(id);
  if (fresh.kind !== "ok") return fresh;
  if ((await contentHash(normalizeContentMd(fresh.value.contentMd))) !== expectedHash) return { kind: "changed-there" };
  const second = await run(fresh.value.revision);
  return second.kind === "conflict" ? { kind: "changed-there" } : second;
}
