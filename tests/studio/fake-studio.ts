// An in-memory Blygger Studio for tests, speaking API contract 5 (Studio 0.51.0, measured against a local Studio on 2026-11-04, see
// docs/architecture/spikes/s16/REPORT.md): camelCase everywhere; every item has a `revision` and every command must send the one it acts on
// (`expectedRevision`, a JSON body also on DELETE), a stale one is `409 revision-conflict`; lists are cursor-paged (`{items, page:
// {limit, nextCursor}}`, no `total`, `offset` is a 400) and a change between two pages answers `409 cursor-expired`; errors are
// `{code, message, details?}`; `GET /api/capabilities` announces the contract. Still true from 0.48: publish checks the fragment cap (400)
// and ALWAYS makes a new version, even for an unchanged item; the kind is fixed after the first publish (409).
// Internally the fake keeps snake_case field names for what the tests set up (`content_md`, `remote_id`, ...); only the wire is contract 5.
// tests/studio/operations.test.ts validates every request and answer against the 0.51.0 OpenAPI file.
import { createHash } from "node:crypto";
import type { RawRequest, RawResponse } from "../../src/platform/http";

export const STUDIO_HOST = "https://studio.test";
export const STUDIO_ORIGIN = `${STUDIO_HOST}/`;

/** A token shaped like Studio's (a JWT) with a given expiry and scopes; the signature part is junk (the plugin never verifies it). */
export function makeToken(opts: { expSeconds: number; scope?: string }): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ typ: "at+jwt", alg: "RS256" })}.${b64({ exp: opts.expSeconds, scope: opts.scope ?? "owner:read owner:draft owner:publish" })}.c2lnbmF0dXJl`;
}
export const FAR_FUTURE = Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000);
export const STUDIO_TOKEN = makeToken({ expSeconds: FAR_FUTURE });

interface Version {
  version: number;
  content_md: string;
  content_html: string;
  content_hash: string;
  published_at: string;
  note: string | null;
  media?: Media[];
}
interface Stored {
  id: string;
  /** Contract 5: starts at 1 and goes up with every change of the item (an edit, a publish, a withdrawal). */
  revision: number;
  kind: "fragment" | "thread";
  status: "draft" | "public" | "withdrawn";
  created: string;
  updated: string;
  version: number;
  content_md: string;
  versions: Version[];
  /** Set for an item that answers another (a stub). */
  stub_of?: unknown;
  /** Images attached to the item (`POST /api/media` with this itemId). */
  media?: Media[];
}
interface Media {
  id: string;
  sha: string;
  mime: string;
  alt: string | null;
  inline: boolean;
}
const MEDIA_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

/** An item imported from a blyg the owner reads (what the real Studio keeps after a subscription poll). */
export interface Imported {
  subscription_id: string;
  source_title: string;
  remote_id: string;
  kind: "fragment" | "thread";
  state: "current" | "tombstone";
  version: number;
  content_md: string;
  origin: string;
}

export interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
  /** What the fake answered (set when the request was handled by the fake, not forced). */
  status?: number;
  answer?: unknown;
}

const sha = (t: string): string => `sha256:${createHash("sha256").update(t).digest("hex")}`;
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A valid Blyg id from a counter: 26 characters of the Crockford alphabet. */
export const idOf = (n: number): string => `a${String(n).padStart(25, "0")}`;

export class FakeStudio {
  readonly items = new Map<string, Stored>();
  /** Hoppers, and the owner's items in each (`~own` memberships). */
  readonly hoppers: Array<{ id: string; name: string; slug: string | null; public: boolean; members: Set<string> }> = [];
  /** False: the token lacks owner:manage, so hopper changes answer 403. */
  manage = true;
  readonly imports: Imported[] = [];
  /** Inbound mentions, as the owner's list answers them (newest first by the order added). */
  readonly mentions: Array<{ id: string; target_item_id: string; status: "pending" | "verified" | "failed" | "gone"; relation: string | null; hidden: boolean }> = [];
  readonly seen: Seen[] = [];
  /** Every upload the fake accepted or recognised as a duplicate, as the tests assert them. */
  readonly uploads: Array<{ itemId: string | null; expectedRevision: number | null; alt: string | null; inline: string | null; mime: string; size: number; sha: string; duplicate: boolean }> = [];
  now = "2026-10-22T09:00:00Z";
  generator = "blygger-studio/0.51.0";
  /** What `GET /api/capabilities` announces; null: the Studio has no such route (a release before 0.49.7). */
  contractVersion: string | null = "5.2.0";
  /** Bumped by every change that a list walk depends on; a cursor made before it is `cursor-expired`. */
  private epoch = 0;
  /** Things to do just before the next matching request is handled (a concurrent edit "in the Studio's editor"); each runs once. */
  private readonly beforeRequest: Array<{ method: string; path: RegExp; run: () => void }> = [];
  manifestSite = STUDIO_ORIGIN;
  token = STUDIO_TOKEN;
  /** Problems the preview reports for any text (a bad directive). */
  previewProblems: { directive?: string; reason: string }[] = [];
  /** Forced answers by "METHOD /path" (consumed once); an Error rejects like a network failure. */
  forced = new Map<string, Partial<RawResponse> | Error>();
  private counter = 0;

  readonly transport = (req: RawRequest): Promise<RawResponse> => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const authorization = req.headers.Authorization;
    const seen: Seen = { method: req.method, path, authorization, body: req.body ? (JSON.parse(req.body) as unknown) : req.bodyBytes ? { multipart: req.contentType, bytes: req.bodyBytes.byteLength } : undefined };
    this.seen.push(seen);
    const forced = this.forced.get(`${req.method} ${url.pathname}`);
    if (forced) {
      this.forced.delete(`${req.method} ${url.pathname}`);
      return forced instanceof Error ? Promise.reject(forced) : Promise.resolve({ status: 200, headers: {}, text: "", ...forced });
    }
    const hook = this.beforeRequest.findIndex((h) => h.method === req.method && h.path.test(url.pathname));
    if (hook >= 0) this.beforeRequest.splice(hook, 1)[0]?.run();
    const answered = this.handle(req, url, authorization);
    seen.status = answered.status;
    seen.answer = answered.text === "" ? undefined : (JSON.parse(answered.text) as unknown);
    return Promise.resolve(answered);
  };

  /** Run `run` just before the next request with this method and a path matching `path` is handled, once. */
  onNext(method: string, path: RegExp, run: () => void): void {
    this.beforeRequest.push({ method, path, run });
  }
  /** Every request that changed something. */
  writes(): Seen[] {
    return this.seen.filter((s) => s.method !== "GET" && !s.path.startsWith("/api/preview"));
  }
  /** Add an item as if it had been written in the Studio's own editor. */
  seed(over: Partial<Stored> & { content_md: string }): Stored {
    const item: Stored = { id: idOf(++this.counter), revision: 1, kind: "fragment", status: "draft", created: this.now, updated: this.now, version: 0, versions: [], ...over };
    this.items.set(item.id, item);
    this.epoch++;
    return item;
  }
  /** Items of blyg this Studio does not read, for "peek" (an address pasted for a blyg that is not subscribed). */
  readonly peekable: Array<{ origin: string; id: string; kind: "fragment" | "thread" | "withdrawn"; version: number; content_html: string }> = [];
  private stubShape(v: unknown): boolean {
    const s = v as Record<string, unknown>;
    return typeof s === "object" && s !== null && typeof s.origin === "string" && /^https?:\/\//.test(s.origin) && typeof s.id === "string" && typeof s.version === "number" && s.version >= 1;
  }
  /** What `POST /api/peek/links` makes of an address: the items it knows by their public pages, own or imported or peekable. */
  private classify(address: string): { origin: string; id: string } | null {
    const m = /^(https?:\/\/.+\/)[ft]\/([^/]+)\/$/.exec(address);
    if (!m) return null;
    const origin = m[1] ?? "";
    const id = m[2] ?? "";
    if (origin === STUDIO_ORIGIN || this.imports.some((i) => i.origin === origin && i.remote_id === id) || this.peekable.some((p) => p.origin === origin && p.id === id)) return { origin, id };
    return null;
  }
  /** Add a hopper as if it had been made in the Studio. */
  addHopper(name: string, over: { slug?: string | null; public?: boolean } = {}): { id: string; name: string; slug: string | null; public: boolean; members: Set<string> } {
    const hopper = { id: `h${this.hoppers.length + 1}`, name, slug: over.slug === undefined ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : over.slug, public: over.public ?? false, members: new Set<string>() };
    this.hoppers.push(hopper);
    return hopper;
  }
  /** Edit the working copy there, the way a person in Studio's editor would. */
  editThere(id: string, content_md: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.content_md = content_md;
    item.revision++;
    this.epoch++;
  }
  /** Something other than the text changed in the Studio (a pin, a setting): the item's revision moves, its text does not. */
  touch(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.revision++;
    this.epoch++;
  }
  /** Add an item the Studio imported from another blyg. */
  importItem(over: Partial<Imported> & { remote_id: string; content_md: string }): Imported {
    const item: Imported = { subscription_id: "sub1", source_title: "Blog B", kind: "fragment", state: "current", version: 1, origin: "https://blog-b.test/", ...over };
    this.imports.push(item);
    return item;
  }
  latest(id: string): Version | undefined {
    return this.items.get(id)?.versions.at(-1);
  }

  /** What the real preview resolves in a thread: every `![[id]]` / `![[id | label]]` line that names an item the Studio knows, with the passage of an attached `>` quote. */
  private transclusionsOf(text: string): unknown[] {
    const out: unknown[] = [];
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const m = /^\s*!\[\[([0-9a-hjkmnp-tv-z]{26})(?:\s*\|[^\]]*)?\]\]\s*$/.exec(line);
      if (!m) return;
      const id = m[1] ?? "";
      const quote: string[] = [];
      for (let j = i + 1; j < lines.length && /^\s*>/.test(lines[j] ?? ""); j++) quote.push((lines[j] ?? "").replace(/^\s*>\s?/, ""));
      const own = this.items.get(id);
      const remote = this.imports.find((r) => r.remote_id === id);
      const source = own ? { version: own.version } : remote ? { version: remote.version, origin: remote.origin } : null;
      if (!source) return;
      out.push({ id, ...source, ...(quote.length > 0 ? { selector: { exact: quote.join("\n") } } : {}) });
    });
    return out;
  }
  private mediaView(itemId: string, m: Media): Record<string, unknown> {
    return { id: m.id, itemId, mime: m.mime, alt: m.alt, created: this.now, inline: m.inline, url: `${STUDIO_HOST}/media/${m.id}/${m.sha}.${MEDIA_EXT[m.mime] ?? "bin"}` };
  }
  /** `POST /api/media`: the multipart body is parsed for real, so a wrong boundary or a missing field fails like it would on the Studio. */
  private upload(req: RawRequest): RawResponse {
    const type = /^multipart\/form-data; boundary=(.+)$/.exec(req.contentType ?? "");
    if (!type || !req.bodyBytes) return this.fail(415, "unsupported-media", "multipart/form-data required");
    const raw = Buffer.from(req.bodyBytes);
    const delimiter = Buffer.from(`--${type[1]}`);
    const fields: Record<string, string> = {};
    let file: { mime: string; bytes: Buffer } | null = null;
    let at = raw.indexOf(delimiter);
    while (at !== -1) {
      const next = raw.indexOf(delimiter, at + delimiter.length);
      if (next === -1) break;
      // One part: CRLF, headers, a blank line, the content, CRLF.
      const part = raw.subarray(at + delimiter.length + 2, next - 2);
      const split = part.indexOf("\r\n\r\n");
      const head = part.subarray(0, split).toString("utf8");
      const content = part.subarray(split + 4);
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? "";
      if (/filename="/.test(head)) file = { mime: /Content-Type: ([^\r\n]+)/i.exec(head)?.[1] ?? "", bytes: Buffer.from(content) };
      else fields[name] = content.toString("utf8");
      at = next;
    }
    if (!file) return this.fail(400, "invalid-input", "file field required (multipart)");
    if (!MEDIA_EXT[file.mime]) return this.fail(415, "unsupported-media", `unsupported type ${file.mime || "(none)"}; allowed: png/jpg/gif/webp/svg`);
    if (file.bytes.byteLength > 5 * 1024 * 1024) return this.fail(413, "too-large", "file exceeds 5 MB");
    const itemId = fields.itemId ?? null;
    const item = itemId ? this.items.get(itemId) : undefined;
    if (itemId && !item) return this.fail(404, "not-found", "itemId not found");
    const expected = fields.expectedRevision === undefined ? null : Number(fields.expectedRevision);
    if (item) {
      if (expected === null) return this.fail(400, "invalid-input", "expectedRevision required when attaching media");
      if (expected !== item.revision) return this.fail(409, "revision-conflict", "item revision conflict; reload and try again", { itemId: item.id, expectedRevision: expected });
    }
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    const log = { itemId, expectedRevision: expected, alt: fields.alt ?? null, inline: fields.inline ?? null, mime: file.mime, size: file.bytes.byteLength, sha: digest };
    const same = item?.media?.find((m) => m.sha === digest && m.mime === file.mime);
    if (item && same) {
      this.uploads.push({ ...log, duplicate: true });
      return this.json(200, { id: same.id, url: this.mediaView(item.id, same).url, mime: same.mime, duplicate: true, revision: item.revision });
    }
    const media: Media = { id: `m${(item?.media?.length ?? 0) + 1}${digest.slice(0, 6)}`, sha: digest, mime: file.mime, alt: fields.alt ?? null, inline: fields.inline === "true" };
    this.uploads.push({ ...log, duplicate: false });
    if (!item) return this.json(201, { id: media.id, url: this.mediaView("", media).url, mime: media.mime });
    item.media = [...(item.media ?? []), media];
    item.revision++;
    this.epoch++;
    return this.json(201, { id: media.id, url: this.mediaView(item.id, media).url, mime: media.mime, revision: item.revision });
  }
  private json(status: number, body: unknown): RawResponse {
    return { status, headers: {}, text: JSON.stringify(body) };
  }
  /** Contract 5 error body. */
  private fail(status: number, code: string, message: string, details?: Record<string, unknown>): RawResponse {
    return this.json(status, { code, message, ...(details ? { details } : {}) });
  }
  private view(i: Stored, full: boolean): Record<string, unknown> {
    const latest = i.versions.at(-1);
    const dirty = i.status === "draft" ? true : latest?.content_md !== i.content_md;
    return {
      id: i.id,
      revision: i.revision,
      kind: i.kind,
      status: i.status,
      created: i.created,
      updated: i.updated,
      version: i.version,
      contentMd: i.content_md,
      dirty,
      responses: "default",
      highlight: "default",
      provenance: [],
      stubOf: i.stub_of ?? null,
      forkedFrom: null,
      forkCite: null,
      pins: [],
      ...(full
        ? {
            media: (i.media ?? []).map((x) => this.mediaView(i.id, x)),
            publishedMedia: (latest?.media ?? []).map((x) => this.mediaView(i.id, x)),
            published: latest
              ? { kind: i.kind, itemId: i.id, version: latest.version, contentMd: latest.content_md, contentHtml: latest.content_html, contentHash: latest.content_hash, publishedAt: latest.published_at, note: latest.note, transclusions: [], pinned: false, pinnedAt: null, stubOf: i.stub_of ?? null, stubCite: null, noteGenerated: false, generated: [], changeClass: null }
              : null,
          }
        : {}),
    };
  }

  /** A page of a list, cursor-style: `cursor` is opaque (an offset and the epoch it was made in); a stale epoch is `cursor-expired`. */
  private page(url: URL, rows: unknown[]): RawResponse {
    if (url.searchParams.has("offset")) return this.fail(400, "invalid-input", 'request: Unrecognized key: "offset"');
    const limit = Number(url.searchParams.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return this.fail(400, "invalid-input", "limit: out of range");
    let offset = 0;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null) {
      let parsed: { o?: unknown; e?: unknown } = {};
      try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown; e?: unknown };
      } catch {
        // falls through to the invalid cursor answer
      }
      if (typeof parsed.o !== "number" || typeof parsed.e !== "number") return this.fail(400, "invalid-input", "Invalid cursor for this collection, filters, or order");
      if (parsed.e !== this.epoch) return this.fail(409, "cursor-expired", "Collection changed; restart from its first page");
      offset = parsed.o;
    }
    const next = offset + limit < rows.length ? Buffer.from(JSON.stringify({ o: offset + limit, e: this.epoch })).toString("base64url") : null;
    return this.json(200, { items: rows.slice(offset, offset + limit), page: { limit, nextCursor: next } });
  }

  private handle(req: RawRequest, url: URL, authorization: string | undefined): RawResponse {
    const path = url.pathname;
    if (path === "/blyg.json") {
      return this.json(200, { blyg: "0.4", level: 2, generator: this.generator, site: this.manifestSite, title: "Test blyg", items: "items/index.json" });
    }
    if (!path.startsWith("/api/")) return this.fail(404, "not-found", "not found");
    if (authorization !== `Bearer ${this.token}`) return this.fail(401, "unauthorized", "unauthorized");
    if (path === "/api/capabilities" && req.method === "GET") {
      if (this.contractVersion === null) return this.fail(404, "not-found", "not found");
      return this.json(200, { contractVersion: this.contractVersion, endpoints: { publicBase: STUDIO_HOST, studio: `${STUDIO_HOST}/studio`, api: `${STUDIO_HOST}/api`, issuer: `${STUDIO_HOST}/studio/auth`, mcp: `${STUDIO_HOST}/studio/mcp`, media: `${STUDIO_HOST}/media` }, operations: [], extensions: [] });
    }
    if (path === "/api/media" && req.method === "POST") return this.upload(req);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const m = /^\/api\/items\/([^/]+)(?:\/(publish|withdraw))?$/.exec(path);

    if (path === "/api/hoppers" && req.method === "GET") {
      return this.page(url, this.hoppers.map(({ members: _m, ...h }) => ({ ...h, created: this.now, slugFrozen: h.public, description: null })));
    }
    const mem = /^\/api\/hoppers\/([^/]+)\/memberships$/.exec(path);
    if (mem && req.method === "GET") {
      const hopper = this.hoppers.find((h) => h.id === mem[1]);
      if (!hopper) return this.fail(404, "not-found", "hopper not found");
      return this.page(url, [...hopper.members].map((id) => ({ hopperId: hopper.id, subscriptionId: "~own", remoteId: id, addedAt: this.now, item: null })));
    }
    const hm = /^\/api\/hoppers\/([^/]+)(?:\/items\/([^/]+)\/([^/]+))?$/.exec(path);
    if (hm) {
      const hopper = this.hoppers.find((h) => h.id === hm[1]);
      if (!hopper) return this.fail(404, "not-found", "hopper not found");
      if (hm[2] === "~own" && (req.method === "PUT" || req.method === "DELETE")) {
        if (!this.manage) return this.fail(403, "forbidden", "insufficient_scope");
        if (req.method === "PUT") {
          if (!this.items.has(hm[3] ?? "")) return this.fail(404, "not-found", "item not found");
          hopper.members.add(hm[3] ?? "");
        } else hopper.members.delete(hm[3] ?? "");
        return this.json(200, { ok: true });
      }
    }
    if (path === "/api/items/summary" && req.method === "GET") {
      const all = [...this.items.values()];
      return this.json(200, { all: all.length, drafts: all.filter((i) => i.status === "draft").length, changes: all.filter((i) => i.status === "public" && i.content_md !== i.versions.at(-1)?.content_md).length, public: all.filter((i) => i.status === "public").length, withdrawn: all.filter((i) => i.status === "withdrawn").length });
    }
    if (path === "/api/items" && req.method === "GET") {
      // Newest change first (`updated DESC`; ties: the later added first).
      const all = [...this.items.values()].reverse().sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
      return this.page(url, all.map((i) => this.view(i, false)));
    }
    if (path === "/api/items" && req.method === "POST") {
      const unknown = Object.keys(body).find((k) => !["mode", "kind", "contentMd", "stubOf", "provenance"].includes(k));
      if (unknown) return this.fail(400, "invalid-input", `request: Unrecognized key: "${unknown}"`);
      const kind = body.kind === "thread" ? "thread" : "fragment";
      // Like the real Studio (checked on 0.49.1): a reply is a thread, and the shape is checked.
      if (body.stubOf != null && kind !== "thread") return this.fail(400, "invalid-input", "only threads can be stubs");
      if (body.stubOf != null && !this.stubShape(body.stubOf)) return this.fail(400, "invalid-input", "stubOf: Invalid");
      const item = this.seed({ kind, content_md: typeof body.contentMd === "string" ? body.contentMd : "", ...(body.stubOf != null ? { stub_of: body.stubOf } : {}) });
      return this.json(201, this.view(item, false));
    }
    if (path === "/api/peek/links" && req.method === "POST") {
      const urls = Array.isArray(body.urls) ? (body.urls as string[]) : [];
      return this.json(200, { links: urls.map((url) => ({ url, target: this.classify(url) })) });
    }
    if (path === "/api/peek" && req.method === "GET") {
      const origin = url.searchParams.get("origin") ?? "";
      const id = url.searchParams.get("id") ?? "";
      const held = this.imports.find((i) => i.origin === origin && i.remote_id === id);
      const other = this.peekable.find((p) => p.origin === origin && p.id === id);
      const hit = held ? { origin: held.origin, id: held.remote_id, kind: held.kind, version: held.version, contentHtml: `<p>${esc(held.content_md)}</p>\n`, subscriptionId: held.subscription_id } : other ? { origin: other.origin, id: other.id, kind: other.kind, version: other.version, contentHtml: other.content_html, subscriptionId: null } : null;
      if (!hit) return this.fail(404, "not-found", "that blyg does not serve this item");
      return this.json(200, { page: null, url: `${hit.origin}${hit.kind === "thread" ? "t" : "f"}/${hit.id}/`, ...hit });
    }
    const subm = /^\/api\/subscriptions\/([^/]+)$/.exec(path);
    if (subm && req.method === "GET") {
      const any = this.imports.find((i) => i.subscription_id === subm[1]);
      if (!any) return this.fail(404, "not-found", "not found");
      return this.json(200, { id: any.subscription_id, kind: "blyg", origin: any.origin, feedUrl: `${any.origin}feed.xml`, title: any.source_title, status: "active", lastPollAt: null, failCount: 0, lastIndexSyncAt: null, inBlogroll: false, flags: [], created: this.now, titleFollowsSource: true, hopperFeedUrl: null });
    }
    if (path === "/api/preview" && req.method === "POST") {
      const text = typeof body.contentMd === "string" ? body.contentMd : "";
      return this.json(200, body.kind === "thread" ? { html: `<p>${esc(text)}</p>`, errors: this.previewProblems, transclusions: this.transclusionsOf(text), scopes: [] } : { html: `<p>${esc(text)}</p>`, scopes: [], linkErrors: this.previewProblems });
    }
    if (path === "/api/search" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const source = url.searchParams.get("source") ?? "all";
      const mine = [...this.items.values()]
        .filter((i) => i.status === "public")
        .map((i) => ({ id: i.id, excerpt: i.content_md.slice(0, 80), label: `“${i.content_md.slice(0, 40)}”`, version: i.version, updated: this.now, badge: i.kind, source: "mine", kind: i.kind, subscriptionId: null, sourceTitle: null }));
      const imported = this.imports
        .filter((i) => i.state === "current")
        .map((i) => ({ id: i.remote_id, excerpt: i.content_md.slice(0, 80), label: `“${i.content_md.slice(0, 40)}”`, version: i.version, updated: this.now, badge: i.source_title, source: "imported", kind: i.kind, subscriptionId: i.subscription_id, sourceTitle: i.source_title }));
      const rows = [...(source === "imported" ? [] : mine), ...(source === "mine" ? [] : imported)].filter((r) => q === "" || r.excerpt.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)); // the real Studio matches an id too (checked on 0.51.0)
      return this.page(url, rows);
    }
    if (path === "/api/mentions" && req.method === "GET") {
      const direction = url.searchParams.get("direction") ?? "inbound";
      const target = url.searchParams.get("targetItemId");
      const rows = this.mentions
        .filter((r) => target === null || r.target_item_id === target)
        .map((r) => ({ id: r.id, source: "https://other.test/f/x/", target: "https://studio.test/f/x/", targetItemId: r.target_item_id, status: r.status, relation: r.relation, sourceOrigin: null, sourceId: null, sourceKind: null, sourceVersion: null, sourcePage: null, firstSeen: this.now, lastSeen: this.now, verifiedAt: this.now, attempts: 0, error: null, hidden: r.hidden, sourceAuthor: null }));
      const resp = this.page(url, rows);
      return resp.status === 200 ? this.json(200, { ...(JSON.parse(resp.text) as Record<string, unknown>), direction }) : resp;
    }
    const imp = /^\/api\/imports\/([^/]+)\/([^/]+)$/.exec(path);
    if (imp && req.method === "GET") {
      const hit = this.imports.find((i) => i.subscription_id === imp[1] && i.remote_id === imp[2]);
      if (!hit) return this.fail(404, "not-found", "not found");
      return this.json(200, { subscriptionId: hit.subscription_id, remoteId: hit.remote_id, kind: hit.kind, state: hit.state, version: hit.version, created: null, updated: null, observedAt: this.now, contentMd: hit.content_md, contentHtml: `<p>${esc(hit.content_md)}</p>\n`, contentHash: null, l0: false, pinnedVersionRetained: null, page: null, author: null, media: null, transclusions: null, stubOf: null, forkedFrom: null, generated: null });
    }
    if (m) {
      const item = this.items.get(m[1] ?? "");
      if (!item) return this.fail(404, "not-found", "not found");
      if (!m[2] && req.method === "GET") return this.json(200, this.view(item, true));
      // Every other command names the revision it acts on; a stale one is a conflict (checked first, as the real Studio does).
      const checkRevision = (): RawResponse | null => {
        if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) return this.fail(400, "invalid-input", "expectedRevision: Invalid input: expected number, received undefined");
        if (body.expectedRevision !== item.revision) return this.fail(409, "revision-conflict", "item revision conflict; reload and try again", { itemId: item.id, expectedRevision: body.expectedRevision });
        return null;
      };
      if (!m[2] && req.method === "PATCH") {
        const unknown = Object.keys(body).find((k) => !["contentMd", "kind", "stubOf", "expectedRevision", "provenance", "responses", "highlight"].includes(k));
        if (unknown) return this.fail(400, "invalid-input", `request: Unrecognized key: "${unknown}"`);
        const stale = checkRevision();
        if (stale) return stale;
        if (body.kind && body.kind !== item.kind && item.version > 0) return this.fail(409, "conflict", "kind is fixed once an item has been published");
        if (typeof body.contentMd === "string") item.content_md = body.contentMd;
        if (body.kind === "fragment" || body.kind === "thread") item.kind = body.kind;
        if ("stubOf" in body) {
          if (body.stubOf === null) delete item.stub_of;
          else if (item.kind !== "thread") return this.fail(400, "invalid-input", "only threads can be stubs");
          else if (!this.stubShape(body.stubOf)) return this.fail(400, "invalid-input", "stubOf: Invalid");
          else item.stub_of = body.stubOf;
        }
        item.revision++;
        this.epoch++;
        return this.json(200, this.view(item, false));
      }
      if (!m[2] && req.method === "DELETE") {
        if (req.body === undefined) return this.fail(400, "invalid-input", "request: Invalid input: expected object, received undefined");
        const stale = checkRevision();
        if (stale) return stale;
        if (item.version > 0) return this.fail(409, "conflict", "published items are withdrawn, not deleted");
        this.items.delete(item.id);
        this.epoch++;
        return this.json(200, { ok: true, outcome: "discarded" });
      }
      if (m[2] === "publish" && req.method === "POST") {
        const stale = checkRevision();
        if (stale) return stale;
        if (item.kind === "fragment" && item.content_md.length > 1000) return this.fail(400, "invalid-input", "fragment exceeds 1000 characters");
        item.version += 1;
        item.revision++;
        this.epoch++;
        item.status = "public";
        item.updated = this.now;
        item.versions.push({ version: item.version, content_md: item.content_md, content_html: `<p>${esc(item.content_md)}</p>`, content_hash: sha(item.content_md), published_at: this.now, note: typeof body.note === "string" ? body.note : null, media: [...(item.media ?? [])] });
        return this.json(200, { ok: true, version: item.version, revision: item.revision });
      }
      if (m[2] === "withdraw" && req.method === "POST") {
        const stale = checkRevision();
        if (stale) return stale;
        item.version += 1;
        item.revision++;
        this.epoch++;
        item.status = "withdrawn";
        return this.json(200, { ok: true, version: item.version, revision: item.revision });
      }
    }
    return this.fail(404, "not-found", "not found");
  }
}
