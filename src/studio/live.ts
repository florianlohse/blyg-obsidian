// What the panel learns from the Studio itself (docs/plans/S2-studio-client.md §4.7): is the note's item still there, was its working copy
// changed in the Studio, how many other blygs point at it; and the warnings that hold for the whole Studio (the token is about to
// expire, the release is outside the range the plugin was tested with). Everything here is a report: it never changes anything, and
// "the Studio could not be reached" is its own answer, never "not published".
import { contentHash } from "../core/hash";
import { normalizeContentMd } from "../core/normalize";
import type { Clock } from "../platform/ports";
import type { StudioClient } from "./client";
import { expiryVerdict } from "./jwt";
import { CONTRACT_TEXT, contractVerdict, incompatibleMessage, studioVersionVerdict } from "./version";

/** What the Studio holds for one item, at one moment. */
export interface StudioFacts {
  /** `missing`: the Studio has no such item. `unreachable`: the question could not be asked or answered. */
  item: { status: "draft" | "public" | "withdrawn"; version: number; workingHash: string } | "missing" | "unreachable";
  mentions: { count: number; complete: boolean } | null;
  /** The names of the hoppers the item is in (roadmap S13); null when they could not be read. */
  hoppers?: string[] | null;
  at: number;
}

export async function loadStudioFacts(client: StudioClient, id: string, clock: Clock): Promise<StudioFacts> {
  const at = clock.now().getTime();
  try {
    const got = await client.getItem(id);
    if (got.kind === "not-found") return { item: "missing", mentions: null, at };
    if (got.kind !== "ok") return { item: "unreachable", mentions: null, at };
    const item = { status: got.value.status, version: got.value.version, workingHash: await contentHash(normalizeContentMd(got.value.contentMd)) };
    let mentions: StudioFacts["mentions"] = null;
    try {
      const counted = await client.countMentions(id);
      if (counted.kind === "ok") mentions = counted.value;
    } catch {
      // a missing count is shown as nothing, never as zero
    }
    let hoppers: string[] | null = null;
    try {
      const listed = await client.listHoppers();
      if (listed.kind === "ok") {
        const names: string[] = [];
        for (const hopper of listed.value) {
          const members = await client.hopperMembers(hopper.id);
          if (members.kind !== "ok") throw new Error("members");
          // A walk cut off at its cap cannot say "not in it": the whole answer is then unknown, shown as nothing.
          if (!members.value.complete && !members.value.ids.includes(id)) throw new Error("incomplete");
          if (members.value.ids.includes(id)) names.push(hopper.name);
        }
        hoppers = names;
      }
    } catch {
      // unknown is shown as nothing, never as "in no hopper"
    }
    return { item, mentions, hoppers, at };
  } catch {
    return { item: "unreachable", mentions: null, at };
  }
}

/**
 * The working copy was changed in the Studio since the note last sent it, and is not what the note says either: the same test the publish
 * makes before it asks "Overwrite that copy?".
 */
export function editedInStudio(facts: StudioFacts, note: { sent: string | null; localHash: string | null }): boolean {
  if (typeof facts.item === "string") return false;
  return facts.item.workingHash !== note.sent && facts.item.workingHash !== note.localHash;
}

/** Warnings that hold for the whole Studio, as plain sentences. An unreachable Studio gives none here (the item facts say so). */
export async function loadStudioWarnings(client: StudioClient, token: string, clock: Clock): Promise<string[]> {
  const out: string[] = [];
  const expiry = expiryVerdict(token, clock.now());
  if (expiry.kind === "expired") out.push("The Studio token has expired. Create a new one in the Studio (More → Client access) and paste it into the keychain entry.");
  else if (expiry.kind === "soon") out.push(`The Studio token expires in ${expiry.days} day${expiry.days === 1 ? "" : "s"}. Create a new one in the Studio and paste it into the keychain entry.`);
  try {
    const manifest = await client.manifest();
    if (manifest.kind === "ok") {
      const verdict = studioVersionVerdict(manifest.value.generator);
      if (verdict.kind === "unknown-client") out.push(`The address does not announce a Blygger Studio (“${verdict.generator}”).`);
    }
  } catch {
    // no manifest, no stock-Studio warning
  }
  try {
    const caps = await client.capabilities();
    if (caps.kind === "ok") {
      const contract = contractVerdict(caps.value.contractVersion);
      if (contract.kind === "ok") {
        if (contract.newerMinor) out.push(`The Studio's API contract ${contract.contract} is newer than the ${CONTRACT_TEXT} this plugin was tested with. Publishing should still work.`);
      } else out.push(incompatibleMessage(contract.kind));
    } else if (caps.kind === "not-found") out.push(incompatibleMessage("studio-older"));
  } catch {
    // no answer, no contract warning
  }
  return out;
}

/**
 * A small cache with a lifetime, for answers that cost a request: `peek` is instant, `request` starts a load when there is none fresh and
 * tells `onChange` when it arrived. One load per key at a time. `invalidate` forgets (after a publish or withdraw the Studio's answer changed).
 */
export interface LiveCache<T> {
  peek(key: string): T | undefined;
  /** Keys whose answer is older than its lifetime: what a periodic refresh should ask again. */
  expired(): string[];
  request(key: string, onChange: () => void): void;
  invalidate(key?: string): void;
}

export function createLiveCache<T>(deps: { load: (key: string) => Promise<T>; now: () => number; ttlMs: (value: T) => number }): LiveCache<T> {
  const values = new Map<string, { value: T; at: number }>();
  const loading = new Set<string>();
  let epoch = 0;
  return {
    peek: (key) => values.get(key)?.value,
    expired: () => [...values].filter(([, have]) => deps.now() - have.at >= deps.ttlMs(have.value)).map(([key]) => key),
    request(key, onChange) {
      const have = values.get(key);
      if (have && deps.now() - have.at < deps.ttlMs(have.value)) return;
      if (loading.has(key)) return;
      loading.add(key);
      const started = epoch;
      void deps
        .load(key)
        .then((value) => {
          // An invalidation while the question was out means the answer may be about the time before the change: drop it, ask again next time.
          if (started === epoch) values.set(key, { value, at: deps.now() });
          loading.delete(key);
          onChange();
        })
        // A load that fails stores nothing and does not redraw (a redraw would ask again at once): the next natural redraw tries again.
        .catch(() => void loading.delete(key));
    },
    invalidate(key) {
      epoch += 1;
      if (key === undefined) values.clear();
      else values.delete(key);
    },
  };
}
