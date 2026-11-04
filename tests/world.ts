// A fake world for service and parity tests: an in-memory vault, a fake GitHub contents API (sha-checked writes),
// and a deterministic clock and random source. GitHub is reached through the plugin's real http adapter and contents
// client, so those are exercised too. Mirrors the fakes in reference/legacy-macro/test-obsidian-macro.mjs.
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { createContentsClient } from "../src/github/contents";
import { createGithubHttp, type GithubHttp, type RawRequest, type RawResponse } from "../src/platform/http";
import type { NoteRef, SiteReader, VaultPort, Yaml } from "../src/platform/ports";
import { publishNote, withdrawNote } from "../src/publish/router";
import type { Confirmation, Outcome, PublishDeps, PublishSettings, WritePreview } from "../src/publish/types";
import { idleTimers, TOKEN } from "./helpers";

export const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
export const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
export const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

export const jsYaml: Yaml = {
  parse: (s) => yaml.load(s),
  stringify: (o) => yaml.dump(o, { lineWidth: -1 }),
};

/** The route table of the legacy macro, as plugin settings (test data; a user's real values live in their settings). */
export const MACRO_ROUTES: PublishSettings["routes"] = [
  { vaultPrefix: "website/blyg/", mode: "blyg", label: "Blyg note" },
  { vaultPrefix: "website/essays/", mode: "plain", dest: "src/content/essays/", label: "essay", requireTitle: true },
  { vaultPrefix: "website/pages/", mode: "plain", dest: "src/content/pages/", label: "page", requireTitle: false },
];

export const extractBlock = (t: string): string | null => /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t)?.[1] ?? null;

export interface Commit {
  message: string;
  path: string;
  branch: string;
  providedSha: string | undefined;
}

export interface World {
  local: Map<string, string>;
  repo: Map<string, { text: string; sha: string }>;
  commits: Commit[];
  /** "GET path" / "PUT path" per request that reached the contents API. */
  calls: string[];
  /** Refs/branches the API was asked about. */
  refs: string[];
  /** Every request the app made, headers included, before any cache. */
  requests: RawRequest[];
  /** Hook to simulate a race: runs right before a PUT is applied. */
  beforePut: ((path: string) => void) | null;
  now: string;
  settings: PublishSettings;
  /** Force a response for the next requests matching `method path` (for error paths). */
  fail: Map<string, Partial<RawResponse> | Error>;
  deps: PublishDeps;
  /** The GitHub client over the fake API, for tests that build the whole app environment. */
  http: GithubHttp;
  /** Frontmatter-update failures to simulate. */
  failStamp: boolean;
  /**
   * Simulate an HTTP cache under the app (iOS caches GitHub's contents reads for a minute): a GET whose URL was seen
   * before returns the earlier answer, whatever happened on GitHub since. Keyed by the exact URL, headers ignored.
   */
  httpCache: boolean;
  /** Every preview the services asked the user to confirm, in order. */
  previews: WritePreview[];
  /** What the simulated user answers to a preview. */
  answer: Confirmation;
  /** When set, decides the answer per window (a Studio publish can show two: the conflict window, then the preview). */
  answerFor: ((preview: WritePreview) => Confirmation) | null;
  /** The site's deployed item documents by URL (without query): what `GET {origin}items/{id}.json` answers. Missing = 404. */
  site: Map<string, { status: number; json: unknown }>;
  /** Every URL the plugin asked the site for, query removed. */
  siteRequests: string[];
}

