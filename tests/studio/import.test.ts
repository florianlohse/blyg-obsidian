// Import from the Studio (roadmap S7): notes for the owner's Studio items that have none. Nothing is sent to the Studio, an existing note is
// never touched, and an imported note reads as "up to date": the next publish has nothing to send.
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import { M } from "../../src/publish/messages";
import { importStudioItems, scanStudioImport, type ImportDeps } from "../../src/publish/studioImport";
import { baseName, firstLine, importRoute, newItems, noteName } from "../../src/studio/import";
import type { StudioListedItem } from "../../src/studio/types";
import type { NoteRef } from "../../src/platform/ports";
import { frontmatterOf, jsYaml } from "../world";
import { STUDIO_ORIGIN } from "./fake-studio";
import { makeStudioWorld, STUDIO_ROUTES, tapStudio, type StudioWorld } from "./world";

const ref = (path: string): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension: "md" });

function importDeps(w: StudioWorld, over: Partial<ImportDeps> = {}): ImportDeps {
  const studio = w.deps.studio;
  const edit = w.deps.edit;
  if (!studio || !edit) throw new Error("studio world");
  const exists = (p: string): boolean => [...w.local.keys()].some((k) => k.toLowerCase() === p.toLowerCase());
  return {
    client: studio.client,
    address: studio.address,
    routes: STUDIO_ROUTES,
    importFolder: "",
    fragmentCharCap: 1000,
    vault: w.deps.vault,
    edit,
    yaml: jsYaml,
    files: {
      exists,
      ensureFolder: () => Promise.resolve(),
      create: (p, text) => {
        if (exists(p)) return Promise.reject(new Error("exists"));
        w.local.set(p, text);
        return Promise.resolve(ref(p));
      },
    },
    ...over,
  };
}

async function scanAndImport(w: StudioWorld, deps = importDeps(w), ignored = new Set<string>()) {
  const scan = await scanStudioImport(deps, ignored);
  if (!scan.ok) throw new Error(scan.outcome.notices.join(" "));
  const out = await importStudioItems(deps, scan.scan.candidates.filter((c) => c.preselected), scan.route);
  return { scan, out };
}

const bodyOf = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

function publishedThere(w: StudioWorld, content_md: string, over: Record<string, unknown> = {}) {
  return w.studio.seed({
    content_md,
    status: "public",
    version: 1,
    versions: [{ version: 1, content_md, content_html: `<p>${content_md}</p>`, content_hash: "sha256:x", published_at: w.studio.now, note: null }],
    ...over,
  });
}

