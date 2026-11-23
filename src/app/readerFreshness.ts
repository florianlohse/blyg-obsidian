// The reader's freshness check on a Studio that has no change counters (contract 6 removed `GET /changes`, Studio 0.67.0; E1).
//
// The reader watches counters so it can tell "something moved" from "nothing did" without reading the list. Without them it keeps its own two marks, in the
// same shape (ReaderView reads `ChangeMarks` and does not care where they come from):
//  - `reading`: a plain re-read, paced. The mark moves once per CHECK_PAUSE_MS, so a Refresh sees it move (the reader has no watcher of its own since DG6: nothing re-reads on a timer),
//    which is the pause the reader already keeps between checks. (A conditional GET of the list could say "unchanged" for less, but whether iOS's `requestUrl`
//    passes `If-None-Match` and a bodyless 304 through is not known from here; it is a device step, and until it is checked the plain re-read is the honest option.)
//  - `subscriptions`: how many blygs the Studio has fetched since Refresh asked. `GET /subscriptions` lists each blyg's `lastPollAt`; a poll moves it at once
//    (measured on Studio 0.69.0: seconds resolution, updated before the poll answers a second time). The mark counts blygs whose `lastPollAt` changed, which is what the
//    counter's rise once per fetched blyg told the reader. It is only read while a check is running, so an idle reader asks nothing extra.
// Contract 5 Studios that still list `getChanges` never come here: they keep the counters.
import type { ChangeMarks } from "../ui/ReaderView";
import type { StudioClient } from "../studio/client";
import type { StudioResult } from "../studio/types";

/** The reader's own check runs for at most 30 s; the subscriptions are read until a little after that. */
export const CHECK_WINDOW_MS = 35_000;
/** What the marks' `epoch` says: these are not the Studio's counters. */
export const POLLED_EPOCH = "re-read";

export interface PolledFreshness {
  /** Refresh is about to ask the Studio to fetch: remember when each blyg was last fetched, and start watching for the change. */
  startCheck(client: StudioClient): Promise<void>;
  /** The marks now; null when the subscriptions could not be read (the caller backs off as for any failure). */
  marks(client: StudioClient): Promise<StudioResult<ChangeMarks>>;
}

export function createPolledFreshness(deps: { now: () => number; pauseMs: number }): PolledFreshness {
  let lastPollAt: Map<string, string | null> | null = null;
  let windowUntil = 0;
  /** Blygs seen to have been fetched, ever; only rises, as the counter did. */
  let fetched = 0;

  const read = async (client: StudioClient): Promise<StudioResult<Map<string, string | null>>> => {
    const got = await client.listSubscriptions();
    if (got.kind !== "ok") return got;
    return { kind: "ok", value: new Map(got.value.subscriptions.map((s) => [s.id, s.lastPollAt])) };
  };

  return {
    startCheck: async (client) => {
      windowUntil = deps.now() + CHECK_WINDOW_MS;
      lastPollAt = null;
      const got = await read(client);
      if (got.kind === "ok") lastPollAt = got.value;
    },
    marks: async (client) => {
      if (deps.now() < windowUntil) {
        const got = await read(client);
        if (got.kind !== "ok") return got;
        if (lastPollAt !== null) {
          for (const [id, at] of got.value) if (lastPollAt.has(id) && lastPollAt.get(id) !== at) fetched++;
        }
        // A blyg followed during the check, or no baseline (it could not be read): taken as the starting point, not counted.
        lastPollAt = got.value;
      }
      return { kind: "ok", value: { epoch: POLLED_EPOCH, reading: Math.floor(deps.now() / deps.pauseMs), subscriptions: fetched } };
    },
  };
}
