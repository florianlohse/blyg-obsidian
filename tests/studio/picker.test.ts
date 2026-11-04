// The Studio quote picker: what it lists (the vault's notes of this Studio, then what the Studio's search finds), how an item is written
// into a note, and how the text of an item is read to choose a passage from (S2.2, decisions 9 and 10).
import { describe, expect, it } from "vitest";
import { runStudioQuotable, runStudioSearch, type AppEnv } from "../../src/app/run";
import { quoteBlockOf } from "../../src/app/threadCommands";
import { M } from "../../src/publish/messages";
import { readQuotable } from "../../src/studio/passage";
import { filterVault, hitPick, mergePicks, vaultPicks, writtenRef, type StudioPick, type StudioVaultNote } from "../../src/studio/picker";
import type { StudioHit } from "../../src/studio/types";
import { defaultSettings } from "../../src/settings/schema";
import { fakeKeychain, idleTimers } from "../helpers";
import { makeWorld } from "../world";
import { STUDIO_HOST, STUDIO_ORIGIN, STUDIO_TOKEN, idOf } from "./fake-studio";
import { makeStudioWorld, tapStudio } from "./world";

const REMOTE = "095s4h48j67mnbf6hq8vatc2d4";
const note = (name: string, frontmatter: StudioVaultNote["frontmatter"], text = "Some words.\n"): StudioVaultNote => ({ path: `studio/${name}.md`, name, frontmatter, text });
const hit = (over: Partial<StudioHit> = {}): StudioHit => ({ id: REMOTE, kind: "fragment", version: 1, label: "“Remote words…”", excerpt: "Remote words here.", source: "imported", subscriptionId: "sub1", sourceTitle: "Blog B", ...over });

describe("the vault's rows", () => {
  const mine = { blyg_id: idOf(1), blyg_origin: STUDIO_ORIGIN };
  const notes = [
    note("Mine", mine, "My first words.\n"),
    note("Withdrawn", { ...mine, blyg_id: idOf(2), blyg_withdrawn: true }),
    note("Old blyg", { blyg_id: idOf(3) }),
    note("Another blyg", { blyg_id: idOf(4), blyg_origin: "https://elsewhere.test/" }),
    note("Open one", { ...mine, blyg_id: idOf(5) }),
    note("A thread", { ...mine, blyg_id: idOf(6), blyg_kind: "thread" }),
    note("Draft", {}),
  ];

  it("lists only notes with this Studio's record, not withdrawn, not the open note", () => {
    const rows = vaultPicks(notes, { activePath: "studio/Open one.md", origin: STUDIO_ORIGIN });
    expect(rows.map((r) => r.name).sort()).toEqual(["A thread", "Mine"]);
    expect(rows.find((r) => r.name === "A thread")?.kind).toBe("thread");
    expect(rows.find((r) => r.name === "Mine")).toMatchObject({ source: "vault", id: idOf(1), title: "My first words.", detail: "Your note “Mine”", subscriptionId: null });
  });

  it("compares origins as URLs", () => {
    expect(vaultPicks([note("Mine", { ...mine, blyg_origin: "https://STUDIO.test" })], { activePath: undefined, origin: STUDIO_ORIGIN })).toHaveLength(1);
  });

  it("filters by every typed word, in the title or the name", () => {
    const rows = vaultPicks(notes, { activePath: undefined, origin: STUDIO_ORIGIN });
    expect(filterVault(rows, "")).toEqual(rows);
    expect(filterVault(rows, "first MINE").map((r) => r.name)).toEqual(["Mine"]);
    expect(filterVault(rows, "nothing like it")).toEqual([]);
  });
});

