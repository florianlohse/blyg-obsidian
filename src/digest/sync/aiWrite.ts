// "Write the digest" on a synced Daily (DG16): the AI text is written ONCE for the shared edition. Before a write the synced files are read again: texts already there (same
// content key) are reused, so nothing is requested for them; a "writing by <device> since <time>" marker (two minutes) makes a second device wait instead of paying in parallel;
// what this device writes is kept in the files of the edition so the others get it; the cost is added once, to this device's own usage of the shared edition.
import type { Cluster } from "../cluster";
import type { ReadingPost } from "../../studio/reading";
import { addUsage, ceilingRefusal } from "../autoWrite";
import { Editions, cachedStories, rememberWrite } from "../editionHost";
import { buildPast, type History } from "../history";
import { emptyStore, writeDigest, type LlmDeps, type LlmStore, type Outcome } from "../llm";
import { existingSections } from "../sectionRecord";
import type { SyncedDigest } from "./store";
import type { BlygSettings } from "../../settings/schema";

/** The AI cache as every device sees it: this device's own file plus the texts any device kept in the shared edition files. Consent, trail and tally stay in the own file. */
export function sharedStore(sync: SyncedDigest, editions: Editions, own: { load: () => Promise<LlmStore>; save: (s: LlmStore) => Promise<void> }): { load: () => Promise<LlmStore>; save: (s: LlmStore) => Promise<void> } {
  const known = new Set<string>();
  return {
    load: async () => {
      const st = await own.load().catch(() => emptyStore());
      const shared = await sync.cache().catch(() => ({ entries: {}, sections: {} }));
      for (const k of [...Object.keys(st.entries), ...Object.keys(st.sections)]) known.add(k); // older local texts are not published (the migration moves the ones a story points to)
      for (const [k, v] of Object.entries(shared.entries)) {
        known.add(k);
        st.entries[k] ??= v;
      }
      for (const [k, v] of Object.entries(shared.sections)) {
        known.add(k);
        st.sections[k] ??= v;
      }
      return st;
    },
    save: async (store) => {
      await own.save(store);
      const fresh = <T,>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m).filter(([k]) => !known.has(k)));
      const entries = fresh(store.entries);
      const sections = fresh(store.sections);
      const cur = await editions.current();
      if (cur && (Object.keys(entries).length > 0 || Object.keys(sections).length > 0)) {
        await sync.publish(cur.id, entries, sections);
        for (const k of [...Object.keys(entries), ...Object.keys(sections)]) known.add(k);
      }
    },
  };
}

export interface WriteEnv {
  llm: LlmDeps;
  settings: () => BlygSettings["digest"];
  editions: Editions;
  history: History;
  sync: SyncedDigest;
  now: () => number;
}

export async function writeShared(env: WriteEnv, c: readonly Cluster[], singles: readonly ReadingPost[], opts?: { resort?: boolean; auto?: boolean }): Promise<Outcome> {
  const { llm, editions, history, sync } = env;
  const rec = await editions.current(); // reads the synced files again
  const busy = rec ? sync.lock(rec.id) : null;
  if (rec && busy) return { written: await cachedStories(llm, rec, c), status: "cancelled", note: `${busy.label} is writing this digest right now. Its text will appear here when it has been synced.` };
  if (rec) await sync.setLock(rec.id, true);
  try {
    const auto = opts?.auto === true;
    const st = auto ? await llm.load() : null;
    // An automatic run never asks (no consent: nothing is sent), never shows the confirm line, and keeps to the daily ceiling.
    const run: LlmDeps = auto ? { ...llm, askConsent: () => Promise.resolve(false) } : llm;
    const o = await writeDigest(run, c, { singles, existing: existingSections(rec, c, singles), resort: opts?.resort === true, ...(auto && st ? { confirm: false, gate: (e) => ceilingRefusal(env.settings(), st, env.now(), e) } : {}) });
    if (rec) {
      await rememberWrite(llm, editions, rec.id, c, o, singles);
      if (o.status === "ok") {
        if (o.tokens) await editions.update(rec.id, (e) => ({ ...e, usage: addUsage(e.usage, o.tokens ?? 0, o.cost ?? null) }));
        // The history record is made when something was written, not when the texts were only read from the files of another device.
        if (o.written.some(Boolean) && (o.tokens || !(await history.list()).editions.some((e) => e.id === rec.id))) await history.put(buildPast(rec.id, c, o, singles, env.now()));
      } else if (auto) await editions.update(rec.id, (e) => ({ ...e, auto: { note: o.status === "failed" ? `The automatic write did not work: ${o.note ?? "no reason given"}` : (o.note ?? "Not written automatically.") } }));
    }
    return o;
  } finally {
    if (rec) await sync.setLock(rec.id, false).catch(() => undefined);
  }
}