describe("import from the Studio: the pure parts", () => {
  it("names a note after its first line of prose, without Markdown or characters a file name cannot hold", () => {
    expect(firstLine("![[a0000000000000000000000001]]\n> quoted\n\n## A *title*: here/there?\nmore")).toBe("A title: here/there?");
    expect(baseName("## A *title*: here/there?", "fragment", "x")).toBe("A title here there");
    expect(baseName("[[Some note|shown]] and [a link](https://x.test)", "fragment", "x")).toBe("shown and a link");
    expect(baseName("```\ncode only\n```", "thread", "7et3x8eykq9b3z0ffr0jwhmf8p")).toBe("Thread whmf8p");
    const long = "word ".repeat(30);
    expect(baseName(long, "fragment", "x").length).toBeLessThanOrEqual(60);
    expect(baseName(long, "fragment", "x").endsWith("word")).toBe(true);
  });

  it("on a clash adds the end of the id (not its start: ids begin with the time), then the whole id; ignores case", () => {
    const id = "2dnhvp468rf1j2szn3968vtdgn";
    const taken = new Set(["hello", "hello (8vtdgn)"]);
    expect(noteName("Hello", "fragment", id, (n) => taken.has(n.toLowerCase()))).toBe(`Hello (${id})`);
    expect(noteName("Hello", "fragment", id, (n) => n === "Hello")).toBe("Hello (8vtdgn)");
    expect(noteName("Hello", "fragment", id, () => true)).toBeNull();
  });

  it("chooses the Import folder from the settings, else the first Studio folder that is not Drafts-only; refuses an unknown one", () => {
    expect(importRoute(STUDIO_ROUTES, "")).toMatchObject({ ok: true, route: { vaultPrefix: "studio/" } });
    expect(importRoute(STUDIO_ROUTES, "drafts/")).toMatchObject({ ok: true, route: { vaultPrefix: "drafts/" } });
    expect(importRoute(STUDIO_ROUTES, "gone/")).toMatchObject({ ok: false });
    expect(importRoute([STUDIO_ROUTES[1] as (typeof STUDIO_ROUTES)[number]], "")).toMatchObject({ ok: true, route: { vaultPrefix: "drafts/" } });
    expect(importRoute([], "")).toMatchObject({ ok: false });
  });

  it("offers items without a note, fragments before threads, oldest first; skips withdrawn and ignored ones; unticks items with images", () => {
    const item = (id: string, over: Partial<StudioListedItem> = {}): StudioListedItem => ({ id, revision: 1, kind: "fragment", status: "public", version: 1, contentMd: id, dirty: false, published: null, created: "2026-10-01", stubOf: null, ...over });
    const scan = newItems(
      [
        item("t1", { kind: "thread", created: "2026-09-01" }),
        item("f2", { created: "2026-10-02" }),
        item("f1", { created: "2026-10-01" }),
        item("have"),
        item("gone", { status: "withdrawn" }),
        item("no", {}),
        item("img", { contentMd: "Look ![a cat](https://x.test/cat.png)" }),
      ],
      { hasNote: (id) => id === "have", ignored: new Set(["no"]) },
    );
    expect(scan.candidates.map((c) => c.id)).toEqual(["f1", "img", "f2", "t1"]);
    expect(scan.skipped).toEqual({ withdrawn: 1, ignored: 1, unreadable: 0 });
    expect(scan.candidates.find((c) => c.id === "img")).toMatchObject({ preselected: false });
    expect(scan.candidates.find((c) => c.id === "img")?.caution).toMatch(/images/);
  });
});

