// Two (or more) devices in memory for the Daily's sync tests: each has its OWN plugin folder (a map of files) and the real SyncedDigest, Editions, History and the
// real shared AI store and write path. Files travel between folders only through `ship`, in whatever order, as copies, partial or as conflict copies.
import { Editions } from "../../src/digest/editionHost";
import { History } from "../../src/digest/history";
import { emptyStore, type LlmDeps, type LlmStore } from "../../src/digest/llm";
import { editorIdFor, withEditor } from "../../src/digest/editorRun";
import { sharedStore, writeShared } from "../../src/digest/sync/aiWrite";
import { SyncedDigest, type LegacyPorts, type SyncFs } from "../../src/digest/sync/store";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import type { ReadingPost } from "../../src/studio/reading";
import type { BlygSettings } from "../../src/settings/schema";
import { createDataUpdater } from "../../src/app/dataUpdater";
import { dataPort, type DataPort } from "../../src/digest/sync/dataPort";
import { keyOf } from "../../src/digest/sync/dataKey";

export const DIR = "plugin/digest";

export class Disk {
  files = new Map<string, { text: string; mtime: number }>();
  private tick = 1;
  put(path: string, text: string): void {
    this.files.set(path, { text, mtime: this.tick++ });
  }
  fs(): SyncFs {
    return {
      list: async (dir) => [...this.files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")),
      read: async (p) => {
        const f = this.files.get(p);
        if (!f) throw new Error("missing");
        return f.text;
      },
      write: async (p, t) => void this.put(p, t),
      mkdir: async () => undefined,
      remove: async (p) => void this.files.delete(p),
      stat: async (p) => {
        const f = this.files.get(p);
        return f ? { mtime: f.mtime, size: f.text.length } : null;
      },
    };
  }
}

/** One device's data.json on a fake disk, written the way the plugin writes it (the real updater: re-read, change, write) and changeable behind the plugin's back (what Sync does). */
export class DataJson {
  /** The file's text (null: none). */
  text: string | null = null;
  writes = 0;
  /** The plugin's own settings keys, as loaded at start; `saveSettings` writes these over whatever is on disk. */
  settings: Record<string, unknown> = { schemaVersion: 1, github: { owner: "o" } };
  private update = createDataUpdater({ load: async (): Promise<unknown> => (this.text === null ? null : (JSON.parse(this.text) as unknown)), save: async (d) => void (this.writes++, (this.text = JSON.stringify(d))) }, () => false);
  get json(): Record<string, unknown> {
    return this.text === null ? {} : (JSON.parse(this.text) as Record<string, unknown>);
  }
  port(): DataPort {
    return dataPort({ load: async (): Promise<unknown> => (this.text === null ? null : (JSON.parse(this.text) as unknown)), update: (c, o) => this.update(c, o) });
  }
  /** What the plugin's settings screen does: write the in-memory settings into what is on disk. */
  saveSettings(change: Record<string, unknown> = {}): Promise<void> {
    Object.assign(this.settings, change);
    return this.update((d) => void Object.assign(d, this.settings));
  }
  /** Sync brings another device's key (the whole top-level key replaced, the rest untouched). */
  arrive(from: DataJson, deviceId: string): void {
    const k = keyOf(deviceId);
    const v = from.json[k];
    if (v !== undefined) this.text = JSON.stringify({ ...this.json, [k]: v });
  }
}

export interface Provider {
  requests: RawRequest[];
  transport: LlmDeps["transport"];
}
const wrap = (text: string): RawResponse => ({ status: 200, headers: {}, text: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } }) });
/** A fake AI provider that counts every request it receives (shared by all devices: it stands for the one provider). */
export function provider(tag = "Headline"): Provider & { tag: string } {
  const p = {
    requests: [] as RawRequest[],
    tag,
    transport: async (r: RawRequest): Promise<RawResponse> => {
      p.requests.push(r);
      const content = (JSON.parse(r.body ?? "") as { messages: Array<{ content: string }> }).messages[0]?.content ?? "";
      if (content.includes("<story id=")) {
        const ids = [...content.matchAll(/<story id="(\d+)">/g)].map((m) => Number(m[1]));
        const posts = [...content.matchAll(/<post id="(\d+)"/g)].map((m) => ({ id: Number(m[1]), line: `Ann on thing ${m[1]}` }));
        return wrap(JSON.stringify({ sections: [{ name: "One", about: "First", stories: ids.filter((i) => i % 3 === 0), posts }, { name: "Two", about: "Second", stories: ids.filter((i) => i % 3 === 1), posts: [] }, { name: "Three", about: "Third", stories: ids.filter((i) => i % 3 === 2), posts: [] }] }));
      }
      const ids = [...content.matchAll(/<cluster id="(\d+)">/g)].map((m) => Number(m[1]));
      return wrap(JSON.stringify({ clusters: ids.map((id) => ({ id, headline: `${p.tag} ${id}`, summary: `Summary ${id}.` })) }));
    },
  };
  return p;
}

