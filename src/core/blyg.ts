// The Blyg item state machine (docs/CONTRACT.md §3, spec §5 and §9), as pure functions: given what the local note
// says and what is committed, decide what to write. No I/O; the caller supplies time and ids.
import { CONTRACT_MAX_FRAGMENT_CAP } from "../contract";
import { isRecord } from "./frontmatter";
import { EMPTY_CONTENT_HASH } from "./hash";

/** Written into newly published items. The contract calls the key informational; the macro wrote "0.2". */
export const BLYG_FIELD_VERSION = "0.2";

export type BlygKind = "fragment" | "thread";

export interface ChangelogEntry {
  version: number;
  at: string;
  note: string | null;
}

export type BodyCheck =
  | { ok: true }
  | { ok: false; reason: "empty" }
  /** `cap` is the limit that applied: the setting, but never more than the contract allows. */
  | { ok: false; reason: "too-long"; length: number; cap: number };

/**
 * Fragment body rules, checked before any network call. The configured cap can lower the limit but never raise it
 * above the contract's: a longer fragment would commit to the site and then fail its build (docs/CONTRACT.md §3.2).
 */
export function checkFragmentBody(contentMd: string, cap: number): BodyCheck {
  if (contentMd.length === 0) return { ok: false, reason: "empty" };
  const effective = Math.min(cap, CONTRACT_MAX_FRAGMENT_CAP);
  if (contentMd.length > effective) return { ok: false, reason: "too-long", length: contentMd.length, cap: effective };
  return { ok: true };
}

/** The kind a note declares: `blyg_kind: thread` or nothing (a fragment). Anything else is refused, never guessed. */
export function localKind(raw: unknown): { kind: BlygKind } | { invalid: string } {
  if (raw === undefined || raw === null || raw === "" || raw === "fragment") return { kind: "fragment" };
  if (raw === "thread") return { kind: "thread" };
  return { invalid: typeof raw === "string" ? raw : JSON.stringify(raw) };
}

/** What the committed item file says about itself, validated enough to build the next version from. */
export interface CommittedBlyg {
  blyg: string | undefined;
  /** `blyg_kind` of the committed file; absent means a fragment (contract §3.1). */
  kind: BlygKind;
  /** The committed `blyg_sources` / `blyg_links` as parsed (unvalidated: read them with `readSources` / `readLinks`). */
  rawSources: unknown;
  rawLinks: unknown;
  version: number;
  created: string;
  changelog: ChangelogEntry[];
  hash: string | undefined;
  withdrawn: boolean;
}

export type CommittedReadResult = { ok: true; committed: CommittedBlyg } | { ok: false; problem: string };

/**
 * An ISO timestamp as a string. Obsidian's YAML writer leaves timestamps unquoted (`blyg_created: 2026-10-01T10:32:16.835Z`),
 * and a YAML 1.1 parser (js-yaml) reads those back as Date objects, a YAML 1.2 parser as strings. Accept both.
 */
function timestampText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Object.prototype.toString.call(value) === "[object Date]" && !Number.isNaN((value as Date).getTime())) {
    return (value as Date).toISOString();
  }
  return undefined;
}

/** Validate the parsed frontmatter of the committed item. Malformed → refuse, never guess. */
export function readCommittedBlyg(frontmatter: unknown): CommittedReadResult {
  if (!isRecord(frontmatter)) return { ok: false, problem: "its frontmatter is not a mapping" };
  const version = frontmatter.blyg_version ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return { ok: false, problem: "blyg_version is not a whole number" };
  }
  const changelog = frontmatter.blyg_changelog ?? [];
  if (!Array.isArray(changelog)) return { ok: false, problem: "blyg_changelog is not a list" };
  const created = timestampText(frontmatter.blyg_created);
  if (created === undefined) return { ok: false, problem: "blyg_created is missing" };
  const hash = frontmatter.blyg_hash;
  const blyg = frontmatter.blyg;
  const kind = frontmatter.blyg_kind ?? "fragment";
  if (kind !== "fragment" && kind !== "thread") return { ok: false, problem: "blyg_kind is neither fragment nor thread" };
  return {
    ok: true,
    committed: {
      blyg: typeof blyg === "string" ? blyg : undefined,
      kind,
      rawSources: frontmatter.blyg_sources,
      rawLinks: frontmatter.blyg_links,
      version,
      created,
      changelog: changelog as ChangelogEntry[],
      hash: typeof hash === "string" ? hash : undefined,
      withdrawn: frontmatter.blyg_withdrawn === true,
    },
  };
}

