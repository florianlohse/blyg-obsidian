// End to end against a REAL Blygger Studio, through the plugin's own http adapter, client and publish service. Skipped unless
//   STUDIO_E2E_URL=http://localhost:8787 STUDIO_E2E_TOKEN=<REST token with owner:read, owner:draft, owner:publish>
// are set; `scripts/local-studio.sh start` makes a throwaway Studio and prints both. Never point it at a Studio you care about: it
// publishes (and a published id is permanent).
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import { M } from "../../src/publish/messages";
import { checkStudioConnection } from "../../src/studio/connection";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient, type StudioClient } from "../../src/studio/client";
import type { StudioResult } from "../../src/studio/types";
import { createStudioHttp } from "../../src/studio/http";
import { fakeKeychain, idleTimers } from "../helpers";
import { frontmatterOf, makeWorld } from "../world";
import { runPublish, runWithdraw, type AppEnv } from "../../src/app/run";
import { defaultSettings } from "../../src/settings/schema";
import { repostNote } from "../../src/publish/router";
import { loadStudioFacts, loadStudioWarnings } from "../../src/studio/live";
import { lookupAddress, stubTargetOf } from "../../src/studio/lookup";
import { stubProperty } from "../../src/studio/stub";
import { importStudioItems, scanStudioImport, type ImportDeps } from "../../src/publish/studioImport";
import { STUDIO_ROUTES } from "../studio/world";
import { jsYaml } from "../world";
import { makeStudioWorld, tapStudio, tapStudioDeleteDraft, tapStudioPull, tapStudioWithdraw, type StudioWorld } from "../studio/world";

const URL_ = process.env.STUDIO_E2E_URL;
const TOKEN = process.env.STUDIO_E2E_TOKEN;
const run = URL_ && TOKEN ? describe : describe.skip;

/** The plugin's transport contract, over Node's fetch (the plugin itself uses Obsidian's requestUrl). */
async function transport(req: RawRequest): Promise<RawResponse> {
  // The Studio gives a token a work budget per minute (`429 API work budget exceeded`); the whole suite together can use it up. A person would
  // wait and try again, so the test does too (the plugin's own adapter retries short waits only; its tests use idle timers).
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(req.url, { method: req.method, headers: { ...req.headers, ...(req.contentType ? { "content-type": req.contentType } : {}) }, ...(req.body !== undefined ? { body: req.body } : {}) });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => (headers[key] = value));
    const text = await res.text();
    if (res.status === 429 && attempt <= 4) {
      await sleep(15_000);
      continue;
    }
    return { status: res.status, headers, text };
  }
}

function realWorld(vault: Record<string, string>, wrap: (t: typeof transport) => typeof transport = (t) => t): StudioWorld {
  const w = makeStudioWorld({ vault });
  const address = studioAddress({ baseUrl: URL_ ?? "", mount: "" });
  if (!address || !w.deps.studio) throw new Error("e2e setup");
  const client = createStudioClient({ http: createStudioHttp({ transport: wrap(transport), timers: idleTimers, address }), token: TOKEN ?? "" });
  w.deps.studio = { ...w.deps.studio, client, address };
  return w;
}

/** Edit a Studio item's working copy "in the Studio's editor": read its revision, then write with it (what every contract-5 command needs). */
async function editInStudio(client: StudioClient | undefined, id: string, input: { contentMd: string }): Promise<void> {
  const got = await client?.getItem(id);
  if (got?.kind !== "ok") throw new Error("e2e: cannot read the item to edit it");
  const done = await client?.updateItem(id, input, got.value.revision);
  if (done?.kind !== "ok") throw new Error("e2e: the edit was refused");
}

/** Publish an item as it stands (read, then publish with the revision read). */
async function publishNow(client: StudioClient, id: string): Promise<StudioResult<unknown>> {
  const got = await client.getItem(id);
  if (got.kind !== "ok") return got;
  return client.publish(id, undefined, got.value.revision);
}

