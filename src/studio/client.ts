// Blygger Studio's owner API (contract 5), over the plugin's own http adapter. Statuses are returned as typed results; only network failures
// and timeouts throw (HttpError). The shapes are read defensively: an answer that is not what the plugin expects is an "error", never a guess.
// Every call except the manifest and `capabilities` first passes the contract gate: a Studio that does not speak contract 5 is refused before
// anything is sent to it (docs/plans/S16-contract-5.md §3.2).
import { redact } from "../platform/redact";
import { readWireStub, stubForWire, type StubTarget } from "./stub";
import type { StudioHttp, StudioResponse } from "./http";
import type { StudioCapabilities, StudioCommandDone, StudioFailure, StudioHit, StudioImported, StudioHopper, StudioItem, StudioItemKind, StudioListedItem, StudioManifest, StudioMediaDone, StudioPeek, StudioPreview, StudioProblem, StudioResolvedQuote, StudioResult, StudioSubscription } from "./types";
import { contractVerdict, incompatibleMessage, type ContractVerdict } from "./version";
import { readInboundMention, readReadingPost, type InboundMention, type ReadingPost } from "./reading";

/** What the gate remembers about a Studio's contract (per plugin session, so a publish does not ask every time); "Check connection" asks again. */
export interface ContractCache {
  get(): ContractVerdict | undefined;
  set(verdict: ContractVerdict | undefined): void;
}
export const createContractCache = (): ContractCache => {
  let held: ContractVerdict | undefined;
  return { get: () => held, set: (v) => void (held = v) };
};
/** One cache slot per Studio address inside a store the plugin keeps for the session (a changed address never inherits another Studio's verdict). */
export const contractCacheFor = (store: Map<string, ContractVerdict>, key: string): ContractCache => ({
  get: () => store.get(key),
  set: (v) => void (v === undefined ? store.delete(key) : store.set(key, v)),
});