export function makeWorld(init: { vault?: Record<string, string>; repo?: Record<string, string>; settings?: Partial<PublishSettings> } = {}): World {
  const world = {
    local: new Map(Object.entries(init.vault ?? {})),
    repo: new Map(Object.entries(init.repo ?? {}).map(([p, t]) => [p, { text: t, sha: sha1(t) }])),
    commits: [] as Commit[],
    calls: [] as string[],
    refs: [] as string[],
    requests: [] as RawRequest[],
    beforePut: null as ((path: string) => void) | null,
    now: "2026-10-01T06:00:00.000Z",
    settings: {
      channel: "production",
      outsideLinks: "block",
      branch: "main",
      itemsDir: "src/content/notes",
      origin: "https://example.com/blyg/",
      fragmentCharCap: 1000,
      threadSoftCap: 50000,
      attachmentsDir: "public/attachments",
      routes: MACRO_ROUTES,
      ignoreTrailingWhitespace: false,
      ...init.settings,
    },
    fail: new Map<string, Partial<RawResponse> | Error>(),
    failStamp: false,
    previews: [] as WritePreview[],
    httpCache: false,
    answer: true,
    answerFor: null,
    site: new Map<string, { status: number; json: unknown }>(),
    siteRequests: [] as string[],
  } as World;

  const json = (status: number, obj: unknown): RawResponse => ({ status, headers: {}, text: JSON.stringify(obj) });

  const cache = new Map<string, RawResponse>();
  const cachingTransport = async (req: RawRequest): Promise<RawResponse> => {
    world.requests.push(req);
    if (!world.httpCache || req.method !== "GET") return transport(req);
    const hit = cache.get(req.url);
    if (hit) return hit;
    const fresh = await transport(req);
    cache.set(req.url, fresh);
    return fresh;
  };
  const transport = (req: RawRequest): Promise<RawResponse> => {
    const u = new URL(req.url);
    const prefix = "/repos/o/r/contents/";
    if (!u.pathname.startsWith(prefix)) throw new Error(`unexpected API URL ${req.url}`);
    const path = decodeURIComponent(u.pathname.slice(prefix.length));
    world.calls.push(`${req.method} ${path}`);

    const forced = world.fail.get(`${req.method} ${path}`);
    if (forced instanceof Error) return Promise.reject(forced);
    if (forced) return Promise.resolve({ status: 200, headers: {}, text: "", ...forced });

    if (req.method === "GET") {
      world.refs.push(u.searchParams.get("ref") ?? "");
      const file = world.repo.get(path);
      if (file) return Promise.resolve(json(200, { sha: file.sha, content: b64(file.text), encoding: "base64", name: path.split("/").pop(), path, type: "file" }));
      const dirPrefix = `${path}/`;
      const entries = [...world.repo.keys()].filter((p) => p.startsWith(dirPrefix) && !p.slice(dirPrefix.length).includes("/"));
      if (entries.length > 0) return Promise.resolve(json(200, entries.map((p) => ({ name: p.split("/").pop(), path: p, type: "file" }))));
      return Promise.resolve(json(404, { message: "Not Found" }));
    }

    if (req.method === "PUT") {
      const body = JSON.parse(req.body ?? "{}") as { message: string; content: string; branch: string; sha?: string };
      world.beforePut?.(path);
      const existing = world.repo.get(path);
      if (existing && !body.sha) return Promise.resolve(json(422, { message: "sha wasn't supplied" }));
      if (existing && body.sha !== existing.sha) return Promise.resolve(json(409, { message: "does not match" }));
      if (!existing && body.sha) return Promise.resolve(json(404, { message: "Not Found" }));
      const text = fromB64(body.content);
      world.repo.set(path, { text, sha: sha1(text + world.commits.length) });
      world.commits.push({ message: body.message, path, branch: body.branch, providedSha: body.sha });
      return Promise.resolve(json(existing ? 200 : 201, { content: { sha: world.repo.get(path)?.sha }, commit: { sha: sha1(`commit ${world.commits.length}`) } }));
    }
    throw new Error(`unexpected method ${req.method}`);
  };

  const vault: VaultPort = {
    read: (note) => Promise.resolve(world.local.get(note.path) ?? ""),
    blygId: (note) => {
      const block = extractBlock(world.local.get(note.path) ?? "");
      return block ? (yaml.load(block) as { blyg_id?: unknown } | undefined)?.blyg_id : undefined;
    },
    frontmatterValue: (note, key) => {
      const block = extractBlock(world.local.get(note.path) ?? "");
      return block ? (yaml.load(block) as Record<string, unknown> | undefined)?.[key] : undefined;
    },
    // Obsidian resolves a link name to a note by its file name (with or without ".md"), anywhere in the vault.
    resolveLink: (target) => {
      const wanted = target.toLowerCase();
      for (const path of world.local.keys()) {
        const name = path.split("/").pop() ?? path;
        const base = name.replace(/\.[^.]+$/, "").toLowerCase();
        // a link may also carry the folder path, as Obsidian writes it when a name is ambiguous
        const withPath = path.replace(/\.[^.]+$/, "").toLowerCase();
        if (name.toLowerCase() === wanted || base === wanted || withPath === wanted || path.toLowerCase() === wanted) return { path, extension: (name.split(".").pop() ?? "").toLowerCase() };
      }
      return null;
    },
    updateFrontmatter: (note, fn) => {
      if (world.failStamp) return Promise.reject(new Error("disk full"));
      const text = world.local.get(note.path) ?? "";
      const block = extractBlock(text);
      const fm = (block ? yaml.load(block) : {}) as Record<string, unknown>;
      const body = block === null ? text : text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      fn(fm);
      world.local.set(note.path, `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n${body}`);
      return Promise.resolve();
    },
  };

  const siteReader: SiteReader = {
    getJson: (url) => {
      const u = new URL(url);
      u.search = "";
      world.siteRequests.push(u.href);
      const hit = world.site.get(u.href);
      return Promise.resolve(hit ?? { status: 404, json: undefined });
    },
  };

  let randomCounter = 0;
  const http = createGithubHttp({ transport: cachingTransport, timers: idleTimers });
  world.http = http;
  world.deps = {
    settings: world.settings,
    confirm: (preview) => {
      world.previews.push(preview);
      return Promise.resolve(world.answerFor ? world.answerFor(preview) : world.answer);
    },
    github: createContentsClient({ http, token: TOKEN, owner: "o", repo: "r" }),
    site: siteReader,
    vault,
    yaml: jsYaml,
    clock: { now: () => new Date(world.now) },
    random: {
      bytes: (n) => {
        randomCounter += 1;
        return Uint8Array.from({ length: n }, (_, i) => (randomCounter * 37 + i * 11) & 0xff);
      },
    },
  };
  return world;
}

