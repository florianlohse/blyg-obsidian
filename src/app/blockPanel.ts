// V1-C.3: what the panel says about the paragraphs of a note that were published as items (`blyg_blocks`): in sync, changed since it was published (the
// paragraph here differs from what the Studio holds), gone from the note, and so on. The text comparison is local; what the Studio holds comes from the
// panel's own cache of item facts (studio/live.ts), so this never asks the network itself.
import type { VaultPort, NoteRef } from "../platform/ports";
import type { Route } from "../settings/schema";
import { blockContentMd, BLOCKS_KEY, BLOCKS_ORIGIN_KEY } from "../publish/studioBlocks";
import type { StudioFacts } from "../studio/live";
import { localStudioHash } from "../studio/media";
import { sameOrigin } from "../studio/record";
import { paragraphOfBlock, readBlockMap } from "../tangle/blocks";

export type BlockState =
  /** The paragraph is what the Studio holds. */
  | "in-sync"
  /** The paragraph here differs from the item: Publish this paragraph makes a new version. */
  | "changed"
  /** The paragraph with this id is no longer in the note (or is no longer a plain paragraph). The item stays published. */
  | "gone"
  | "withdrawn"
  | "missing"
  /** The Studio could not be asked, or the paragraph cannot be sent as it is now. */
  | "unknown"
  | "checking";

export interface BlockRow {
  blockId: string;
  itemId: string;
  /** The first words of the paragraph, or null when it is gone. */
  excerpt: string | null;
  /** 1-based line in the note's text, or null when the paragraph is gone. */
  line: number | null;
  state: BlockState;
  version: number | null;
}

/** At most this many are listed (the rest are counted): each asks the Studio about its item (cached), so the number is kept small. */
export const MAX_BLOCK_ROWS = 10;

export async function loadBlockRows(env: {
  vault: VaultPort;
  routes: Route[];
  fragmentCharCap: number;
  origin: string;
  /** What the panel knows about an item (a cached answer; it starts a fetch in the background). */
  facts: (itemId: string) => StudioFacts | undefined;
}, note: NoteRef): Promise<{ rows: BlockRow[]; more: number }> {
  const map = readBlockMap(env.vault.frontmatterValue(note, BLOCKS_KEY));
  const origin = env.vault.frontmatterValue(note, BLOCKS_ORIGIN_KEY);
  const entries = Object.entries(map);
  if (entries.length === 0 || !(typeof origin === "string" && sameOrigin(origin, env.origin))) return { rows: [], more: 0 };
  const raw = await env.vault.read(note);
  const rows: BlockRow[] = [];
  for (const [blockId, itemId] of entries.slice(0, MAX_BLOCK_ROWS)) {
    const found = paragraphOfBlock(raw, blockId);
    if (!found) {
      rows.push({ blockId, itemId, excerpt: null, line: null, state: "gone", version: null });
      continue;
    }
    const excerpt = found.text.replace(/\s+/g, " ").slice(0, 70);
    const facts = env.facts(itemId);
    const prepared = blockContentMd(found.text, { vault: env.vault, routes: env.routes, fromPath: note.path, origin: env.origin, fragmentCharCap: env.fragmentCharCap });
    let state: BlockState;
    let version: number | null = null;
    if (!facts) state = "checking";
    else if (facts.item === "missing") state = "missing";
    else if (facts.item === "unreachable" || !prepared.ok) state = "unknown";
    else {
      version = facts.item.version;
      state = facts.item.status === "withdrawn" ? "withdrawn" : facts.item.workingHash === (await localStudioHash(prepared.contentMd)) ? "in-sync" : "changed";
    }
    rows.push({ blockId, itemId, excerpt, line: found.startLine, state, version });
  }
  return { rows, more: Math.max(0, entries.length - MAX_BLOCK_ROWS) };
}