export interface Device {
  id: string;
  disk: Disk;
  sync: SyncedDigest;
  editions: Editions;
  history: History;
  llm: LlmDeps;
  local: { store: LlmStore };
  setNow(t: number): void;
  write(clusters: Parameters<typeof writeShared>[1], singles?: readonly ReadingPost[], opts?: { resort?: boolean; auto?: boolean }): ReturnType<typeof writeShared>;
}

/** `_label`: kept so the many callers read as before; devices have no names any more (DG20). */
export function device(id: string, _label: string, prov: Provider, start: number, opts: { data?: DataJson; legacy?: LegacyPorts; time?: string; ceiling?: number; settle?: () => Promise<void>; hold?: boolean } = {}): Device {
  const disk = new Disk();
  let now = start;
  const local = { store: emptyStore() };
  const sync = new SyncedDigest(disk.fs(), DIR, { id }, () => now, opts.legacy, opts.data?.port());
  const editions = new Editions({ read: async () => null, write: async () => undefined, sync: { load: () => sync.load(), save: (s) => sync.save(s), ...(opts.hold ? { hold: (id: number) => sync.hold(id) } : {}) }, now: () => now, time: () => opts.time ?? "07:00" });
  const history = new History({ read: async () => null, write: async () => undefined, sync: { list: () => sync.history(), put: (r) => sync.putHistory(r) } });
  const shared = sharedStore(sync, editions, { load: async () => structuredClone(local.store), save: async (s) => void (local.store = structuredClone(s)) });
  const llm: LlmDeps = {
    settings: () => ({ endpoint: "https://api.example.com/", model: "test-model" }),
    transport: prov.transport,
    getKey: () => "sk-test-0123456789abcdefghijklmnop",
    confirm: async () => true,
    askConsent: async () => true,
    load: shared.load,
    save: shared.save,
    now: () => now,
  };
  const settings = (): BlygSettings["digest"] => ({ useAi: true, endpoint: "https://api.example.com/", model: "test-model", keySecretName: "k", dailyTokenCeiling: opts.ceiling ?? 0, autoWrite: false, time: "07:00" });
  return {
    id, disk, sync, editions, history, llm, local,
    setNow: (t) => void (now = t),
    write: (c, singles = [], o) => writeShared({ llm, settings, editions, history, sync, now: () => now, settle: opts.settle ?? (async () => undefined), voiceOf: (rec) => editorIdFor(rec), withVoice: withEditor }, c, singles, o),
  };
}

/** Copy the files `from` wrote to `to`'s folder (never over `to`'s own). `how`: how they arrive. */
export function ship(from: Device, to: Device, how: { names?: (name: string) => string; cut?: number; only?: (name: string) => boolean } = {}): void {
  for (const [path, f] of from.disk.files) {
    const name = path.slice(DIR.length + 1);
    if (!path.startsWith(`${DIR}/`) || !name.includes(`.${from.id}.`) || (how.only && !how.only(name))) continue;
    to.disk.put(`${DIR}/${how.names ? how.names(name) : name}`, how.cut !== undefined ? f.text.slice(0, how.cut) : f.text);
  }
}

let n = 0;
export const T0 = new Date(2030, 2, 12, 7, 5).getTime();
export const nextId = (): string => `p${String(++n).padStart(25, "0")}`;
export function mkPost(text: string, over: Partial<ReadingPost> & { at?: number } = {}): ReadingPost {
  const { at, ...rest } = over;
  return {
    subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: nextId(), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
    observedAt: new Date(at ?? T0 - 7_200_000).toISOString(), created: null, isReply: false, stubTarget: null, contentHtml: `<p>${text}</p>`, contentMd: "", authorName: "Ann", authorUrl: null, sourceUrl: null, ...rest,
  };
}
const TOPICS = ["harbour lantern tide", "orchard cider press", "glacier survey drone", "market ledger tariff"];
/** Four stories (a post and a reply each) and one lone post. */
export function world(): { items: ReadingPost[]; leads: ReadingPost[] } {
  const items: ReadingPost[] = [];
  const leads: ReadingPost[] = [];
  TOPICS.forEach((t, k) => {
    const a = mkPost(`Secret${k} notes about ${t} and the long walk home today.`, { at: T0 - 7_200_000 + k * 1000 });
    const b = mkPost(`Reply ${k}: yes.`, { isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId }, authorName: "Bo", at: T0 - 7_000_000 + k * 1000 });
    leads.push(a);
    items.push(a, b);
  });
  items.push(mkPost("A lone remark about nothing in particular whatsoever."));
  return { items, leads };
}