describe("import from the Studio", () => {
  it("makes a note for a published item written in the Studio; nothing is sent; the next publish has nothing to send", async () => {
    const w = makeStudioWorld();
    const item = publishedThere(w, "Written on the web.\n\nSecond paragraph.");
    const { out } = await scanAndImport(w);
    expect(out.status).toBe("published");
    expect(out.notices[0]).toBe(M.studioImportDone(1, "studio/", 0));
    expect(w.studio.writes()).toHaveLength(0);
    const text = w.local.get("studio/Written on the web.md") ?? "";
    expect(bodyOf(text)).toBe("\nWritten on the web.\n\nSecond paragraph.\n");
    expect(frontmatterOf(text)).toEqual({
      blyg_id: item.id,
      blyg_origin: STUDIO_ORIGIN,
      blyg_version: 1,
      blyg_url: `${STUDIO_ORIGIN}f/${item.id}/`,
      blyg_sent: await contentHash("Written on the web.\n\nSecond paragraph."),
    });
    expect(await tapStudio(w, "studio/Written on the web.md")).toMatchObject({ status: "noop", notices: [M.noChanges] });
    expect(w.studio.writes()).toHaveLength(0);
  });

  it("imports a draft into the Import folder (D5) as an unpublished draft; publishing it later makes version 1 of the same item", async () => {
    const w = makeStudioWorld();
    const item = w.studio.seed({ content_md: "Draft from the web." });
    await scanAndImport(w);
    const path = "studio/Draft from the web.md";
    expect(frontmatterOf(w.local.get(path) ?? "")).toMatchObject({ blyg_id: item.id, blyg_version: 0 });
    expect(frontmatterOf(w.local.get(path) ?? "").blyg_url).toBeUndefined();
    const out = await tapStudio(w, path);
    expect(out).toMatchObject({ status: "published", id: item.id, version: 1 });
    expect(w.studio.items.size).toBe(1);
  });

  it("never touches an item that has a note, and lists nothing when every item has one", async () => {
    const w = makeStudioWorld({ vault: { "studio/Mine.md": "From the vault.\n" } });
    await tapStudio(w, "studio/Mine.md");
    const before = w.local.get("studio/Mine.md");
    const scan = await scanStudioImport(importDeps(w), new Set());
    expect(scan.ok && scan.scan.candidates).toEqual([]);
    expect(w.local.get("studio/Mine.md")).toBe(before);
  });

  it("a thread's embeds become the names of the fragment notes made in the same run, even before Obsidian has read their properties", async () => {
    const w = makeStudioWorld();
    const frag = publishedThere(w, "A fragment.");
    const thread = publishedThere(w, `My thread\n\n![[${frag.id}]]\n\nAfter it.`, { kind: "thread" });
    // Obsidian's metadata cache learns a new note's properties a moment later: until then, lookups do not see the notes the run made.
    const fresh = new Set<string>();
    const base = importDeps(w);
    const lagging: ImportDeps = {
      ...base,
      vault: { ...base.vault, blygId: (n) => (fresh.has(n.path) ? undefined : base.vault.blygId(n)), frontmatterValue: (n, k) => (fresh.has(n.path) ? undefined : base.vault.frontmatterValue(n, k)) },
      edit: { ...base.edit, notesWithBlygId: (id) => base.edit.notesWithBlygId(id).filter((n) => !fresh.has(n.path)) },
      files: { ...base.files, create: async (p, t) => (fresh.add(p), base.files.create(p, t)) },
    };
    const { out } = await scanAndImport(w, lagging);
    expect(out.notices[0]).toBe(M.studioImportDone(2, "studio/", 1));
    const threadText = w.local.get("studio/My thread.md") ?? "";
    expect(bodyOf(threadText)).toBe("\nMy thread\n\n![[A fragment]]\n\nAfter it.\n");
    expect(frontmatterOf(threadText)).toMatchObject({ blyg_id: thread.id, blyg_kind: "thread", blyg_url: `${STUDIO_ORIGIN}t/${thread.id}/` });
    // and the thread goes out again exactly as it came in
    expect(await tapStudio(w, "studio/My thread.md")).toMatchObject({ status: "noop" });
  });

  it("skips withdrawn items and ignored ones, and gives a clashing name the end of the id", async () => {
    const w = makeStudioWorld({ vault: { "studio/Same.md": "Not a Studio note.\n" } });
    w.studio.seed({ content_md: "Gone.", status: "withdrawn", version: 2 });
    const ignored = w.studio.seed({ content_md: "Do not want." });
    const clash = w.studio.seed({ content_md: "Same" });
    const { scan, out } = await scanAndImport(w, importDeps(w), new Set([ignored.id]));
    expect(scan.ok && scan.scan.skipped).toEqual({ withdrawn: 1, ignored: 1, unreadable: 0 });
    expect(out.created.map((n) => n.path)).toEqual([`studio/Same (${clash.id.slice(-6)}).md`]);
    expect(w.local.get("studio/Same.md")).toBe("Not a Studio note.\n");
  });

  it("uses the template's own properties (not its text, not its blyg_ keys) and the Import folder from the settings", async () => {
    const w = makeStudioWorld();
    w.studio.seed({ content_md: "With template." });
    const deps = importDeps(w, { importFolder: "drafts/", templateProps: () => Promise.resolve({ tags: ["blyg"], created: "2026-11-01", blyg_kind: "thread" }) });
    await scanAndImport(w, deps);
    const fm = frontmatterOf(w.local.get("drafts/With template.md") ?? "");
    expect(fm).toMatchObject({ tags: ["blyg"], created: "2026-11-01", blyg_version: 0 });
    expect(fm.blyg_kind).toBeUndefined();
  });

  it("re-checks before writing: an item another device imported meanwhile is left out", async () => {
    const w = makeStudioWorld();
    const item = w.studio.seed({ content_md: "Both devices." });
    const deps = importDeps(w);
    const scan = await scanStudioImport(deps, new Set());
    if (!scan.ok) throw new Error("scan");
    w.local.set("studio/Elsewhere.md", `---\nblyg_id: ${item.id}\nblyg_origin: ${STUDIO_ORIGIN}\n---\nBoth devices.\n`);
    const out = await importStudioItems(deps, scan.scan.candidates, scan.route);
    expect(out).toMatchObject({ status: "noop", notices: [M.studioImportNothing(1)] });
  });

  it("pages through a long list", async () => {
    const w = makeStudioWorld();
    for (let i = 0; i < 230; i++) w.studio.seed({ content_md: `Item ${i}` });
    const scan = await scanStudioImport(importDeps(w), new Set());
    expect(scan.ok && scan.scan.candidates.length).toBe(230);
    expect(scan.ok && scan.complete).toBe(true);
    expect(w.studio.seen.filter((s) => s.path.startsWith("/api/items?")).length).toBe(3);
  });

  it("says why when the list cannot be read, and writes nothing", async () => {
    const w = makeStudioWorld();
    w.studio.forced.set("GET /api/items", { status: 401, text: JSON.stringify({ error: "bad token" }) });
    const scan = await scanStudioImport(importDeps(w), new Set());
    expect(scan.ok).toBe(false);
    expect(w.local.size).toBe(0);
  });

  it("stops at a failed write and keeps the notes made before it", async () => {
    const w = makeStudioWorld();
    publishedThere(w, "One.");
    publishedThere(w, "Two.");
    const base = importDeps(w);
    let n = 0;
    const deps: ImportDeps = { ...base, files: { ...base.files, create: (p, t) => (++n === 2 ? Promise.reject(new Error("disk full")) : base.files.create(p, t)) } };
    const { out } = await scanAndImport(w, deps);
    expect(out).toMatchObject({ status: "failed", notices: [M.studioImportFailed(1, "studio/")] });
    expect(out.created).toHaveLength(1);
  });
});