describe("the Studio's rows", () => {
  it("an item of a blyg you read carries the blyg's title in its label and detail", () => {
    expect(hitPick(hit())).toMatchObject({ source: "studio", id: REMOTE, subscriptionId: "sub1", label: "Blog B: “Remote words…”", detail: "Blog B · fragment", title: "Remote words here." });
  });

  it("an own item has no subscription and no prefix", () => {
    expect(hitPick(hit({ source: "mine", subscriptionId: null, sourceTitle: null, kind: "thread" }))).toMatchObject({ subscriptionId: null, label: "“Remote words…”", detail: "In your Studio · thread" });
  });

  it("a label can always sit between | and ]]", () => {
    const pick = hitPick(hit({ label: "a | b [c]\nd" }));
    expect(pick.label).toBe("Blog B: a b c d");
    expect(writtenRef(pick, "")).toBe(`${REMOTE} | Blog B: a b c d`);
  });

  it("vault notes first, and the same item is not listed twice", () => {
    const vault: StudioPick[] = vaultPicks([note("Mine", { blyg_id: idOf(1), blyg_origin: STUDIO_ORIGIN })], { activePath: undefined, origin: STUDIO_ORIGIN });
    const found = [hitPick(hit({ id: idOf(1), source: "mine", subscriptionId: null, sourceTitle: null })), hitPick(hit())];
    expect(mergePicks(vault, found).map((p) => [p.source, p.id])).toEqual([["vault", idOf(1)], ["studio", REMOTE]]);
  });
});

describe("what is written", () => {
  const vaultPick = vaultPicks([note("Mine", { blyg_id: idOf(1), blyg_origin: STUDIO_ORIGIN })], { activePath: undefined, origin: STUDIO_ORIGIN })[0] as StudioPick;

  it("a note of the vault by the name Obsidian links it by; any other item as id | label", () => {
    expect(writtenRef(vaultPick, "Mine")).toBe("Mine");
    expect(writtenRef(hitPick(hit()), "")).toBe(`${REMOTE} | Blog B: “Remote words…”`);
    expect(writtenRef({ ...hitPick(hit()), label: "" }, "")).toBe(REMOTE);
  });

  it("a whole quote is one line; a passage adds its quote lines", () => {
    const ref = writtenRef(hitPick(hit()), "");
    expect(quoteBlockOf(ref, { kind: "whole" })).toEqual({ ok: true, text: `![[${ref}]]` });
    expect(quoteBlockOf(ref, { kind: "passage", selected: "Remote words" })).toEqual({ ok: true, text: `![[${ref}]]\n> Remote words` });
    expect(quoteBlockOf(ref, { kind: "passage", selected: "  " })).toEqual({ ok: false, reason: "empty" });
  });
});

describe("reading an item to choose a passage from", () => {
  async function setup() {
    const w = makeStudioWorld({ vault: { "studio/Frag.md": "Own words. Second sentence.\n" } });
    const id = (await tapStudio(w, "studio/Frag.md")).id ?? "";
    w.studio.importItem({ remote_id: REMOTE, content_md: "Imported words." });
    return { w, id, client: w.deps.studio?.client };
  }
  const pickOf = (id: string, subscriptionId: string | null): StudioPick => ({ source: "studio", id, kind: "fragment", title: "", detail: "", subscriptionId, label: "" });

  it("an own item: the published version, as readers see it", async () => {
    const { client, id } = await setup();
    if (!client) throw new Error("client");
    expect(await readQuotable(client, pickOf(id, null))).toEqual({ ok: true, id, version: 1, kind: "fragment", html: "<p>Own words. Second sentence.</p>", text: "Own words. Second sentence." });
  });

  it("an imported item: what the Studio holds of it", async () => {
    const { client } = await setup();
    if (!client) throw new Error("client");
    expect(await readQuotable(client, pickOf(REMOTE, "sub1"))).toMatchObject({ ok: true, id: REMOTE, version: 1, kind: "fragment", text: "Imported words." });
  });

  it("says why an item cannot be quoted", async () => {
    const { w, client, id } = await setup();
    if (!client) throw new Error("client");
    const draft = w.studio.seed({ content_md: "Only a draft." });
    expect(await readQuotable(client, pickOf(draft.id, null))).toMatchObject({ ok: false, outcome: { status: "refused", notices: [M.studioNotQuotableDraft(draft.id)] } });
    const item = w.studio.items.get(id);
    if (item) item.status = "withdrawn";
    expect(await readQuotable(client, pickOf(id, null))).toMatchObject({ ok: false, outcome: { notices: [M.withdrawnItem("This item", id)] } });
    const imported = w.studio.imports[0];
    if (imported) imported.state = "tombstone";
    expect(await readQuotable(client, pickOf(REMOTE, "sub1"))).toMatchObject({ ok: false, outcome: { notices: [M.studioNotQuotableTombstone(REMOTE)] } });
    expect(await readQuotable(client, pickOf(idOf(99), null))).toMatchObject({ ok: false, outcome: { status: "failed", notices: [expect.stringContaining("404")] } });
  });
});

