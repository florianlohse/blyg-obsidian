// The Daily's editions at run time: the records in plugin storage (`digest-editions.json`, ids only), the clock, and the AI texts of stable stories.
// Operations are queued one after another so the reader's open and the Daily's open cannot overwrite each other.
import type { ReadingPost } from "../studio/reading";
import { livePosts } from "./daily";
import { ensureEdition, parseEditions, windowOf, type EditionRec, type EditionStore } from "./edition";
import { cachedDigest, planClusters, type LlmDeps, type Outcome, type Written } from "./llm";
import type { Cluster } from "./cluster";
import { recordSections, withPostSections } from "./sectionRecord";
import { assignPosts, groupOf, type Grouped } from "./stable";

export interface EditionPorts {
  read: () => Promise<unknown>;
  write: (text: string) => Promise<void>;
  now: () => number;
  /** The setting "Digest time", "HH:MM". */
  time: () => string;
}

export interface EditionInfo {
  id: number;
  since: number;
  until: number;
  grouped: Grouped;
  /** The automatic write's note for this edition (set once it was tried), and what its runs used so far. */
  auto?: { note?: string };
  usage?: { tokens: number; cost: number | null };
}

export class Editions {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly ports: EditionPorts) {}

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async load(): Promise<EditionStore> {
    try {
      return parseEditions(await this.ports.read());
    } catch {
      return parseEditions(null);
    }
  }
  private async save(store: EditionStore): Promise<void> {
    await this.ports.write(JSON.stringify(store)).catch(() => undefined);
  }

  /** The reader or the Daily was opened: make the edition if its cutoff has passed. Nothing is assigned yet. */
  touch(): Promise<void> {
    return this.queue(async () => {
      const r = ensureEdition(await this.load(), this.ports.now(), this.ports.time());
      if (r.created) await this.save(r.store);
    });
  }

  /** Open (or refresh) the current edition with the reader's posts: new posts join their stories or the Mixed bag; the record is saved. */
  open(posts: readonly ReadingPost[]): Promise<EditionInfo> {
    return this.queue(async () => {
      const now = this.ports.now();
      const r = ensureEdition(await this.load(), now, this.ports.time());
      const win = windowOf(r.edition, now);
      const live = livePosts(posts, win.since, win.until);
      const next = assignPosts(r.edition, live, now);
      if (r.created || next !== r.edition) await this.save({ v: 1, editions: [...r.store.editions.filter((e) => e.id !== next.id), next] });
      return { ...win, grouped: groupOf(next, live), ...(next.auto ? { auto: next.auto } : {}), ...(next.usage ? { usage: next.usage } : {}) };
    });
  }

  /** Change the current edition's record; saved. */
  update(id: number, fn: (e: EditionRec) => EditionRec): Promise<void> {
    return this.queue(async () => {
      const store = await this.load();
      const i = store.editions.findIndex((e) => e.id === id);
      const cur = store.editions[i];
      if (!cur) return;
      store.editions[i] = fn(cur);
      await this.save(store);
    });
  }

  /** The one automatic attempt of the current edition: true (and the edition is marked as tried, saved) only if `allowed` says so and no attempt was made before. */
  claimAuto(allowed: (e: EditionRec) => boolean): Promise<boolean> {
    return this.queue(async () => {
      const store = await this.load();
      const cur = store.editions.at(-1);
      if (!cur || cur.auto || !allowed(cur)) return false;
      store.editions[store.editions.length - 1] = { ...cur, auto: {} };
      await this.save(store);
      return true;
    });
  }

  current(): Promise<EditionRec | null> {
    return this.queue(async () => (await this.load()).editions.at(-1) ?? null);
  }
}

/** The AI texts for these stories: the text for the story as it is now, else the text it had (marked with the posts that joined since). */
export async function cachedStories(llm: Pick<LlmDeps, "settings" | "load">, rec: EditionRec | null, clusters: readonly Cluster[]): Promise<Array<Written | null>> {
  const fresh = await cachedDigest(llm, clusters);
  if (!rec) return fresh;
  const store = await llm.load();
  const model = llm.settings().model.trim();
  return fresh.map((w, i) => {
    const c = clusters[i];
    const s = c?.id ? rec.stories.find((x) => x.id === c.id) : undefined;
    if (!c || !s) return w;
    const have = new Set(s.textPosts ?? []);
    if (w) return { ...w, ...(s.textPosts ? { fresh: c.posts.map((p) => p.remoteId).filter((id) => !have.has(id)) } : {}) };
    const e = s.textKey ? store.entries[s.textKey] : undefined;
    if (!e || !s.textPosts) return null;
    return { headline: e.headline, summary: e.summary, model, posts: e.posts, fresh: c.posts.map((p) => p.remoteId).filter((id) => !have.has(id)) };
  });
}

/** After "Write the digest": remember per story the text's key and the posts it was written from, and the story's section; per single post its section. */
export async function rememberWrite(llm: Pick<LlmDeps, "settings">, editions: Editions, id: number, clusters: readonly Cluster[], o: Outcome, singles: readonly ReadingPost[] = []): Promise<void> {
  if (o.status !== "ok") return;
  const plan = planClusters(clusters, llm.settings().model.trim());
  await editions.update(id, (rec) => withPostSections({
    ...rec,
    stories: rec.stories.map((s) => {
      const i = clusters.findIndex((c) => c.id === s.id);
      const it = plan.find((x) => x.index === i);
      const c = clusters[i];
      if (!it || !c || !o.written[i]) return s;
      const sec = o.sections?.find((x) => x.ids.includes(i))?.name;
      return { ...s, textKey: it.cacheKey, textPosts: c.posts.map((p) => p.remoteId), ...(sec ? { section: sec } : {}) };
    }),
  }, singles, o.sections));
}

export { recordSections };