describe("import from the Studio: the app around it", () => {
  it("needs only the Studio settings and token: no GitHub settings, no GitHub token", async () => {
    const { buildImportDeps } = await import("../../src/app/run");
    const { defaultSettings } = await import("../../src/settings/schema");
    const { fakeKeychain, idleTimers } = await import("../helpers");
    const { STUDIO_HOST, STUDIO_TOKEN } = await import("./fake-studio");
    const w = makeStudioWorld();
    w.studio.seed({ content_md: "Only a Studio." });
    const settings = defaultSettings(); // github.owner/repo empty, no GitHub token
    settings.studio = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "studio-token", importFolder: "" };
    settings.routes = [...STUDIO_ROUTES];
    const files = importDeps(w).files;
    const built = buildImportDeps(
      {
        settings,
        activeNote: () => null,
        flush: () => Promise.resolve(),
        keychain: fakeKeychain({ "studio-token": STUDIO_TOKEN }),
        http: w.http,
        vault: w.deps.vault,
        ...(w.deps.edit ? { edit: w.deps.edit } : {}),
        yaml: w.deps.yaml,
        clock: w.deps.clock,
        random: w.deps.random,
        confirm: w.deps.confirm,
        studio: { transport: w.studio.transport, timers: idleTimers, pending: { get: () => Promise.resolve(null), set: () => Promise.resolve(), clear: () => Promise.resolve() } },
      },
      { files },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { out } = await scanAndImport(w, built.deps);
    expect(out.created.map((n) => n.path)).toEqual(["studio/Only a Studio.md"]);
  });

  it("keeps the 'don't offer again' list in data.json, drops junk, and takes an item off when it is ticked later", async () => {
    const { readIgnored, updateIgnored, IGNORE_KEY } = await import("../../src/app/importIgnore");
    const a = "a0000000000000000000000001";
    const b = "a0000000000000000000000002";
    const data: Record<string, unknown> = { [IGNORE_KEY]: [a, "not an id", 7], github: {} };
    expect([...readIgnored(data)]).toEqual([a]);
    updateIgnored(data, { add: [b, b], remove: [] });
    expect(data[IGNORE_KEY]).toEqual([a, b]);
    updateIgnored(data, { add: [], remove: [a] });
    expect(data[IGNORE_KEY]).toEqual([b]);
    expect(data.github).toEqual({});
    expect([...readIgnored(undefined)]).toEqual([]);
  });
});

describe("the Import folder choices", () => {
  it("list every Studio folder as the routes are now, Drafts-only ones included and marked", async () => {
    const { importFolderChoices } = await import("../../src/studio/import");
    expect(importFolderChoices(STUDIO_ROUTES, "")).toEqual([
      { value: "studio/", label: "studio/" },
      { value: "drafts/", label: "drafts/ (Drafts only)" },
    ]);
  });

  it("keep a chosen folder that is no longer a Studio folder, so the setting shows what it holds", async () => {
    const { importFolderChoices } = await import("../../src/studio/import");
    expect(importFolderChoices(STUDIO_ROUTES, "gone/").at(-1)).toEqual({ value: "gone/", label: "gone/ (not a Studio folder any more)" });
  });
});