const noteRef = (path: string, extension = "md"): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension });

/** Tap "publish" on a vault path. */
export async function tap(world: World, path: string, opts: { extension?: string } = {}): Promise<Outcome> {
  return publishNote(world.deps, noteRef(path, opts.extension));
}

/** Tap "withdraw" on a vault path. */
export async function tapWithdraw(world: World, path: string): Promise<Outcome> {
  return withdrawNote(world.deps, noteRef(path));
}

export const repoText = (world: World, path: string): string | undefined => world.repo.get(path)?.text;
export const has = (notices: string[], re: RegExp): boolean => notices.some((n) => re.test(n));
export const frontmatterOf = (text: string): Record<string, unknown> =>
  yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "") as Record<string, unknown>;

/** Serve an item document for `id` on the site, the way the site's own build would (version and kind from the committed file). */
export function deploy(world: World, id: string, html: string, over: Record<string, unknown> = {}): void {
  const committed = world.repo.get(`${world.settings.itemsDir}/${id}.md`);
  if (!committed) throw new Error(`deploy(${id}): nothing committed`);
  const fm = frontmatterOf(committed.text);
  const kind = fm.blyg_withdrawn === true ? "withdrawn" : (fm.blyg_kind ?? "fragment");
  const origin = world.settings.origin;
  const page = `${fm.blyg_kind === "thread" ? "t" : "f"}/${id}/`;
  world.site.set(new URL(`items/${id}.json`, origin).href, {
    status: 200,
    json: { blyg: "0.3", id, kind, origin, page, version: fm.blyg_version, content_html: html, ...over },
  });
}
