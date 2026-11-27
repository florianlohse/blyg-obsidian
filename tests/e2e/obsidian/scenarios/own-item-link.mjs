// RC1, a quote of one of your OWN items in another person's post, in real Obsidian at the phone layout against a stand-in Studio.
//   The source line under the quote ("You, in your own item") is a link: a tap opens that item in the reader's detail view, as your own post (Back returns to the post with the quote
//   at the same place); "Open note" there opens the vault note that holds the item (the note whose frontmatter carries its id) in ONE tab, and asking again brings that tab forward;
//   the way back to the reader (command "Open reader") brings the SAME reader leaf forward with the item still open (no second reader). An item no note holds says so in one line.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/own-item-link.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const MINE = "7c2d9fqk3m8x5r1n6t0vbhwy4z"; // an item of yours, with a note in the vault
const LOOSE = "0b3d9fqk3m8x5r1n6t0vbhwy4z"; // an item of yours, published from elsewhere: no note here
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const item = (id, text) => ({ id, revision: 3, kind: "fragment", status: "public", version: 1, contentMd: text, dirty: false, created: "2026-11-01T10:00:00Z", updated: "2026-11-02T10:00:00Z", stubOf: null, published: { version: 1, contentMd: text, contentHtml: `<p>${text}</p>`, contentHash: "h", note: null } });
const ITEMS = { [MINE]: item(MINE, "My own words about stigmergy."), [LOOSE]: item(LOOSE, "Words published from another place.") };
const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  req.on("data", () => {});
  req.on("end", () => {
    const path = url.pathname;
    if (path === "/blyg.json") return reply(res, 200, { blyg: "0.4", level: 2, generator: "blygger-studio/0.51.0", site: `http://127.0.0.1:${stub.address().port}/`, title: "Stand-in", items: "items/index.json" });
    if (path === "/api/capabilities") return reply(res, 200, { contractVersion: "5.2.0", endpoints: {}, extensions: [], operations: ["getCapabilities", "listItems", "getItem"] });
    const one = /^\/api\/items\/([^/]+)$/.exec(path);
    if (one) return ITEMS[one[1]] ? reply(res, 200, ITEMS[one[1]]) : reply(res, 404, { code: "not-found", message: "not found" });
    if (path === "/api/subscriptions/poll") return reply(res, 200, { polling: 0 });
    if (req.method === "GET" && path.startsWith("/api/")) return reply(res, 200, { items: [], page: { limit: 50, nextCursor: null } });
    return reply(res, 404, { code: "not-found", message: "not found" });
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const data = fixtureData();
data.studio.baseUrl = `http://127.0.0.1:${stub.address().port}`;

const NOTE = `---\nblyg_id: ${MINE}\nblyg_version: 1\nblyg_kind: fragment\n---\nMy own words about stigmergy.\n`;
const PATH = "Blyg/Own item.md";
const quoting = (id) => `<p>Teo answers.</p><blockquote class="blyg-transclusion" data-blyg-id="${id}" data-blyg-version="1" data-blyg-origin="https://me.example.com/" data-blyg-label="my words"><p>Quoted.</p></blockquote>` + "<p>More.</p>".repeat(80);
const POST = (id, html) => ({ subscriptionId: "sub-x", subscriptionTitle: "Teo's blyg", origin: "https://teo.example.com/", remoteId: id, kind: "thread", withdrawn: false, version: 1, readVersion: 1, observedAt: new Date().toISOString(), created: new Date().toISOString(), isReply: false, contentHtml: html, contentMd: "", authorName: "Teo", authorUrl: null, sourceUrl: null });

await runScenario({ data }, async (s) => {
  const { check, page } = s;
  await s.phone();
  await s.createNote(PATH, NOTE);
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
  await s.becomes(async () => (await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").length)) === 1, 20000, "the reader is open");
  await wait(1500);
  const state = () => page.evaluate((path) => {
    const w = window.app.workspace;
    const reader = w.getLeavesOfType("blyg-reader");
    const note = w.getLeavesOfType("markdown").filter((l) => l.view.file?.path === path);
    return { readers: reader.length, notes: note.length, shown: reader[0]?.view.shown?.remoteId ?? null, own: reader[0]?.view.shown?.own === true, noteActive: note.some((l) => l === w.activeLeaf), readerActive: reader[0] === w.activeLeaf };
  }, PATH);
  const show = (post) => page.evaluate(async (p) => {
    const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
    view.data = view.data ?? { posts: [], mentions: [], mentionsFetched: false, note: "", studioOrigin: "", incremental: false, moreOlder: false };
    view.openPost(p);
    await new Promise((r) => setTimeout(r, 1200));
  }, post);
  const sourceLine = () => page.evaluate(() => [...document.querySelectorAll(".blyg-quote-source")].map((e) => ({ text: e.textContent?.trim() ?? "", link: e.classList.contains("is-link") })));
  const readerBtn = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll(".blyg-reader button")].find((x) => x.textContent?.trim() === l); if (!b || b.disabled) return false; b.click(); return true; }, label);

  // ---- the source line is a link, and a tap opens your own item in the reader
  await show(POST("src-1", quoting(MINE)));
  const lines = await s.becomes(async () => { const l = await sourceLine(); return l.some((x) => x.link && /^You, in your own item/.test(x.text)) ? l : false; }, 15000, "the source line of your own item becomes a link");
  check(Boolean(lines), `a quote of your own item has a link under it saying "You, in your own item · my words" (${JSON.stringify(lines)})`);
  const top = await page.evaluate(() => { const sc = document.querySelector(".blyg-reader-scroll"); sc.scrollTop = 300; return sc.scrollTop; });
  await page.evaluate(() => document.querySelector(".blyg-quote-source.is-link")?.click());
  await wait(800);
  let st = await state();
  check(st.shown === MINE && st.own && st.readers === 1, `a tap opens that item in the reader's detail view as your own post, in the one reader (${JSON.stringify(st)})`);
  check(/My own words/.test((await page.evaluate(() => document.querySelector(".blyg-reader-body")?.textContent ?? ""))), "its text is the item's text");

  // ---- Back returns to the post with the quote, at the same place
  await page.evaluate(() => document.querySelector(".blyg-reader-back")?.click());
  await wait(800);
  st = await state();
  const after = await page.evaluate(() => document.querySelector(".blyg-reader-scroll")?.scrollTop ?? -1);
  check(st.shown === "src-1" && st.readers === 1, `Back returns to the post with the quote (${JSON.stringify(st)})`);
  check(Math.abs(after - top) <= 2 && top > 0, `... at the same place (was ${top}, now ${after})`);

  // ---- open the item again, then "Open note": one tab, the note of that item
  await page.evaluate(() => document.querySelector(".blyg-quote-source.is-link")?.click());
  await wait(800);
  const onNoteButton = await page.evaluate(() => [...document.querySelectorAll(".blyg-reader button")].some((x) => x.textContent?.trim() === "Open note" && !x.disabled));
  check(onNoteButton, "the detail view of your own item has an Open note button");
  await readerBtn("Open note");
  await s.becomes(async () => (await state()).notes === 1, 10000, "the note opens");
  st = await state();
  check(st.notes === 1 && st.noteActive, `Open note opens the item's note (${JSON.stringify(st)})`);

  // ---- the way back: the same reader, the item still open; and Open note again brings the one note tab forward, no second tab
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
  await wait(800);
  st = await state();
  check(st.readers === 1 && st.shown === MINE && st.readerActive, `Open reader brings the same reader forward with the item still open (${JSON.stringify(st)})`);
  await readerBtn("Open note");
  await wait(800);
  st = await state();
  check(st.notes === 1 && st.noteActive, `a second Open note brings the same tab forward, no duplicate (${JSON.stringify(st)})`);

  // ---- an item no note here holds: a link too, and Open note says so in one line
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
  await wait(800);
  await show(POST("src-2", quoting(LOOSE)));
  await s.becomes(async () => (await sourceLine()).some((x) => x.link && /^You, in your own item/.test(x.text)), 15000, "the source line of the loose item becomes a link");
  await page.evaluate(() => document.querySelector(".blyg-quote-source.is-link")?.click());
  await wait(800);
  await readerBtn("Open note");
  await wait(600);
  const status = await page.evaluate(() => document.querySelector(".blyg-reader-status")?.textContent ?? "");
  st = await state();
  check(st.shown === LOOSE && st.notes === 1 && /no note|not in this vault/i.test(status), `an item with no note here says so in one line and stays in the reader (${status})`);
});
stub.close();