export interface StudioClient {
  /** Public, no credentials: the manifest at {host}{mount}/blyg.json. */
  manifest(): Promise<StudioResult<StudioManifest>>;
  /** `GET /api/capabilities` (any valid token): which API contract the Studio speaks. Not behind the gate (it feeds it). */
  capabilities(): Promise<StudioResult<StudioCapabilities>>;
  getItem(id: string): Promise<StudioResult<StudioItem>>;
  createItem(input: { kind: StudioItemKind; contentMd: string; stubOf?: StubTarget }): Promise<StudioResult<StudioItem>>;
  /**
   * Set the working copy; `kind` only while the item has never been published (Studio answers 409 after). `stubOf` makes the thread a reply to
   * that target (null: not a reply any more); left out, the reply target is not touched. `expectedRevision` is the revision the caller read:
   * a `conflict` means the item changed in the Studio since. The answer carries the new revision.
   */
  updateItem(id: string, input: { contentMd: string; kind?: StudioItemKind; stubOf?: StubTarget | null }, expectedRevision: number): Promise<StudioResult<StudioItem>>;
  preview(input: { contentMd: string; kind: StudioItemKind; itemId?: string }): Promise<StudioResult<StudioPreview>>;
  /** Deletes an item that was never published (a draft). The Studio refuses (409) for a published one: a published address stays for good. */
  deleteItem(id: string, expectedRevision: number): Promise<StudioResult<null>>;
  /**
   * Upload an image and attach it to an item (`POST /media`, multipart): the Studio keeps it with the item, so the published version retains it.
   * `expectedRevision` is the revision the caller holds; the answer carries the next one (unchanged for a duplicate). Needs `owner:draft`,
   * and `owner:publish` too when the item is already published.
   */
  uploadMedia(input: { itemId: string; expectedRevision: number; bytes: ArrayBuffer; name: string; mime: string; alt: string }): Promise<StudioResult<StudioMediaDone>>;
  /** Publishes the working copy as the next version. Studio makes a new version even when nothing changed: callers check first. */
  publish(id: string, note: string | undefined, expectedRevision: number): Promise<StudioResult<StudioCommandDone>>;
  withdraw(id: string, note: string | undefined, expectedRevision: number): Promise<StudioResult<StudioCommandDone>>;
  /** For the connection check: proves the token works and says how many items there are (`GET /items/summary`). */
  countItems(): Promise<StudioResult<number>>;
  /**
   * Every item of the owner's (drafts, published, withdrawn), with its working copy, for the import (roadmap S7). Pages through the list,
   * at most `ITEM_PAGES` pages of `ITEM_PAGE`: `complete` is false when there were more. A row the plugin cannot read is skipped and counted.
   */
  listItems(): Promise<StudioResult<{ items: StudioListedItem[]; complete: boolean; unreadable: number }>>;
  /** Which of these addresses are items of a blyg, and which item: `POST /api/peek/links` (at most 40 at a time). Needs `owner:read`. */
  classifyLinks(urls: string[]): Promise<StudioResult<Array<{ url: string; target: { origin: string; id: string } | null }>>>;
  /** One item of any blyg, read from its own site without subscribing. Needs `owner:read`. */
  peekItem(origin: string, id: string): Promise<StudioResult<StudioPeek>>;
  /** A subscription (whose blyg it is, and its title). Needs `owner:read`. */
  getSubscription(id: string): Promise<StudioResult<StudioSubscription>>;
  /** The owner's hoppers, oldest first (roadmap S13). Needs `owner:read`. */
  listHoppers(): Promise<StudioResult<StudioHopper[]>>;
  /** The ids of the owner's own items in one hopper (rows of `GET /hoppers/{id}/memberships` under `~own`); `complete` is false when the walk stopped at its page cap with more to read. Needs `owner:read`. */
  hopperMembers(hopperId: string): Promise<StudioResult<{ ids: string[]; complete: boolean }>>;
  /** Put one of the owner's items into a hopper; doing it twice changes nothing. Needs `owner:manage`. */
  addToHopper(hopperId: string, itemId: string): Promise<StudioResult<null>>;
  /** Take one of the owner's items out of a hopper; doing it twice changes nothing. Needs `owner:manage`. */
  removeFromHopper(hopperId: string, itemId: string): Promise<StudioResult<null>>;
  /** The quote picker's list: this Studio's items and the ones imported from blygs the owner reads. An empty `q` lists the newest. */
  search(input: { q?: string; source?: "all" | "mine" | "imported"; limit?: number }): Promise<StudioResult<{ items: StudioHit[] }>>;
  /**
   * How many verified, not hidden inbound mentions point at this item (other blygs quoting, linking or answering it). Asks for the item's own
   * rows (`targetItemId`) and pages through them, at most `MENTION_PAGES` pages: `complete` is false when there were more.
   */
  countMentions(itemId: string): Promise<StudioResult<{ count: number; complete: boolean }>>;
  /** An imported item (its HTML is what a reader of this Studio sees, and what a passage is chosen from). */
  getImported(subscriptionId: string, id: string): Promise<StudioResult<StudioImported>>;
  /** POC (S15): the posts the owner reads, newest first as the Studio orders them (`GET /reading/imported`, `owner:read`), at most `maxPages` pages of 50. */
  listReading(maxPages?: number): Promise<StudioResult<{ posts: ReadingPost[]; complete: boolean; unreadable: number }>>;
  /** POC (S15): inbound mentions of the owner's items (`GET /mentions?direction=inbound`, `owner:read`), verified and not hidden only. */
  listInboundMentions(maxPages?: number): Promise<StudioResult<{ mentions: InboundMention[]; complete: boolean; unreadable: number }>>;
  /** POC (S15): mark one version of a post read. Needs the token scope `reading:state`, which the plugin's token does not carry today: a 403 comes back as `forbidden`. */
  markRead(subscriptionId: string, remoteId: string, version: number): Promise<StudioResult<{ readVersion: number | null }>>;
  /** S15: ask the Studio to fetch every blyg it reads now (`POST /subscriptions/poll`, `owner:manage`). The fetch runs in the background; `polling` is how many. */
  pollSubscriptions(): Promise<StudioResult<{ polling: number }>>;
  /** S15: the Studio's change counters (`GET /changes`, `owner:read`): cheap, to see whether the reading list moved without walking it. */
  changes(): Promise<StudioResult<{ epoch: string; domains: Record<string, number> }>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Problems a preview names (`errors`, `linkErrors`), or that a refusal carries in `details`. */
function problemsOf(json: unknown): StudioProblem[] {
  if (!isRecord(json)) return [];
  const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
  const details = isRecord(json.details) ? json.details : {};
  const raw = [...listOf(json.errors), ...listOf(json.linkErrors), ...listOf(details.errors), ...listOf(details.linkErrors)];
  return raw.flatMap((e): StudioProblem[] => {
    if (!isRecord(e)) return [];
    const reason = str(e.reason);
    if (reason === null) return [];
    const directive = str(e.directive);
    return [{ ...(directive !== null ? { directive: directive.slice(0, 80) } : {}), reason: reason.slice(0, 200) }];
  });
}

/** Studio's error code (`{code, message, details}`), or null. */
const codeOf = (res: StudioResponse): string | null => (isRecord(res.json) ? str(res.json.code) : null);

/** Studio's own words for a refusal, shortened and with anything token-shaped removed. */
function apiMessage(res: StudioResponse, token: string | null): string {
  const message = isRecord(res.json) && typeof res.json.message === "string" ? res.json.message : "";
  return redact(message, token ? [token] : []).slice(0, 300);
}

function quotesOf(json: unknown): StudioResolvedQuote[] {
  if (!isRecord(json) || !Array.isArray(json.transclusions)) return [];
  return (json.transclusions as unknown[]).flatMap((t): StudioResolvedQuote[] => {
    if (!isRecord(t) || typeof t.id !== "string" || typeof t.version !== "number") return [];
    const exact = isRecord(t.selector) ? str(t.selector.exact) : null;
    return [{ id: t.id, version: t.version, passage: exact, origin: str(t.origin) }];
  });
}

function readHit(json: unknown): StudioHit | null {
  if (!isRecord(json)) return null;
  const { id, kind, version, label, excerpt, source } = json;
  if (typeof id !== "string" || typeof version !== "number" || (kind !== "fragment" && kind !== "thread")) return null;
  if (source !== "mine" && source !== "imported") return null;
  return { id, kind, version, label: str(label) ?? "", excerpt: str(excerpt) ?? "", source, subscriptionId: str(json.subscriptionId), sourceTitle: str(json.sourceTitle) };
}

const MENTION_PAGE = 100;
const ITEM_PAGE = 100;
const ITEM_PAGES = 50;
const HOPPER_PAGE = 100;
const HOPPER_PAGES = 10;
/** The Studio's name for the owner's own items in a hopper (upstream `OWN_SUBSCRIPTION`). */
const OWN = "~own";
const MENTION_PAGES = 5;

export function readItem(json: unknown): StudioItem | null {
  if (!isRecord(json)) return null;
  const { id, revision, kind, status, version, contentMd, dirty } = json;
  if (typeof id !== "string" || typeof version !== "number" || typeof contentMd !== "string" || typeof dirty !== "boolean") return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;
  if (status !== "draft" && status !== "public" && status !== "withdrawn") return null;
  if (kind !== "fragment" && kind !== "thread") return null;
  let published: StudioItem["published"] = null;
  if (isRecord(json.published)) {
    const p = json.published;
    if (typeof p.version === "number" && typeof p.contentMd === "string" && typeof p.contentHash === "string") {
      published = { version: p.version, contentMd: p.contentMd, contentHtml: str(p.contentHtml) ?? "", contentHash: p.contentHash, note: str(p.note) };
    }
  }
  return { id, revision, kind, status, version, contentMd, dirty, created: str(json.created), updated: str(json.updated), stubOf: readWireStub(json.stubOf), published };
}

/** A row of the owner's item list: an item plus its creation time; null when it is not in the expected form. */
export function readListedItem(json: unknown): StudioListedItem | null {
  const item = readItem(json);
  if (!item || !isRecord(json)) return null;
  const created = str(json.created) ?? "";
  return { ...item, created };
}

/** `{page: {nextCursor}}` of a list answer: the cursor, null for the last page, undefined when the answer is not in that form. */
function nextCursorOf(json: unknown): string | null | undefined {
  if (!isRecord(json) || !isRecord(json.page)) return undefined;
  const next = json.page.nextCursor;
  return next === null ? null : typeof next === "string" && next !== "" ? next : undefined;
}

export function createStudioClient(deps: { http: StudioHttp; token: string; gate?: ContractCache }): StudioClient {
  const { http, token } = deps;
  const gateCache = deps.gate ?? createContractCache();

  /** Map a non-success answer to a failure; the caller reads the success itself. */
  const failure = (res: StudioResponse): StudioFailure => {
    const message = apiMessage(res, token);
    const code = codeOf(res);
    if (res.status === 401) return { kind: "unauthorized", message };
    if (res.status === 403) return { kind: "forbidden", message };
    if (res.status === 404) return { kind: "not-found" };
    if (res.status === 409 && code === "revision-conflict") {
      const details = isRecord(res.json) && isRecord(res.json.details) ? res.json.details : {};
      return { kind: "conflict", itemId: str(details.itemId) ?? "", expectedRevision: typeof details.expectedRevision === "number" ? details.expectedRevision : 0 };
    }
    if (res.status === 429) return { kind: "error", status: 429, message: "The Studio is limiting requests. Wait a minute and try again." };
    if (res.status >= 400 && res.status < 500) return { kind: "rejected", status: res.status, message, problems: problemsOf(res.json), ...(code ? { code } : {}) };
    return { kind: "error", status: res.status, message };
  };
  const unreadable = (res: StudioResponse): StudioFailure => ({ kind: "error", status: res.status, message: "The Studio's answer is not in the form this plugin expects." });

  const itemResult = (res: StudioResponse, okStatuses: number[]): StudioResult<StudioItem> => {
    if (!okStatuses.includes(res.status)) return failure(res);
    const item = readItem(res.json);
    return item ? { kind: "ok", value: item } : unreadable(res);
  };

  /**
   * Read a cursor-paged list: follow `page.nextCursor` until it is null, at most `maxPages` pages. A relevant change in the middle of a walk
   * answers 409 `cursor-expired`: the walk is thrown away and started again from page 1, once (never appended to the old prefix); a second
   * expiry is reported. `complete` is false when the page cap was hit with more to read.
   */
  async function walk<T>(path: string, query: Record<string, string>, pageSize: number, maxPages: number, readRow: (row: unknown) => T | null): Promise<StudioResult<{ rows: T[]; complete: boolean; unreadable: number }>> {
    for (let restart = 0; restart < 2; restart++) {
      const rows: T[] = [];
      let skipped = 0;
      let cursor: string | null = null;
      let expired = false;
      for (let page = 0; page < maxPages; page++) {
        const res: StudioResponse = await http.send(token, { area: "api", path, query: { ...query, limit: String(pageSize), ...(cursor !== null ? { cursor } : {}) } });
        if (res.status === 409 && codeOf(res) === "cursor-expired") {
          expired = true;
          break;
        }
        if (res.status !== 200) return failure(res);
        if (!isRecord(res.json) || !Array.isArray(res.json.items)) return unreadable(res);
        for (const row of res.json.items as unknown[]) {
          const read = readRow(row);
          if (read === null) skipped++;
          else rows.push(read);
        }
        const next = nextCursorOf(res.json);
        if (next === undefined) return unreadable(res);
        if (next === null) return { kind: "ok", value: { rows, complete: true, unreadable: skipped } };
        cursor = next;
      }
      if (!expired) return { kind: "ok", value: { rows, complete: false, unreadable: skipped } };
    }
    return { kind: "error", status: 409, message: "The list kept changing while it was being read. Try again in a moment." };
  }

  const capabilities = async (): Promise<StudioResult<StudioCapabilities>> => {
    const res = await http.send(token, { area: "api", path: "/capabilities" });
    if (res.status !== 200) return failure(res);
    if (!isRecord(res.json) || typeof res.json.contractVersion !== "string") return unreadable(res);
    return { kind: "ok", value: { contractVersion: res.json.contractVersion } };
  };

  /** Null when the Studio speaks a supported contract; otherwise why not. Asks once per session (the cache), and again after "Check connection". */
  const refusal = async (): Promise<StudioFailure | null> => {
    let verdict = gateCache.get();
    if (verdict === undefined) {
      const caps = await capabilities();
      if (caps.kind === "ok") verdict = contractVerdict(caps.value.contractVersion);
      else if (caps.kind === "not-found" || (caps.kind === "rejected" && caps.status === 405)) verdict = { kind: "studio-older", contract: null };
      else return caps;
      gateCache.set(verdict);
    }
    return verdict.kind === "ok" ? null : { kind: "incompatible", which: verdict.kind, message: incompatibleMessage(verdict.kind) };
  };
  /** Wraps a call so that it only goes out to a Studio of a supported contract. */
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<StudioResult<R>>) => async (...args: A): Promise<StudioResult<R>> => (await refusal()) ?? call(...args);

