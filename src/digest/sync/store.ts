// The synced Daily store (DG16): reads every device's files of `digest/`, joins them (state.ts), and writes only THIS device's files. It hands the rest of the Daily the
// same shapes it always had (an EditionStore, PastEdition records, the AI text cache), so the edition rules, stories and sections are unchanged. Plugin storage only.
import { EDITIONS_KEPT, parseEditions, pruneEditions, type EditionRec, type EditionStore } from "../edition";
import { parseHistory, trimHistory, type PastEdition } from "../history";
import { hashText, parseStore, type LlmStore } from "../llm";
import { FILE_RE, LOCK_TTL_MS, applyChange, emptyState, fileName, joinAll, lockOf, parseState, projectEdition, projectHistory, setReg, storyIdFor, type EdState, type Lock } from "./state";

export interface SyncFs {
  /** The file paths in the folder (not recursive); [] when it does not exist. */
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
}

/** What the old per-device files held; read once, never deleted. */
export interface LegacyPorts {
  editions: () => Promise<unknown>;
  history: () => Promise<unknown>;
  /** The AI texts this device has (migrated with the story that points to a key). */
  entries?: () => Promise<LlmStore["entries"]>;
}

export interface SharedCache {
  entries: LlmStore["entries"];
  sections: LlmStore["sections"];
}

export interface SyncInfo {
  /** The creator of the edition: the device that made it, its name and when. null: no edition. */
  made: { device: string; label: string; at: number; mine: boolean } | null;
  /** Other devices whose files carry this edition. */
  others: number;
  /** Files of other devices that are there but cannot be read yet (still arriving). */
  waiting: boolean;
}

interface Snapshot {
  joined: Map<number, EdState>;
  editions: EditionStore;
  devices: Map<string, { label: string; ids: Set<number> }>;
  unreadable: number;
}

const isJson = (p: string): boolean => p.endsWith(".json") && FILE_RE.test(p.slice(p.lastIndexOf("/") + 1));