describe("the runners the windows call", () => {
  function env(over: Partial<AppEnv> = {}) {
    const w = makeStudioWorld({ vault: {} });
    const settings = defaultSettings();
    settings.studio = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "studio-token", importFolder: "" };
    const e: AppEnv = {
      settings,
      activeNote: () => null,
      flush: () => Promise.resolve(),
      keychain: fakeKeychain({ "studio-token": STUDIO_TOKEN }),
      http: makeWorld().http,
      vault: w.deps.vault,
      yaml: w.deps.yaml,
      clock: w.deps.clock,
      random: w.deps.random,
      confirm: w.deps.confirm,
      studio: { transport: w.studio.transport, timers: idleTimers, pending: w.deps.studio?.pending ?? { get: () => Promise.resolve(null), set: () => Promise.resolve(), clear: () => Promise.resolve() } },
      ...over,
    };
    return { w, e };
  }

  it("search lists items of the Studio and of the blygs it reads, and needs no GitHub settings", async () => {
    const { w, e } = env();
    const own = w.studio.seed({ content_md: "Mine here.", status: "public", version: 1 });
    w.studio.importItem({ remote_id: REMOTE, content_md: "Theirs here." });
    const found = await runStudioSearch(e, "here");
    expect(found.ok && found.picks.map((p) => [p.id, p.subscriptionId, p.label])).toEqual([[own.id, null, expect.any(String)], [REMOTE, "sub1", expect.stringContaining("Blog B: ")]]);
    const none = await runStudioSearch(e, "absent");
    expect(none).toEqual({ ok: true, picks: [] });
    expect(w.studio.seen.every((s) => s.authorization === `Bearer ${STUDIO_TOKEN}`)).toBe(true);
    expect(w.studio.seen.find((s) => s.path.startsWith("/api/search"))?.path).toBe("/api/search?limit=25&source=all&q=here");
  });

  it("an empty query asks for the newest, and a missing token or Studio says so", async () => {
    const { w, e } = env();
    await runStudioSearch(e, "  ");
    expect(w.studio.seen.at(-1)?.path).toBe("/api/search?limit=25&source=all");
    const noToken = await runStudioSearch({ ...e, keychain: fakeKeychain({}) }, "x");
    expect(noToken.ok).toBe(false);
    expect(!noToken.ok && noToken.outcome.notices[0]).toMatch(/keychain entry “studio-token” is empty/);
    expect((await runStudioQuotable({ ...e, keychain: fakeKeychain({}) }, { source: "studio", id: REMOTE, kind: null, title: "", detail: "", subscriptionId: null, label: "" })).ok).toBe(false);
  });

  it("a failing search is a message, not an exception", async () => {
    const { w, e } = env();
    w.studio.forced.set("GET /api/search", { status: 500, text: "boom" });
    const out = await runStudioSearch(e, "x");
    expect(out.ok).toBe(false);
    w.studio.forced.set("GET /api/search", new Error("offline"));
    const offline = await runStudioSearch(e, "x");
    expect(offline).toMatchObject({ ok: false, outcome: { notices: [M.studioSearchFailed] } });
  });
});