run("against a real Studio", { timeout: 120_000 }, () => {
  const NOTE = "studio/E2E.md";
  const stamp = new Date().toISOString();

  it("Check connection passes: tested release, token, permissions", async () => {
    const report = await checkStudioConnection(
      { transport, timers: idleTimers, keychain: fakeKeychain({ t: TOKEN ?? "" }), clock: { now: () => new Date() } },
      { baseUrl: URL_ ?? "", mount: "", tokenSecretName: "t" },
    );
    expect(report.lines.filter((l) => l.level === "error")).toEqual([]);
    expect(report.lines.map((l) => l.text).join("\n")).toMatch(/contract 5\.\d+\.\d+: the API this plugin speaks/);
  });

  it("publishes, finds nothing to do, updates, and refuses to overwrite work done in the Studio", async () => {
    const w = realWorld({ [NOTE]: `First words, ${stamp}.\r\n` });
    const first = await tapStudio(w, NOTE);
    expect(first).toMatchObject({ status: "published", version: 1 });
    const id = first.id ?? "";
    const origin = w.deps.studio?.address.origin ?? "";
    expect(frontmatterOf(w.local.get(NOTE) ?? "")).toMatchObject({ blyg_id: id, blyg_origin: origin, blyg_version: 1, blyg_url: `${origin}f/${id}/` });

    const client = w.deps.studio?.client;
    const got = await client?.getItem(id);
    expect(got).toMatchObject({ kind: "ok", value: { status: "public", version: 1, dirty: false, contentMd: `First words, ${stamp}.` } });
    // the Studio's own hash of the published words equals the plugin's: both ends normalise the same way
    expect(got?.kind === "ok" ? got.value.published?.contentHash : null).toBe(await contentHash(`First words, ${stamp}.`));

    // nothing to send: the real Studio would have made a version 2 of the same words, so the version staying 1 proves nothing was sent
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "noop", notices: [M.noChanges] });
    expect(await client?.getItem(id)).toMatchObject({ value: { version: 1 } });

    w.local.set(NOTE, w.local.get(NOTE)?.replace("First", "Second") ?? "");
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "published", id, version: 2 });
    expect(await client?.getItem(id)).toMatchObject({ value: { version: 2, contentMd: `Second words, ${stamp}.`, published: { contentHash: await contentHash(`Second words, ${stamp}.`) } } });

    // someone edits the working copy in the Studio's own editor; the note changes too: the plugin must not overwrite that work
    await editInStudio(client, id, { contentMd: "Written in the Studio." });
    w.local.set(NOTE, w.local.get(NOTE)?.replace("Second", "Third") ?? "");
    w.answerFor = (p) => p.action !== "studio-conflict";
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "cancelled", notices: [M.studioChangedThereCancelled(id)] });
    expect(await client?.getItem(id)).toMatchObject({ value: { version: 2, contentMd: "Written in the Studio." } });
  });

  it("Studio-only: a setup with a Studio address and token and nothing about GitHub publishes and withdraws through the app's own wiring", async () => {
    const world = makeWorld({ vault: { "blyg/E2E studio-only.md": `Studio-only words, ${stamp}.\n` }, settings: { routes: [{ vaultPrefix: "blyg/", mode: "studio", label: "Blyg item" }] } });
    const settings = defaultSettings();
    settings.studio = { baseUrl: URL_ ?? "", mount: "", tokenSecretName: "studio-token", importFolder: "" };
    const env: AppEnv = {
      settings,
      activeNote: () => ({ path: "blyg/E2E studio-only.md", name: "E2E studio-only.md", extension: "md" }),
      flush: () => Promise.resolve(),
      keychain: fakeKeychain({ "studio-token": TOKEN ?? "" }),
      http: { request: () => Promise.reject(new Error("GitHub was called")) } as unknown as AppEnv["http"],
      vault: world.deps.vault,
      yaml: world.deps.yaml,
      clock: world.deps.clock,
      random: world.deps.random,
      confirm: world.deps.confirm,
      studio: { transport, timers: idleTimers, pending: { get: () => Promise.resolve(null), set: () => Promise.resolve(), clear: () => Promise.resolve() } },
    };
    const published = await runPublish(env);
    expect(published).toMatchObject({ status: "published", version: 1 });
    expect(frontmatterOf(world.local.get("blyg/E2E studio-only.md") ?? "")).toMatchObject({ blyg_id: published.id, blyg_version: 1 });
    expect(await runWithdraw(env)).toMatchObject({ status: "published" });
    expect(world.calls).toEqual([]);
  });

  it("E9: a real Studio reads a line directly under a partial quote as part of the quote (so the plugin refuses it), and a blank line ends it", async () => {
    const w = realWorld({ "studio/E2E lazy source.md": `A sentence to quote, ${stamp}. And a second one.\n` });
    const fid = (await tapStudio(w, "studio/E2E lazy source.md")).id ?? "";
    const client = w.deps.studio?.client;
    const lazy = await client?.preview({ kind: "thread", contentMd: `![[${fid}]]\n> A sentence to quote\nmy own words, no blank line\n` });
    const blank = await client?.preview({ kind: "thread", contentMd: `![[${fid}]]\n> A sentence to quote\n\nmy own words, after a blank line\n` });
    // The Studio's reading, measured on 0.51.0: the lazy line becomes part of the quoted passage, so the passage no longer matches the source
    // and the Studio's own check says "quoted passage not found" (it is only silent when the extended passage happens to exist in the source).
    // After a blank line the quote is exactly what was written.
    expect(lazy?.kind === "ok" ? lazy.value.problems.map((p) => p.reason) : ["preview failed"]).toEqual([expect.stringMatching(/quoted passage not found/)]);
    expect(blank?.kind === "ok" ? blank.value.quotes.map((q) => q.passage) : ["preview failed"]).toEqual(["A sentence to quote"]);
    // and the plugin refuses the first before sending anything
    w.local.set("studio/E2E lazy thread.md", `---\nblyg_kind: thread\n---\n![[${fid}]]\n> A sentence to quote\nmy own words, no blank line\n`);
    const out = await tapStudio(w, "studio/E2E lazy thread.md");
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/sits directly under a quote/);
  });

  it("text typed in the Studio's editor DURING a send (between the plugin's read and its write) is not overwritten: the real 409 revision-conflict stops it", async () => {
    const PATH = "studio/E2E during.md";
    let edited = false;
    // Just before the plugin's PATCH goes out, someone else's edit lands (a real PATCH with the revision the plugin has not seen yet).
    const during = (inner: typeof transport): typeof transport => async (req) => {
      if (req.method === "PATCH" && !edited) {
        edited = true;
        const id = new URL(req.url).pathname.split("/").pop() ?? "";
        const got = JSON.parse((await inner({ url: req.url, method: "GET", headers: req.headers })).text) as { revision: number };
        const other = await inner({ ...req, body: JSON.stringify({ contentMd: "Typed in the Studio at the same moment.", expectedRevision: got.revision }) });
        if (other.status !== 200) throw new Error(`e2e: the concurrent edit of ${id} was refused (${other.status})`);
      }
      return inner(req);
    };
    const w = realWorld({ [PATH]: `Before ${stamp}.\n` }, during);
    const first = await tapStudio(w, PATH);
    const id = first.id ?? "";
    w.local.set(PATH, w.local.get(PATH)?.replace("Before", "After") ?? "");
    const out = await tapStudio(w, PATH);
    expect(out).toMatchObject({ status: "failed", notices: [M.studioChangedWhilePublishing(id)] });
    // nothing was overwritten and nothing was published
    expect(await w.deps.studio?.client.getItem(id)).toMatchObject({ kind: "ok", value: { version: 1, contentMd: "Typed in the Studio at the same moment." } });
    expect(frontmatterOf(w.local.get(PATH) ?? "")).toMatchObject({ blyg_version: 1 });
  });

  it("a drafts-only folder: the draft is invisible to readers, can be edited and deleted, and a normal folder publishes the same item as version 1", async () => {
    const DRAFT = "drafts/E2E-draft.md";
    const MOVED = "studio/E2E-draft-moved.md";
    const secret = `Draft words nobody may see, ${stamp}.`;
    const w = realWorld({ [DRAFT]: `${secret}\n` });
    const origin = w.deps.studio?.address.origin ?? "";
    const publicText = async (path: string): Promise<{ status: number; body: string }> => {
      const res = await fetch(new URL(path, origin).href, { headers: { Accept: "*/*" } });
      return { status: res.status, body: await res.text() };
    };
    const everywhere = async (id: string): Promise<{ status: number; seen: boolean }[]> =>
      Promise.all([`items/${id}.json`, `f/${id}/`, "", "blyg.json", "feed.xml", "items/index.json"].map(async (p) => {
        const r = await publicText(p);
        return { status: r.status, seen: r.body.includes("Draft words nobody may see") };
      }));

    const sent = await tapStudio(w, DRAFT);
    expect(sent.status).toBe("published");
    const id = sent.id ?? "";
    const client = w.deps.studio?.client;
    expect(await client?.getItem(id)).toMatchObject({ value: { status: "draft", version: 0, contentMd: secret } });
    expect(frontmatterOf(w.local.get(DRAFT) ?? "")).toMatchObject({ blyg_id: id, blyg_version: 0 });
    // what a reader can fetch: the item document and its page do not exist, and no public surface carries the words
    const reader = await everywhere(id);
    expect(reader[0]?.status).toBe(404);
    expect(reader[1]?.status).toBe(404);
    expect(reader.some((r) => r.seen)).toBe(false);

    // an edit is sent to the same draft; still unpublished
    w.local.set(DRAFT, (w.local.get(DRAFT) ?? "").replace("Draft words", "Edited draft words"));
    expect((await tapStudio(w, DRAFT)).status).toBe("published");
    expect(await client?.getItem(id)).toMatchObject({ value: { status: "draft", version: 0 } });

    // going live: the same text in a normal folder becomes version 1 of the same item
    w.local.set(MOVED, w.local.get(DRAFT) ?? "");
    expect(await tapStudio(w, MOVED)).toMatchObject({ status: "published", id, version: 1 });
    expect((await publicText(`items/${id}.json`)).status).toBe(200);

    // a published item cannot be deleted (the plugin asks first and refuses); a never-published draft can
    expect(await tapStudioDeleteDraft(w, MOVED)).toMatchObject({ status: "refused", notices: [M.studioDraftPublished(id)] });
    const w2 = realWorld({ "drafts/E2E-third.md": `Third draft, ${stamp}.\n` });
    const third = await tapStudio(w2, "drafts/E2E-third.md");
    expect(await tapStudioDeleteDraft(w2, "drafts/E2E-third.md")).toMatchObject({ status: "published", notices: [M.studioDraftDeleted(third.id ?? "")] });
    expect(await w2.deps.studio?.client.getItem(third.id ?? "")).toMatchObject({ kind: "not-found" });
    expect((await publicText(`items/${third.id}.json`)).status).toBe(404);
  });

  it("a wrong token comes back as the plugin's own message", async () => {
    const w = realWorld({ "studio/Bad.md": "A fine note.\n" });
    const address = w.deps.studio?.address;
    if (!address || !w.deps.studio) throw new Error("e2e setup");
    w.deps.studio = { ...w.deps.studio, client: createStudioClient({ http: createStudioHttp({ transport, timers: idleTimers, address }), token: "not-the-token" }) };
    expect(await tapStudio(w, "studio/Bad.md")).toMatchObject({ status: "failed", notices: [M.studioUnauthorized] });
  });

  it("a fragment over the cap is stopped locally, a text with a link to another note is stopped locally; neither reaches the Studio", async () => {
    const w = realWorld({ "studio/Long.md": `${"a".repeat(1200)}\n`, "studio/Link.md": "See [[Elsewhere]].\n" });
    expect((await tapStudio(w, "studio/Long.md")).status).toBe("refused");
    expect((await tapStudio(w, "studio/Link.md")).status).toBe("refused");
  });

  it("a thread quotes an own fragment whole and in part, links to it by name, and sends a change note with its second version", async () => {
    const w = realWorld({
      "studio/E2E fragment.md": `Own words ${stamp}. A second sentence stays quotable.\n\nAnd a paragraph with *emphasis* in it.\n`,
      "studio/E2E thread.md": "---\nblyg_kind: thread\n---\nA thread.\n\n![[E2E fragment]]\n\nThe part I mean:\n\n![[E2E fragment]]\n> A second sentence stays quotable.\n\nAcross paragraphs:\n\n![[E2E fragment]]\n> A second sentence stays quotable.\n>\n> And a paragraph with emphasis in it.\n\nSee also [[E2E fragment|the fragment]].\n",
    });
    const fragment = await tapStudio(w, "studio/E2E fragment.md");
    expect(fragment.status).toBe("published");
    const fid = fragment.id ?? "";

    const first = await tapStudio(w, "studio/E2E thread.md");
    expect(first).toMatchObject({ status: "published", version: 1 });
    const tid = first.id ?? "";
    const origin = w.deps.studio?.address.origin ?? "";
    expect(frontmatterOf(w.local.get("studio/E2E thread.md") ?? "")).toMatchObject({ blyg_kind: "thread", blyg_id: tid, blyg_origin: origin, blyg_url: `${origin}t/${tid}/` });
    // the Studio resolved all three quotes (whole, part, across paragraphs) and the window was told so
    const quotes = w.previews.at(-1)?.studio?.quotes ?? [];
    expect(quotes.map((q) => [q.id, q.passage, q.remote])).toEqual([
      [fid, null, false],
      [fid, "A second sentence stays quotable.", false],
      [fid, "A second sentence stays quotable.\nAnd a paragraph with emphasis in it.", false],
    ]);
    const client = w.deps.studio?.client;
    const got = await client?.getItem(tid);
    expect(got?.kind === "ok" ? got.value.contentMd : "").toContain(`![[${fid}]]`);
    expect(got?.kind === "ok" ? got.value.contentMd : "").toContain(`[[${fid} | the fragment]]`);
    // the plugin and the Studio hash the resolved text the same way
    expect(got?.kind === "ok" ? got.value.published?.contentHash : null).toBe(frontmatterOf(w.local.get("studio/E2E thread.md") ?? "").blyg_sent);

    w.local.set("studio/E2E thread.md", w.local.get("studio/E2E thread.md")?.replace("A thread.", "A thread, revised.") ?? "");
    w.answer = { note: "revised the opening" };
    expect(await tapStudio(w, "studio/E2E thread.md")).toMatchObject({ status: "published", id: tid, version: 2 });
    const second = await client?.getItem(tid);
    expect(second?.kind === "ok" ? second.value.published?.note : null).toBe("revised the opening");
  });

  it("a passage the source does not contain is named by the Studio's preview and stops the publish", async () => {
    const w = realWorld({
      "studio/E2E source.md": `A source ${stamp}.\n`,
      "studio/E2E bad thread.md": "---\nblyg_kind: thread\n---\n![[E2E source]]\n> a passage that is not there\n",
    });
    expect((await tapStudio(w, "studio/E2E source.md")).status).toBe("published");
    const out = await tapStudio(w, "studio/E2E bad thread.md");
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/quoted passage not found/);
    expect(w.local.get("studio/E2E bad thread.md")).not.toContain("blyg_id");
  });

  it("after a change made in the Studio, the overwrite window shows both sides, and agreeing replaces the Studio's copy", async () => {
    const w = realWorld({ "studio/E2E conflict.md": `Before ${stamp}.\n` });
    const first = await tapStudio(w, "studio/E2E conflict.md");
    const id = first.id ?? "";
    await editInStudio(w.deps.studio?.client, id, { contentMd: "Typed in the Studio." });
    w.local.set("studio/E2E conflict.md", w.local.get("studio/E2E conflict.md")?.replace("Before", "After") ?? "");
    expect(await tapStudio(w, "studio/E2E conflict.md")).toMatchObject({ status: "published", id, version: 2 });
    const conflict = w.previews.find((p) => p.action === "studio-conflict");
    expect(conflict).toMatchObject({ before: "Typed in the Studio.", after: `After ${stamp}.` });
    const got = await w.deps.studio?.client.getItem(id);
    expect(got).toMatchObject({ kind: "ok", value: { contentMd: `After ${stamp}.`, dirty: false } });
  });

  it("takes the Studio's copy of a thread into the note, ids back to names, and the note then goes out again as the Studio holds it", async () => {
    const w = realWorld({
      "studio/E2E pull fragment.md": `Pulled words ${stamp}. A second sentence.\n`,
      "studio/E2E pull thread.md": "---\nblyg_kind: thread\n---\nOpening.\n\n![[E2E pull fragment]]\n> A second sentence.\n",
    });
    const fid = (await tapStudio(w, "studio/E2E pull fragment.md")).id ?? "";
    const first = await tapStudio(w, "studio/E2E pull thread.md");
    expect(first.status).toBe("published");
    const tid = first.id ?? "";
    const client = w.deps.studio?.client;
    await editInStudio(client, tid, { contentMd: `Opening, rewritten in the Studio.\n\n![[${fid}]]\n> A second sentence.\n\nSee [[${fid} | the fragment]].\n` });
    const out = await tapStudioPull(w, "studio/E2E pull thread.md");
    expect(out.status).toBe("published");
    const text = w.local.get("studio/E2E pull thread.md") ?? "";
    expect(text).toContain("Opening, rewritten in the Studio.\n\n![[E2E pull fragment]]\n> A second sentence.\n\nSee [[E2E pull fragment|the fragment]].");
    expect(text).not.toContain(fid);
    // no overwrite question, and the Studio's own preview accepts what the note says now
    expect(await tapStudio(w, "studio/E2E pull thread.md")).toMatchObject({ status: "published", id: tid, version: 2 });
    expect(w.previews.map((p) => p.action)).not.toContain("studio-conflict");
    const got = await client?.getItem(tid);
    expect(got?.kind === "ok" ? got.value.contentMd : "").toBe(`Opening, rewritten in the Studio.\n\n![[${fid}]]\n> A second sentence.\n\nSee [[${fid} | the fragment]].`);
  });

  it("quotes an item of a blyg the Studio reads, whole and in part, with its label (needs an imported item: local-studio.sh with WITH_REMOTE=1)", async (ctx) => {
    const w = realWorld({});
    const client = w.deps.studio?.client;
    const found = await client?.search({ source: "imported", limit: 5 });
    const hit = found?.kind === "ok" ? found.value.items[0] : undefined;
    if (!client || !hit || hit.subscriptionId === null) return ctx.skip();
    const source = await client.getImported(hit.subscriptionId, hit.id);
    const text = source.kind === "ok" ? source.value.contentHtml.replace(/<[^>]+>/g, "").trim() : "";
    const passage = /^[^.]*\./.exec(text)?.[0] ?? text;
    const ref = `${hit.id} | ${hit.sourceTitle ?? "Other blyg"}: remote`;
    w.local.set("studio/E2E remote thread.md", `---\nblyg_kind: thread\n---\nOn what they said:\n\n![[${ref}]]\n\nIn part:\n\n![[${ref}]]\n> ${passage}\n\nAnd [[${ref}]].\n`);
    const out = await tapStudio(w, "studio/E2E remote thread.md");
    expect(out).toMatchObject({ status: "published", version: 1 });
    expect(w.previews.at(-1)?.studio?.quotes?.map((q) => [q.id, q.remote, q.label])).toEqual([
      [hit.id, true, `${hit.sourceTitle ?? "Other blyg"}: remote`],
      [hit.id, true, `${hit.sourceTitle ?? "Other blyg"}: remote`],
    ]);
    // the Studio keeps the label in the text it publishes (it leaves it out of the rendering)
    const got = await client.getItem(out.id ?? "");
    expect(got?.kind === "ok" ? got.value.published?.contentMd : "").toContain(`![[${ref}]]`);
  });

  it("withdraws, says so to the panel's facts, and brings the item back with the next publish", async () => {
    const w = realWorld({ "studio/E2E withdraw.md": `To be withdrawn ${stamp}.\n` });
    const first = await tapStudio(w, "studio/E2E withdraw.md");
    const id = first.id ?? "";
    const client = w.deps.studio?.client;
    if (!client) throw new Error("e2e setup");
    const clock = { now: () => new Date() };
    expect(await loadStudioFacts(client, id, clock)).toMatchObject({ item: { status: "public", version: 1 }, mentions: { count: 0, complete: true } });
    w.answer = { note: "retracted in the test" };
    expect(await tapStudioWithdraw(w, "studio/E2E withdraw.md")).toMatchObject({ status: "published", id, version: 2 });
    expect(frontmatterOf(w.local.get("studio/E2E withdraw.md") ?? "")).toMatchObject({ blyg_withdrawn: true, blyg_version: 2 });
    expect(await loadStudioFacts(client, id, clock)).toMatchObject({ item: { status: "withdrawn", version: 2 } });
    expect(await tapStudioWithdraw(w, "studio/E2E withdraw.md")).toMatchObject({ status: "noop" });
    w.answer = true;
    expect(await tapStudio(w, "studio/E2E withdraw.md")).toMatchObject({ status: "published", id, version: 3 });
    expect(await loadStudioFacts(client, id, clock)).toMatchObject({ item: { status: "public", version: 3 } });
    expect(frontmatterOf(w.local.get("studio/E2E withdraw.md") ?? "").blyg_withdrawn).toBeUndefined();
  });

  it("an item that is not there is 'missing', and the warnings of a fresh token on the tested release are empty", async () => {
    const w = realWorld({});
    const client = w.deps.studio?.client;
    if (!client) throw new Error("e2e setup");
    expect((await loadStudioFacts(client, "a0000000000000000000000099", { now: () => new Date() })).item).toBe("missing");
    expect(await loadStudioWarnings(client, TOKEN ?? "", { now: () => new Date() })).toEqual([]);
  });

  it("reposts a note with the old GitHub record as a new item and keeps the old record, quote and all", async () => {
    const OLD = "a0000000000000000000000077";
    const OLD_THREAD = "a0000000000000000000000078";
    const w = realWorld({
      "studio/E2E old fragment.md": `---\nblyg_id: ${OLD}\nblyg_version: 1\nblyg_created: 2026-10-01T10:27:15.976Z\n---\nOld words ${stamp}.\n`,
      "studio/E2E old thread.md": `---\nblyg_id: ${OLD_THREAD}\nblyg_version: 4\nblyg_kind: thread\n---\n![[E2E old fragment]]\n> Old words\n\nAnd more.\n`,
    });
    w.settings.origin = "https://old.example/blyg/";
    const note = (path: string) => ({ path, name: path.split("/").pop() ?? path, extension: "md" });
    w.answer = { note: "Reposted from old.example/blyg/ — first published 2026-10-01" };
    const frag = await repostNote(w.deps, note("studio/E2E old fragment.md"));
    expect(frag).toMatchObject({ status: "published", version: 1 });
    expect(w.previews.at(-1)?.studio?.noteDefault).toBe("Reposted from old.example/blyg/ — first published 2026-10-01");
    const fragItem = await w.deps.studio?.client.getItem(frag.id ?? "");
    // the real Studio keeps a changelog line on a first version
    expect(fragItem?.kind === "ok" ? fragItem.value.published?.note : null).toBe("Reposted from old.example/blyg/ — first published 2026-10-01");
    w.answer = true;
    const thread = await repostNote(w.deps, note("studio/E2E old thread.md"));
    expect(thread).toMatchObject({ status: "published", version: 1 });
    const got = await w.deps.studio?.client.getItem(thread.id ?? "");
    expect(got?.kind === "ok" ? got.value.contentMd : "").toBe(`![[${frag.id}]]\n> Old words\n\nAnd more.`);
    expect(frontmatterOf(w.local.get("studio/E2E old thread.md") ?? "")).toMatchObject({ blyg_id: thread.id, blyg_kind: "thread", blyg_previous: { id: OLD_THREAD, version: 4, origin: "https://old.example/blyg/" } });
    expect(frontmatterOf(w.local.get("studio/E2E old fragment.md") ?? "").blyg_created).toBeUndefined();
  });

  it("reads bracket text the way the frozen vectors say (tests/fixtures/studio/bracket-grammar.json): the Studio has not drifted from them", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/studio/bracket-grammar.json", import.meta.url), "utf8")) as { cases: Array<{ text: string; directives: number; links: number }> };
    const w = realWorld({});
    const client = w.deps.studio?.client;
    if (!client) throw new Error("e2e setup");
    for (const c of fixture.cases) {
      const previewed = await client.preview({ contentMd: c.text, kind: "thread" });
      const directives = previewed.kind === "ok" ? previewed.value.problems.filter((p) => p.directive?.startsWith("![[")).length : -1;
      const links = previewed.kind === "ok" ? previewed.value.problems.filter((p) => p.directive?.startsWith("[[")).length : -1;
      expect([c.text, directives, links]).toEqual([c.text, c.directives, c.links]);
    }
  });

  it("keeps the line breaks you see in Obsidian, also in a quote across them", async () => {
    const w = realWorld({
      "studio/E2E breaks.md": `First line ${stamp}\nSecond line\nThird line\n\nA new paragraph.\n`,
      "studio/E2E breaks thread.md": `---\nblyg_kind: thread\n---\n![[E2E breaks]]\n> First line ${stamp}\n>\n> Second line\n\nAnd my answer.\n`,
    });
    const first = await tapStudio(w, "studio/E2E breaks.md");
    expect(first.status).toBe("published");
    const preview = await w.deps.studio?.client.preview({ contentMd: "A\n\nLine1  \nLine2", kind: "fragment" });
    expect(preview?.kind === "ok" ? preview.value.html : "").toContain("Line1<br>");
    const item = await w.deps.studio?.client.getItem(first.id ?? "");
    expect(item?.kind === "ok" ? item.value.published?.contentHtml : "").toMatch(/First line [^<]*<br>\s*Second line<br>\s*Third line/);
    // a passage that runs across a hard break is found by the Studio when the quote keeps the break as a paragraph break
    const thread = await tapStudio(w, "studio/E2E breaks thread.md");
    expect(thread.status).toBe("published");
    expect(w.previews.at(-1)?.studio?.quotes?.[0]?.passage).toBe(`First line ${stamp}\nSecond line`);
  });
  it("imports items written in the Studio (a fragment, a thread quoting it, a draft); each note then has nothing to send", async () => {
    const w = realWorld({});
    const studio = w.deps.studio;
    const edit = w.deps.edit;
    if (!studio || !edit) throw new Error("e2e setup");
    const { client } = studio;
    const stamp = Date.now().toString(36);
    // Written "on the web": through the same owner API the Studio's editor uses.
    const frag = await client.createItem({ kind: "fragment", contentMd: `Web fragment ${stamp}` });
    if (frag.kind !== "ok") throw new Error("create fragment");
    expect((await publishNow(client, frag.value.id)).kind).toBe("ok");
    const thread = await client.createItem({ kind: "thread", contentMd: `Web thread ${stamp}\n\n![[${frag.value.id}]]\n\nAfter the quote.` });
    if (thread.kind !== "ok") throw new Error("create thread");
    expect((await publishNow(client, thread.value.id)).kind).toBe("ok");
    const draft = await client.createItem({ kind: "fragment", contentMd: `Web draft ${stamp}` });
    if (draft.kind !== "ok") throw new Error("create draft");

    const exists = (p: string): boolean => [...w.local.keys()].some((k) => k.toLowerCase() === p.toLowerCase());
    const deps: ImportDeps = {
      client,
      address: studio.address,
      routes: STUDIO_ROUTES,
      importFolder: "",
      fragmentCharCap: 1000,
      vault: w.deps.vault,
      edit,
      yaml: jsYaml,
      files: { exists, ensureFolder: () => Promise.resolve(), create: (p, t) => (w.local.set(p, t), Promise.resolve({ path: p, name: p.split("/").pop() ?? p, extension: "md" })) },
    };
    const scan = await scanStudioImport(deps, new Set());
    if (!scan.ok) throw new Error(scan.outcome.notices.join(" "));
    const mine = new Set([frag.value.id, thread.value.id, draft.value.id]);
    const chosen = scan.scan.candidates.filter((c) => mine.has(c.id));
    expect(chosen).toHaveLength(3);
    expect(chosen.at(-1)?.id).toBe(thread.value.id); // fragments first, so the thread's embed finds the fragment's note
    const out = await importStudioItems(deps, chosen, scan.route);
    expect(out.status).toBe("published");
    const threadPath = `studio/Web thread ${stamp}.md`;
    expect(w.local.get(threadPath)).toContain(`![[Web fragment ${stamp}]]`);
    expect(await tapStudio(w, `studio/Web fragment ${stamp}.md`)).toMatchObject({ status: "noop" });
    expect(await tapStudio(w, threadPath)).toMatchObject({ status: "noop" });
    expect(frontmatterOf(w.local.get(`studio/Web draft ${stamp}.md`) ?? "")).toMatchObject({ blyg_id: draft.value.id, blyg_version: 0 });
    // the draft is published from its note: version 1 of the same item
    expect(await tapStudio(w, `studio/Web draft ${stamp}.md`)).toMatchObject({ status: "published", id: draft.value.id, version: 1 });
  });
  it("hoppers (S13): a note's hoppers are applied after the text, taken out when removed from the note, and a removal made in the Studio stands", async () => {
    // A hopper made "in the Studio" (the plugin itself never creates one, D4).
    const stamp = Date.now().toString(36);
    const made = await fetch(`${URL_ ?? ""}/api/hoppers`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN ?? ""}`, "content-type": "application/json" }, body: JSON.stringify({ name: `E2E hopper ${stamp}` }) });
    expect(made.status).toBe(201);
    const hopper = (await made.json()) as { id: string; name: string };
    const path = `studio/E2E hopper note ${stamp}.md`;
    const w = realWorld({ [path]: `---\nblyg_hoppers: ["${hopper.name}"]\n---\nIn a hopper ${stamp}.\n` });
    const client = w.deps.studio?.client;
    if (!client) throw new Error("e2e setup");
    const first = await tapStudio(w, path);
    expect(first.status).toBe("published");
    const setHoppers = (names: string[]): void => {
      const text = w.local.get(path) ?? "";
      const props = { ...frontmatterOf(text), blyg_hoppers: names };
      w.local.set(path, `---\n${jsYaml.stringify(props).trimEnd()}\n---\n${text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")}`);
    };
    const members = async (): Promise<string[]> => {
      const got = await client.hopperMembers(hopper.id);
      if (got.kind !== "ok") throw new Error("members");
      return got.value.ids;
    };
    expect(await members()).toContain(first.id);
    expect(frontmatterOf(w.local.get(path) ?? "")).toMatchObject({ blyg_hoppers: [hopper.name], blyg_hoppers_sent: [hopper.id] });

    // taken off the note: taken out, no new version
    setHoppers([]);
    const second = await tapStudio(w, path);
    expect(second.notices).toContain(M.hoppersOnlyText);
    expect(await members()).not.toContain(first.id);

    // back on the note: added again; then removed in the Studio, and the next send leaves it out
    setHoppers([hopper.name]);
    await tapStudio(w, path);
    expect(await members()).toContain(first.id);
    expect((await client.removeFromHopper(hopper.id, first.id ?? "")).kind).toBe("ok");
    expect(await tapStudio(w, path)).toMatchObject({ status: "noop" });
    expect(await members()).not.toContain(first.id);
    const item = await client.getItem(first.id ?? "");
    expect(item.kind === "ok" && item.value.version).toBe(1);
  });
  it("replies (S10) and addresses (S9): an item of a blyg the Studio reads is found by its address, answered as a stub, and goes out again unchanged (needs WITH_REMOTE=1)", async (ctx) => {
    const w = realWorld({});
    const client = w.deps.studio?.client;
    const address = w.deps.studio?.address;
    const found = await client?.search({ source: "imported", limit: 5 });
    const hit = found?.kind === "ok" ? found.value.items[0] : undefined;
    if (!client || !address || !hit || hit.subscriptionId === null) return ctx.skip();

    // by the Studio's own reader address, and by the public page of the other blyg (the Studio classifies it)
    const byReader = await lookupAddress(client, address, `${address.host}/studio/reading/${hit.subscriptionId}/${hit.id}`);
    expect(byReader).toMatchObject({ kind: "found", pick: { id: hit.id, subscriptionId: hit.subscriptionId, quotable: true } });
    const sub = await client.getSubscription(hit.subscriptionId);
    if (sub.kind !== "ok" || byReader.kind !== "found") throw new Error("lookup");
    const byPage = await lookupAddress(client, address, `${sub.value.origin}f/${hit.id}/?utm_source=share`);
    expect(byPage).toMatchObject({ kind: "found", pick: { id: hit.id, origin: sub.value.origin, version: hit.version, quotable: true } });
    expect(await lookupAddress(client, address, "https://example.com/nothing-here")).toEqual({ kind: "problem", message: M.lookupNotAnItem });

    // the reply: what it names, then a thread note that carries it
    const named = await stubTargetOf(client, address, byReader.pick);
    if (!named.ok) throw new Error(named.message);
    expect(named.target).toMatchObject({ origin: sub.value.origin, id: hit.id, version: hit.version });
    const path = `studio/E2E reply ${Date.now().toString(36)}.md`;
    const props = jsYaml.stringify({ blyg_kind: "thread", blyg_stub_of: stubProperty(named.target) }).trimEnd();
    w.local.set(path, `---\n${props}\n---\n![[${hit.id} | ${byReader.pick.label}]]\n\nI disagree.\n`);
    const out = await tapStudio(w, path);
    expect(out.notices.join(" | ")).not.toMatch(/budget|limiting/);
    expect(out).toMatchObject({ status: "published", version: 1 });
    expect(w.previews.at(-1)?.changes.some((c) => c.startsWith("A reply to"))).toBe(true);
    const got = await client.getItem(out.id ?? "");
    expect(got.kind === "ok" && got.value.stubOf).toMatchObject({ origin: sub.value.origin, id: hit.id });
    // sent back unchanged: nothing to send, and the reply target is not re-sent
    expect(await tapStudio(w, path)).toMatchObject({ status: "noop" });

    // a fragment cannot be a reply
    w.local.set("studio/E2E fragment reply.md", `---\n${jsYaml.stringify({ blyg_stub_of: stubProperty(named.target) }).trimEnd()}\n---\nNo.\n`);
    expect(await tapStudio(w, "studio/E2E fragment reply.md")).toMatchObject({ status: "refused", notices: [M.stubNeedsThread] });
  });
});