export class SyncedDigest {
  /** This device's own states, in memory: the truth for its own file (a failed write is retried at the next change). */
  private own = new Map<number, EdState>();
  private parsed = new Map<string, { sig: string; state: EdState | null }>();
  private snap: Snapshot | null = null;
  /** The editions as the code was given them by `load()`: what `save()` measures its changes against. */
  private loaded: EditionStore = { v: 1, editions: [] };
  private migrated = false;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly fs: SyncFs,
    private readonly dir: string,
    private readonly me: { id: string; label: () => string },
    private readonly now: () => number,
    private readonly legacy?: LegacyPorts,
  ) {}

  /** Called when a refresh read something different from before (a file of another device changed). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** True for a path that belongs to a state file of THIS device (its own writes must not trigger a redraw). */
  isOwnFile(path: string): boolean {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return FILE_RE.test(name) && name.includes(`.${this.me.id}.`);
  }
  isStateFile(path: string): boolean {
    return path.startsWith(`${this.dir}/`) && isJson(path);
  }

  private async read(): Promise<EdState[]> {
    const names = (await this.fs.list(this.dir).catch(() => [])).filter(isJson);
    const live = new Set(names);
    for (const k of [...this.parsed.keys()]) if (!live.has(k)) this.parsed.delete(k);
    const out: EdState[] = [];
    await Promise.all(
      names.map(async (p) => {
        const st = await this.fs.stat(p).catch(() => null);
        const sig = st ? `${st.mtime}:${st.size}` : "?";
        const hit = this.parsed.get(p);
        if (hit && hit.sig === sig && st) return void (hit.state && out.push(hit.state));
        let state: EdState | null = null;
        try {
          state = parseState(await this.fs.read(p));
        } catch {
          state = null;
        }
        this.parsed.set(p, { sig, state });
        if (state) out.push(state);
      }),
    );
    return out;
  }

  private build(files: readonly EdState[]): Snapshot {
    const all = [...files, ...this.own.values()];
    const joined = joinAll(all);
    const devices = new Map<string, { label: string; ids: Set<number> }>();
    for (const s of all) {
      const d = devices.get(s.device) ?? devices.set(s.device, { label: s.label, ids: new Set() }).get(s.device);
      if (d) {
        d.ids.add(s.id);
        if (s.label) d.label = s.label;
      }
    }
    const recs: EditionRec[] = [];
    for (const j of joined.values()) {
      const r = projectEdition(j);
      if (r) recs.push(r);
    }
    const unreadable = [...this.parsed.entries()].filter(([p, v]) => v.state === null && !this.isOwnFile(p)).length;
    return { joined, editions: pruneEditions({ v: 1, editions: recs }), devices, unreadable };
  }

  /** Read every device's files and join them. The first call also migrates this device's old files (never deleting them). */
  async refresh(): Promise<void> {
    const before = this.snap ? this.fingerprint(this.snap) : "";
    const files = await this.read();
    for (const s of files) {
      if (s.device !== this.me.id) continue;
      const mine = this.own.get(s.id);
      const j = mine ? joinAll([mine, s]).get(s.id) : s;
      if (j) this.own.set(s.id, { ...j, device: this.me.id, label: this.me.label() });
    }
    if (!this.migrated) {
      this.migrated = true;
      await this.migrate().catch(() => undefined);
    }
    this.snap = this.build(files);
    if (before !== "" && before !== this.fingerprint(this.snap)) this.listeners.forEach((f) => f());
  }
  private fingerprint(s: Snapshot): string {
    return hashText(JSON.stringify([[...s.joined.values()].map((j) => [j.id, j.clock, j.posts, j.created, j.regs]), s.unreadable])); // by content: a file that changed a value without raising a counter is still seen
  }
  private get snapshot(): Snapshot {
    return this.snap ?? { joined: new Map(), editions: { v: 1, editions: [] }, devices: new Map(), unreadable: 0 };
  }

  private counter(): number {
    let c = 0;
    for (const j of this.snapshot.joined.values()) c = Math.max(c, j.clock);
    return c + 1;
  }
  private stateFor(id: number): EdState {
    let s = this.own.get(id);
    if (!s) this.own.set(id, (s = emptyState(id, this.me.id, this.me.label(), this.now())));
    s.label = this.me.label();
    return s;
  }
  private async persist(s: EdState): Promise<void> {
    s.at = this.now();
    try {
      await this.fs.mkdir(this.dir).catch(() => undefined);
      await this.fs.write(`${this.dir}/${fileName(s.id, this.me.id)}`, JSON.stringify(s));
    } catch {
      /* kept in memory; written with the next change */
    }
  }

  /** The editions of all devices, joined (reads the files first). */
  async load(): Promise<EditionStore> {
    await this.refresh();
    this.loaded = this.snapshot.editions;
    return structuredClone(this.loaded); // the caller changes what it gets; `loaded` stays what the changes are measured against
  }

  /** Save what the code changed: only the facts that differ from what `load()` returned become registers of this device's own files. */
  async save(next: EditionStore): Promise<void> {
    const base = new Map(this.loaded.editions.map((e) => [e.id, e]));
    const counter = this.counter();
    const touched: EdState[] = [];
    for (const e of next.editions) {
      const s = this.stateFor(e.id);
      if (applyChange(s, base.get(e.id) ?? null, e, counter)) touched.push(s);
    }
    for (const s of touched) await this.persist(s);
    this.snap = this.build([...this.parsedStates()]);
    this.loaded = this.snapshot.editions;
    await this.prune();
  }
  private parsedStates(): EdState[] {
    return [...this.parsed.values()].flatMap((v) => (v.state ? [v.state] : []));
  }

  /** Own files of editions older than the kept ones are removed (never another device's file). */
  private async prune(): Promise<void> {
    const ids = [...this.snapshot.joined.keys()].sort((a, b) => b - a).slice(0, EDITIONS_KEPT);
    const keep = new Set(ids);
    for (const [id] of [...this.own]) {
      if (keep.has(id) || ids.length < EDITIONS_KEPT) continue;
      this.own.delete(id);
      await this.fs.remove(`${this.dir}/${fileName(id, this.me.id)}`).catch(() => undefined);
    }
  }

  // ---- the day switcher
  async history(): Promise<{ editions: PastEdition[]; capped: boolean }> {
    await this.refresh();
    const list = [...this.snapshot.joined.values()].flatMap((j) => projectHistory(j) ?? []);
    const t = trimHistory({ v: 1, editions: list });
    return { editions: [...t.editions].reverse(), capped: t.capped === true };
  }
  async putHistory(rec: PastEdition): Promise<void> {
    const s = this.stateFor(rec.id);
    if (setReg(s, "hist", rec, this.counter())) await this.persist(s);
    this.snap = this.build(this.parsedStates());
  }

  // ---- the AI texts (cache): content-keyed, so every device can use what any device wrote
  async cache(): Promise<SharedCache> {
    await this.refresh();
    return this.cacheOf(this.snapshot);
  }
  private cacheOf(snap: Snapshot): SharedCache {
    const entries: LlmStore["entries"] = {};
    const sections: LlmStore["sections"] = {};
    for (const j of snap.joined.values()) {
      const part: Record<string, unknown> = { entries: {}, sections: {} };
      for (const [k, r] of Object.entries(j.regs)) {
        if (k.startsWith("ai/")) (part.entries as Record<string, unknown>)[k.slice(3)] = r.v;
        else if (k.startsWith("sx/")) (part.sections as Record<string, unknown>)[k.slice(3)] = r.v;
      }
      const st = parseStore(part);
      for (const [k, v] of Object.entries(st.entries)) if (!entries[k] || entries[k].at < v.at) entries[k] = v;
      for (const [k, v] of Object.entries(st.sections)) if (!sections[k] || sections[k].at < v.at) sections[k] = v;
    }
    return { entries, sections };
  }
  /** Keep texts this device wrote (keys the shared cache does not have yet) in the files of this edition. */
  async publish(editionId: number, entries: LlmStore["entries"], sections: LlmStore["sections"]): Promise<void> {
    if (!this.snapshot.joined.has(editionId) && !this.own.has(editionId)) return;
    const have = this.cacheOf(this.snapshot);
    const s = this.stateFor(editionId);
    const c = this.counter();
    let changed = false;
    for (const [k, v] of Object.entries(entries)) if (!have.entries[k]) changed = setReg(s, `ai/${k}`, v, c) || changed;
    for (const [k, v] of Object.entries(sections)) if (!have.sections[k]) changed = setReg(s, `sx/${k}`, v, c) || changed;
    if (changed) await this.persist(s);
    this.snap = this.build(this.parsedStates());
  }

  // ---- "writing by <device> since <time>"
  lock(editionId: number): Lock | null {
    return lockOf(this.snapshot.joined.get(editionId), this.me.id, this.now());
  }
  async setLock(editionId: number, on: boolean): Promise<void> {
    const s = this.stateFor(editionId);
    if (setReg(s, "lock", { device: this.me.id, label: this.me.label(), since: this.now(), done: !on }, this.counter())) await this.persist(s);
    this.snap = this.build(this.parsedStates());
  }

  /** What the masthead line says: who made the edition, how many other devices carry it, and whether a file is still arriving. */
  info(editionId: number | null): SyncInfo {
    const snap = this.snapshot;
    const j = editionId === null ? undefined : snap.joined.get(editionId);
    const label = (d: string): string => snap.devices.get(d)?.label || "another device";
    const others = [...snap.devices.entries()].filter(([d, v]) => d !== this.me.id && editionId !== null && v.ids.has(editionId)).length;
    return { made: j?.created ? { device: j.created.d, label: j.created.d === this.me.id ? this.me.label() : label(j.created.d), at: j.created.at, mine: j.created.d === this.me.id } : null, others, waiting: snap.unreadable > 0 };
  }

  // ---- migration of this device's old files (read once; the old files stay)
  private async migrate(): Promise<void> {
    if (!this.legacy) return;
    const eds = parseEditions(await this.legacy.editions().catch(() => null)).editions;
    const texts = eds.length > 0 ? await (this.legacy.entries?.() ?? Promise.resolve({})).catch(() => ({})) : {};
    for (const e of eds) {
      if (this.own.has(e.id)) continue;
      const s = this.stateFor(e.id);
      const byId = new Map<string, string>();
      const rec: EditionRec = { ...e, stories: e.stories.flatMap((st) => {
        const oldest = [...st.posts].sort((a, b) => (e.seen[a] ?? 0) - (e.seen[b] ?? 0) || (a < b ? -1 : 1))[0];
        if (oldest === undefined) return [];
        byId.set(st.id, storyIdFor(oldest));
        return [{ ...st, id: storyIdFor(oldest) }];
      }) };
      applyChange(s, null, rec, 1);
      for (const st of rec.stories) {
        const x = st.textKey ? (texts as LlmStore["entries"])[st.textKey] : undefined;
        if (st.textKey && x) setReg(s, `ai/${st.textKey}`, x, 1);
      }
      await this.persist(s);
    }
    const hist = parseHistory(await this.legacy.history().catch(() => null)).editions;
    for (const h of hist) {
      if (this.parsedStates().some((x) => x.id === h.id && x.regs.hist) || this.own.get(h.id)?.regs.hist) continue;
      const s = this.stateFor(h.id);
      if (setReg(s, "hist", h, 1)) await this.persist(s);
    }
  }
}

export { LOCK_TTL_MS };