export type BlygPublishDecision =
  | { action: "create"; id: string; frontmatter: Record<string, unknown> }
  | { action: "noop" }
  | { action: "update"; id: string; version: number; frontmatter: Record<string, unknown> }
  | { action: "refuse"; reason: "committed-missing" }
  /** The id is already live as another kind; the kind never changes (contract §3.1). */
  | { action: "refuse"; reason: "kind-changed"; committedKind: BlygKind };

/** The `blyg_kind` key, for threads only: fragments never carry it, so every existing file stays byte-identical. */
const kindKey = (kind: BlygKind): Record<string, unknown> => (kind === "thread" ? { blyg_kind: "thread" } : {});

/**
 * Publish of a fragment or a thread. No local id → create a new item. A local id → compare the local hash with the
 * *committed* hash (the true last-published state; a device's own view can be stale): same → no-op, different → next
 * version. A thread also moves to the next version when its sources changed (`sourcesChanged`, contract §3.3).
 * `committed` is null when nothing is committed at the item's path.
 * Key order of the built frontmatter is part of the committed bytes — do not reorder.
 */
export function decideBlygPublish(
  input: { contentHash: string; existingId: string | undefined; now: string; newId: () => string; kind?: BlygKind; sourcesChanged?: boolean },
  committed: CommittedBlyg | null,
): BlygPublishDecision {
  const { contentHash, existingId, now } = input;
  const kind = input.kind ?? "fragment";

  if (existingId === undefined) {
    const id = input.newId();
    return {
      action: "create",
      id,
      frontmatter: {
        blyg: BLYG_FIELD_VERSION,
        blyg_id: id,
        ...kindKey(kind),
        blyg_version: 1,
        blyg_created: now,
        blyg_updated: now,
        blyg_hash: contentHash,
        blyg_changelog: [{ version: 1, at: now, note: null }],
      },
    };
  }

  if (committed === null) return { action: "refuse", reason: "committed-missing" };
  if (committed.kind !== kind) return { action: "refuse", reason: "kind-changed", committedKind: committed.kind };
  if (committed.hash === contentHash && input.sourcesChanged !== true) return { action: "noop" };

  const version = committed.version + 1;
  return {
    action: "update",
    id: existingId,
    version,
    // A publish after a withdrawal un-withdraws (spec §9): the flag is simply not written again.
    frontmatter: {
      blyg: committed.blyg ?? BLYG_FIELD_VERSION,
      blyg_id: existingId,
      ...kindKey(kind),
      blyg_version: version,
      blyg_created: committed.created,
      blyg_updated: now,
      blyg_hash: contentHash,
      blyg_changelog: [...committed.changelog, { version, at: now, note: null }],
    },
  };
}

export type WithdrawDecision =
  | { action: "already-withdrawn" }
  | { action: "withdraw"; version: number; frontmatter: Record<string, unknown> };

/** Endcap (spec §9): version +1, a "withdrawn" changelog entry, the flag, and the hash of the empty body. (A thread's file also gets `blyg_sources: []`.) */
export function decideWithdraw(input: { id: string; now: string }, committed: CommittedBlyg): WithdrawDecision {
  if (committed.withdrawn) return { action: "already-withdrawn" };
  const version = committed.version + 1;
  return {
    action: "withdraw",
    version,
    frontmatter: {
      blyg: committed.blyg ?? BLYG_FIELD_VERSION,
      blyg_id: input.id,
      // A withdrawn thread keeps its kind: its page stays at t/{id}/ (contract §3.5).
      ...kindKey(committed.kind),
      blyg_version: version,
      blyg_created: committed.created,
      blyg_updated: input.now,
      blyg_hash: EMPTY_CONTENT_HASH,
      blyg_withdrawn: true,
      blyg_changelog: [...committed.changelog, { version, at: input.now, note: "withdrawn" }],
    },
  };
}