  const inner = {
    manifest: async (): Promise<StudioResult<StudioManifest>> => {
      const res = await http.send(null, { area: "public", path: "/blyg.json" });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json)) return unreadable(res);
      const { generator, blyg, site, title } = res.json;
      if (typeof blyg !== "string") return unreadable(res);
      return { kind: "ok", value: { generator: str(generator) ?? "", protocol: blyg, site: str(site) ?? "", title: str(title) ?? "" } };
    },

    getItem: async (id: string) => {
      return itemResult(await http.send(token, { area: "api", path: `/items/${encodeURIComponent(id)}` }), [200]);
    },

    createItem: async ({ kind, contentMd, stubOf }: { kind: StudioItemKind; contentMd: string; stubOf?: StubTarget }) => {
      const body = { mode: "blank", kind, contentMd, ...(stubOf ? { stubOf: stubForWire(stubOf) } : {}) };
      return itemResult(await http.send(token, { method: "POST", area: "api", path: "/items", body }), [201, 200]);
    },

    updateItem: async (id: string, { contentMd, kind, stubOf }: { contentMd: string; kind?: StudioItemKind; stubOf?: StubTarget | null }, expectedRevision: number) => {
      const body = { contentMd, expectedRevision, ...(kind ? { kind } : {}), ...(stubOf === undefined ? {} : { stubOf: stubOf === null ? null : stubForWire(stubOf) }) };
      return itemResult(await http.send(token, { method: "PATCH", area: "api", path: `/items/${encodeURIComponent(id)}`, body }), [200]);
    },

    uploadMedia: async ({ itemId, expectedRevision, bytes, name, mime, alt }: { itemId: string; expectedRevision: number; bytes: ArrayBuffer; name: string; mime: string; alt: string }): Promise<StudioResult<StudioMediaDone>> => {
      const fields: Record<string, string> = { itemId, expectedRevision: String(expectedRevision), inline: "true", ...(alt !== "" ? { alt } : {}) };
      const res = await http.send(token, { method: "POST", area: "api", path: "/media", multipart: { fields, file: { field: "file", name, mime, bytes } } });
      if (res.status !== 201 && res.status !== 200) return failure(res);
      const json = res.json;
      if (!isRecord(json) || typeof json.id !== "string" || typeof json.url !== "string") return unreadable(res);
      return { kind: "ok", value: { id: json.id, url: json.url, mime: str(json.mime) ?? mime, duplicate: json.duplicate === true, revision: typeof json.revision === "number" ? json.revision : null } };
    },

    deleteItem: async (id: string, expectedRevision: number): Promise<StudioResult<null>> => {
      // Contract 5 wants a JSON body on DELETE (S16 plan §2); whether Obsidian's requestUrl sends it on iOS is a device step (T1).
      const res = await http.send(token, { method: "DELETE", area: "api", path: `/items/${encodeURIComponent(id)}`, body: { expectedRevision } });
      return res.status === 200 ? { kind: "ok", value: null } : failure(res);
    },

    preview: async ({ contentMd, kind, itemId }: { contentMd: string; kind: StudioItemKind; itemId?: string }): Promise<StudioResult<StudioPreview>> => {
      const res = await http.send(token, { method: "POST", area: "api", path: "/preview", body: { contentMd, kind, ...(itemId ? { itemId } : {}) } });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json) || typeof res.json.html !== "string") return unreadable(res);
      return { kind: "ok", value: { html: res.json.html, problems: problemsOf(res.json), quotes: quotesOf(res.json) } };
    },

    publish: async (id: string, note: string | undefined, expectedRevision: number): Promise<StudioResult<StudioCommandDone>> => {
      const res = await http.send(token, { method: "POST", area: "api", path: `/items/${encodeURIComponent(id)}/publish`, body: { expectedRevision, ...(note ? { note } : {}) } });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json) || typeof res.json.version !== "number" || typeof res.json.revision !== "number") return unreadable(res);
      const warning = str(res.json.warning);
      return { kind: "ok", value: { version: res.json.version, revision: res.json.revision, ...(warning ? { warning: warning.slice(0, 300) } : {}) } };
    },

    withdraw: async (id: string, note: string | undefined, expectedRevision: number): Promise<StudioResult<StudioCommandDone>> => {
      const res = await http.send(token, { method: "POST", area: "api", path: `/items/${encodeURIComponent(id)}/withdraw`, body: { expectedRevision, ...(note ? { note } : {}) } });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json) || typeof res.json.version !== "number" || typeof res.json.revision !== "number") return unreadable(res);
      return { kind: "ok", value: { version: res.json.version, revision: res.json.revision } };
    },

    search: async ({ q, source, limit }: { q?: string; source?: "all" | "mine" | "imported"; limit?: number }): Promise<StudioResult<{ items: StudioHit[] }>> => {
      const query: Record<string, string> = { limit: String(limit ?? 20), source: source ?? "all" };
      if (q && q.trim() !== "") query.q = q.trim();
      const res = await http.send(token, { area: "api", path: "/search", query });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json) || !Array.isArray(res.json.items)) return unreadable(res);
      return { kind: "ok", value: { items: (res.json.items as unknown[]).flatMap((row) => readHit(row) ?? []) } };
    },

    getImported: async (subscriptionId: string, id: string): Promise<StudioResult<StudioImported>> => {
      const res = await http.send(token, { area: "api", path: `/imports/${encodeURIComponent(subscriptionId)}/${encodeURIComponent(id)}` });
      if (res.status !== 200) return failure(res);
      const j = res.json;
      if (!isRecord(j) || typeof j.version !== "number" || typeof j.contentHtml !== "string" || (j.kind !== "fragment" && j.kind !== "thread")) return unreadable(res);
      return { kind: "ok", value: { id, kind: j.kind, version: j.version, state: j.state === "tombstone" ? "tombstone" : "current", contentHtml: j.contentHtml } };
    },

    countMentions: async (itemId: string): Promise<StudioResult<{ count: number; complete: boolean }>> => {
      const walked = await walk("/mentions", { direction: "inbound", targetItemId: itemId }, MENTION_PAGE, MENTION_PAGES, (row) => (isRecord(row) ? row : null));
      if (walked.kind !== "ok") return walked;
      const count = walked.value.rows.filter((row) => row.targetItemId === itemId && row.status === "verified" && row.hidden !== true).length;
      return { kind: "ok", value: { count, complete: walked.value.complete } };
    },

    listReading: async (maxPages = 4) => {
      const walked = await walk("/reading/imported", {}, 50, maxPages, readReadingPost);
      if (walked.kind !== "ok") return walked;
      return { kind: "ok", value: { posts: walked.value.rows, complete: walked.value.complete, unreadable: walked.value.unreadable } } as const;
    },

    listInboundMentions: async (maxPages = 2) => {
      const walked = await walk("/mentions", { direction: "inbound" }, MENTION_PAGE, maxPages, readInboundMention);
      if (walked.kind !== "ok") return walked;
      const mentions = walked.value.rows.filter((m) => m.status === "verified" && !m.hidden);
      return { kind: "ok", value: { mentions, complete: walked.value.complete, unreadable: walked.value.unreadable } } as const;
    },

    markRead: async (subscriptionId: string, remoteId: string, version: number) => {
      const res = await http.send(token, { method: "PUT", area: "api", path: `/reading/${encodeURIComponent(subscriptionId)}/${encodeURIComponent(remoteId)}/read`, body: { version, readAt: new Date().toISOString() } });
      if (res.status !== 200) return failure(res);
      const readVersion = isRecord(res.json) && typeof res.json.readVersion === "number" ? res.json.readVersion : null;
      return { kind: "ok", value: { readVersion } } as const;
    },

    pollSubscriptions: async () => {
      const res = await http.send(token, { method: "POST", area: "api", path: "/subscriptions/poll", body: {} });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json) || typeof res.json.polling !== "number") return unreadable(res);
      return { kind: "ok", value: { polling: res.json.polling } } as const;
    },

    changes: async () => {
      const res = await http.send(token, { area: "api", path: "/changes" });
      if (res.status !== 200) return failure(res);
      const j = res.json;
      if (!isRecord(j) || typeof j.epoch !== "string" || !isRecord(j.domains)) return unreadable(res);
      const domains: Record<string, number> = {};
      for (const [k, v] of Object.entries(j.domains)) if (typeof v === "number") domains[k] = v;
      return { kind: "ok", value: { epoch: j.epoch, domains } } as const;
    },

    listItems: async (): Promise<StudioResult<{ items: StudioListedItem[]; complete: boolean; unreadable: number }>> => {
      const walked = await walk("/items", {}, ITEM_PAGE, ITEM_PAGES, readListedItem);
      if (walked.kind !== "ok") return walked;
      return { kind: "ok", value: { items: walked.value.rows, complete: walked.value.complete, unreadable: walked.value.unreadable } };
    },

    classifyLinks: async (urls: string[]) => {
      const res = await http.send(token, { method: "POST", area: "api", path: "/peek/links", body: { urls } });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json) || !Array.isArray(res.json.links)) return unreadable(res);
      const links = (res.json.links as unknown[]).flatMap((row) => {
        if (!isRecord(row) || typeof row.url !== "string") return [];
        const t = row.target;
        const target = isRecord(t) && typeof t.origin === "string" && typeof t.id === "string" ? { origin: t.origin, id: t.id } : null;
        return [{ url: row.url, target }];
      });
      return { kind: "ok" as const, value: links };
    },

    peekItem: async (origin: string, id: string): Promise<StudioResult<StudioPeek>> => {
      const res = await http.send(token, { area: "api", path: "/peek", query: { origin, id } });
      if (res.status !== 200) return failure(res);
      const j = res.json;
      if (!isRecord(j) || typeof j.id !== "string" || typeof j.origin !== "string" || typeof j.version !== "number") return unreadable(res);
      const kind = j.kind === "fragment" || j.kind === "thread" || j.kind === "withdrawn" ? j.kind : null;
      if (kind === null) return unreadable(res);
      return { kind: "ok", value: { origin: j.origin, id: j.id, kind, version: j.version, contentHtml: str(j.contentHtml) ?? "", url: str(j.url) ?? "", subscriptionId: str(j.subscriptionId) } };
    },

    getSubscription: async (id: string): Promise<StudioResult<StudioSubscription>> => {
      const res = await http.send(token, { area: "api", path: `/subscriptions/${encodeURIComponent(id)}` });
      if (res.status !== 200) return failure(res);
      const j = res.json;
      if (!isRecord(j) || typeof j.id !== "string" || typeof j.origin !== "string") return unreadable(res);
      return { kind: "ok", value: { id: j.id, kind: j.kind === "rss" ? "rss" : "blyg", origin: j.origin, title: str(j.title) ?? "" } };
    },

    listHoppers: async (): Promise<StudioResult<StudioHopper[]>> => {
      const walked = await walk("/hoppers", {}, HOPPER_PAGE, HOPPER_PAGES, (row): StudioHopper | null =>
        isRecord(row) && typeof row.id === "string" && typeof row.name === "string" ? { id: row.id, name: row.name, slug: str(row.slug), public: row.public === true } : null,
      );
      if (walked.kind !== "ok") return walked;
      return { kind: "ok", value: walked.value.rows };
    },

    hopperMembers: async (hopperId: string): Promise<StudioResult<{ ids: string[]; complete: boolean }>> => {
      const walked = await walk(`/hoppers/${encodeURIComponent(hopperId)}/memberships`, {}, HOPPER_PAGE, HOPPER_PAGES, (row): string | null =>
        isRecord(row) && row.subscriptionId === OWN && typeof row.remoteId === "string" ? row.remoteId : null,
      );
      if (walked.kind !== "ok") return walked;
      // Rows of imported items (other subscriptions) are not members we can name; they are skipped, not counted as unreadable here.
      return { kind: "ok", value: { ids: walked.value.rows, complete: walked.value.complete } };
    },

    addToHopper: async (hopperId: string, itemId: string): Promise<StudioResult<null>> => {
      const res = await http.send(token, { method: "PUT", area: "api", path: `/hoppers/${encodeURIComponent(hopperId)}/items/${encodeURIComponent(OWN)}/${encodeURIComponent(itemId)}` });
      return res.status === 200 ? { kind: "ok", value: null } : failure(res);
    },

    removeFromHopper: async (hopperId: string, itemId: string): Promise<StudioResult<null>> => {
      const res = await http.send(token, { method: "DELETE", area: "api", path: `/hoppers/${encodeURIComponent(hopperId)}/items/${encodeURIComponent(OWN)}/${encodeURIComponent(itemId)}` });
      return res.status === 200 ? { kind: "ok", value: null } : failure(res);
    },

    countItems: async (): Promise<StudioResult<number>> => {
      const res = await http.send(token, { area: "api", path: "/items/summary" });
      if (res.status !== 200) return failure(res);
      if (!isRecord(res.json) || typeof res.json.all !== "number") return unreadable(res);
      return { kind: "ok", value: res.json.all };
    },
  };

  return {
    manifest: inner.manifest,
    capabilities,
    getItem: guard(inner.getItem),
    createItem: guard(inner.createItem),
    updateItem: guard(inner.updateItem),
    preview: guard(inner.preview),
    uploadMedia: guard(inner.uploadMedia),
    deleteItem: guard(inner.deleteItem),
    publish: guard(inner.publish),
    withdraw: guard(inner.withdraw),
    countItems: guard(inner.countItems),
    listItems: guard(inner.listItems),
    listReading: guard(inner.listReading),
    listInboundMentions: guard(inner.listInboundMentions),
    markRead: guard(inner.markRead),
    pollSubscriptions: guard(inner.pollSubscriptions),
    changes: guard(inner.changes),
    classifyLinks: guard(inner.classifyLinks),
    peekItem: guard(inner.peekItem),
    getSubscription: guard(inner.getSubscription),
    listHoppers: guard(inner.listHoppers),
    hopperMembers: guard(inner.hopperMembers),
    addToHopper: guard(inner.addToHopper),
    removeFromHopper: guard(inner.removeFromHopper),
    search: guard(inner.search),
    countMentions: guard(inner.countMentions),
    getImported: guard(inner.getImported),
  };
}
