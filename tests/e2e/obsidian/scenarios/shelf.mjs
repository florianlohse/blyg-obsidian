// SH1, Save for later, in real Obsidian against a stand-in Studio that speaks contract 6.2.0 with a shelf (`GET/PUT /api/shelf`, `GET /api/reading?shelf=true`), feature "shelf" on:
// the shelf is read once when the reader opens (and a second device's saved post shows its small "saved" mark); a long press (real touch events, phone layout) on a card offers
// "Save for later" and one tap writes exactly one PUT that names the revision; the open post has Save / Saved; a save that loses a race to another device is answered with the Studio's
// current list and re-applied (the other device's entry is still there); the Saved view in Sort & filter is one read and no write, shows an older post the feed did not load, and a
// removal is one PUT; a full shelf (50) says so and sends nothing; a token without owner:manage says which permission is missing and sends nothing. (Chromium emulation, not iOS.)
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/shelf.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (scope) => `${b64({ typ: "at+jwt", alg: "RS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, scope })}.c2lnbmF0dXJl`;
const WITH_MANAGE = jwt("owner:read owner:draft owner:publish owner:manage reading:state");
const WITHOUT_MANAGE = jwt("owner:read owner:draft owner:publish");

const mk = (id, text, i) => ({
  subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: 1,
  observedAt: new Date(Date.now() - (i + 1) * 600e3).toISOString(), created: null, contentHtml: `<p>${text}</p>`, contentMd: text, author: { name: `Author ${id}`, url: null }, stubOf: null,
});
const posts = [mk("p0", "Harbour tide lantern is the first post of the day.", 0), mk("p1", "Orchard cider press runs all week long.", 1), mk("p2", "Glacier survey drone found something odd.", 2), mk("p3", "Market ledger tariff changed again today.", 3)];
const older = mk("older", "An older post that the feed never loaded.", 400);

// The stand-in Studio's shelf, and everything it saw.
const state = { shelf: [{ sub: "s1", remoteId: "p2" }, { sub: "s1", remoteId: "older" }], revision: 3, gets: 0, puts: [], shelfReads: 0, savedLists: [], beforePut: null };
const page = (items) => ({ items, page: { limit: 50, nextCursor: null } });
const shelved = () => state.shelf.flatMap((e) => {
  const p = [...posts, older].find((x) => x.remoteId === e.remoteId);
  return p ? [{ key: `${e.sub}/${e.remoteId}`, source: "imported", kind: "fragment", withdrawn: false, l0: false, contentHtml: p.contentHtml, displayAt: p.observedAt, background: { reasons: [], placement: null, blyg: false },
    imported: { subscriptionId: "s1", subscriptionTitle: "Example blyg", remoteId: p.remoteId, kind: "fragment", withdrawn: false, l0: false, updated: p.observedAt, observedAt: p.observedAt, contentHtml: p.contentHtml, pinnedVersionRetained: null, sourceUrl: null, version: 1, readVersion: 1 } }] : [];
});
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const path = url.pathname;
    if (path === "/blyg.json") return reply(res, 200, { blyg: "0.4", level: 2, generator: "blygger-studio/0.69.0", site: `http://127.0.0.1:${stub.address().port}/`, title: "Stand-in", items: "items/index.json" });
    if (path === "/api/capabilities") return reply(res, 200, { contractVersion: "6.2.0", endpoints: {}, extensions: [], operations: ["getCapabilities", "listItems", "listSubscriptions", "listReading", "listImportedReading", "getShelf", ...(String(req.headers.authorization ?? "").includes(WITH_MANAGE) ? ["putShelf"] : [])] });
    if (path === "/api/shelf" && req.method === "GET") { state.gets++; return reply(res, 200, { entries: state.shelf, revision: state.revision }); }
    if (path === "/api/shelf" && req.method === "PUT") {
      const body = JSON.parse(raw || "{}");
      if (state.beforePut) { const f = state.beforePut; state.beforePut = null; f(); } // another device's save lands first
      const rec = { expectedRevision: body.expectedRevision, entries: body.entries };
      if (body.expectedRevision !== state.revision) { state.puts.push({ ...rec, status: 409 }); return reply(res, 409, { code: "revision-conflict", message: "the shelf changed", details: { current: { entries: state.shelf, revision: state.revision } } }); }
      state.shelf = body.entries; state.revision++;
      state.puts.push({ ...rec, status: 200 });
      return reply(res, 200, { entries: state.shelf, revision: state.revision });
    }
    if (path === "/api/reading" && url.searchParams.get("shelf") === "true") { state.savedLists.push(req.url); return reply(res, 200, { ...page(shelved()), readState: true, readStateClear: true }); }
    if (path === "/api/reading/imported") return reply(res, 200, page(posts));
    if (path === "/api/subscriptions/poll") return reply(res, 200, { polling: 0 });
    if (req.method === "GET" && path.startsWith("/api/")) return reply(res, 200, page([]));
    return reply(res, 404, { code: "not-found", message: "not found" });
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;
data.features = { shelf: true }; // an experimental feature is off in the release flavour this harness loads

await runScenario({ data }, async (s) => {
  const { check } = s;
  const pg = s.page;
  const errors = [];
  pg.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  const useToken = async (t) => {
    await pg.evaluate((v) => window.app.secretStorage.setSecret("smoke-studio", v), t);
    for (let i = 0; i < 40; i++) { if ((await pg.evaluate(() => window.app.secretStorage.getSecret("smoke-studio"))) === t) return; await wait(100); }
  };
  const eventually = async (fn, ms = 15000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await wait(250); v = await fn(); } return v; };
  const dropToasts = () => pg.evaluate(() => { for (const n of activeDocument.querySelectorAll(".notice")) n.remove(); });
  const openReader = async () => {
    await pg.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-reader"));
    await wait(400);
    await pg.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.filter = { sort: "newest", source: null, unreadOnly: false, length: "any" }; });
    await pg.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await pg.waitForSelector(".blyg-reader-card", { timeout: 30000 });
    await eventually(() => pg.evaluate(() => !/Loading|updating|Checking/.test(document.querySelector(".blyg-reader-status")?.textContent ?? "")));
    await wait(800);
  };
  const cards = () => pg.evaluate(() => [...document.querySelectorAll(".blyg-reader-card")].map((c) => ({ text: c.textContent ?? "", saved: c.querySelector(".blyg-savedmark")?.getAttribute("aria-label") ?? "", word: /\bsaved\b/i.test(c.querySelector(".blyg-reader-badges")?.textContent ?? ""), firstInMeta: c.querySelector(".blyg-reader-cardmeta")?.firstElementChild?.classList.contains("blyg-savedmark") ?? false })));
  const menu = () => pg.evaluate(() => [...activeDocument.querySelectorAll(".menu .menu-item")].map((e) => ({ title: e.querySelector(".menu-item-title")?.textContent ?? "", disabled: e.classList.contains("is-disabled") })));
  const status = () => pg.evaluate(() => document.querySelector(".blyg-reader-status")?.textContent ?? "");
  const pick = async (title) => { await pg.evaluate((t) => [...activeDocument.querySelectorAll(".menu .menu-item")].find((e) => e.querySelector(".menu-item-title")?.textContent === t)?.click?.(), title); await wait(1200); };
  const cardOf = (word) => pg.evaluate((w) => { const c = [...document.querySelectorAll(".blyg-reader-card")].findIndex((x) => x.textContent?.includes(w)); return c; }, word);
  const cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const longPress = async (word) => {
    await pg.evaluate((w) => [...document.querySelectorAll(".blyg-reader-card")].find((x) => x.textContent?.includes(w))?.scrollIntoView({ block: "center" }), word);
    await wait(500);
    await dropToasts();
    const c = await pg.evaluate((w) => { const e = [...document.querySelectorAll(".blyg-reader-card")].find((x) => x.textContent?.includes(w)); const r = e?.getBoundingClientRect(); return r ? { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + Math.min(r.height / 2, 20)) } : null; }, word);
    if (!c) return false;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c.x, y: c.y }] });
    await wait(650);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(500);
    return true;
  };
  const closeMenu = async () => { await pg.keyboard.press("Escape"); await wait(300); };

  await useToken(WITH_MANAGE);
  await openReader();

  // ---- the shelf is read once per opening; a post saved on another device shows its mark; nothing else is asked of it
  await eventually(() => state.gets >= 1);
  await wait(1500);
  check(state.gets === 1, `the shelf was read once when the reader opened (${state.gets})`);
  const first = await cards();
  check(first.length === 4, `the feed holds the four posts (${first.length})`);
  check(first.filter((c) => c.saved === "Saved").length === 1 && first.find((c) => c.text.includes("Glacier"))?.saved === "Saved", `only the post saved on the other device has the saved mark (${JSON.stringify(first.map((c) => c.saved))})`);
  check(state.puts.length === 0 && state.savedLists.length === 0, "opening the reader wrote nothing and listed no Saved view");
  check(first.every((c) => !c.word) && first.filter((c) => c.saved === "Saved").every((c) => c.firstInMeta), `the card says it with the bookmark mark, first in its meta line, and no longer with the word "saved" (${JSON.stringify(first.map((c) => [c.saved, c.word, c.firstInMeta]))})`);

  // ---- a long press offers Save for later; one tap is one PUT that names the revision; the card shows the mark
  await longPress("Harbour");
  const m1 = await menu();
  check(m1.some((e) => e.title === "Save for later" && !e.disabled), `a long press on a card offers "Save for later" (${JSON.stringify(m1.map((e) => e.title))})`);
  await pick("Save for later");
  await eventually(() => state.puts.length >= 1);
  check(state.puts.length === 1 && state.puts[0].status === 200 && state.puts[0].expectedRevision === 3, `one PUT, carrying the revision it was made from (${JSON.stringify(state.puts.map((p) => [p.status, p.expectedRevision]))})`);
  check(state.shelf[0].remoteId === "p0" && state.shelf.length === 3, `the shelf holds the new post first and the others still (${state.shelf.map((e) => e.remoteId)})`);
  check(state.gets === 1, "the save needed no read of the shelf of its own");
  check((await cards()).find((c) => c.text.includes("Harbour"))?.saved === "Saved", "the card shows the saved mark");
  check(/Saved for later/.test(await status()), `the status line says so (${await status()})`);

  // ---- the open post: Save / Saved
  await pg.evaluate(() => [...document.querySelectorAll(".blyg-reader-card")].find((x) => x.textContent?.includes("Orchard"))?.click());
  await pg.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 15000 });
  const saveBtn = () => pg.evaluate(() => { const b = document.querySelector(".blyg-reader-header .blyg-reader-savebtn"); return b ? { text: b.getAttribute("aria-label"), glyph: !!b.querySelector("svg"), words: b.textContent?.trim() ?? "", disabled: b.disabled, saved: b.classList.contains("is-saved"), title: b.getAttribute("title") } : null; });
  const b1 = await saveBtn();
  check(b1?.text === "Save for later" && b1.glyph && b1.words === "" && !b1.disabled, `the open post has a Save button (${JSON.stringify(b1)})`);
  // another device saves a post first: this device's cache is stale, so the PUT is answered with a 409 and the one change is applied to the current list
  state.beforePut = () => { state.shelf = [{ sub: "s1", remoteId: "p3" }, ...state.shelf]; state.revision++; };
  const putsBefore = state.puts.length;
  await pg.click(".blyg-reader-header .blyg-reader-savebtn");
  await eventually(() => state.puts.length >= putsBefore + 2);
  const raced = state.puts.slice(putsBefore).map((p) => p.status);
  check(JSON.stringify(raced) === "[409,200]", `the race: the first PUT was refused with 409, the second succeeded (${JSON.stringify(raced)})`);
  const ids = state.shelf.map((e) => e.remoteId);
  check(ids.includes("p1") && ids.includes("p3") && ids.includes("p0") && ids.includes("p2") && ids.includes("older") && ids.length === 5, `the other device's save and everything else survived (${ids})`);
  check(state.puts.slice(putsBefore).every((p) => Number.isInteger(p.expectedRevision)), "every send named a revision");
  await eventually(async () => (await saveBtn())?.text === "Saved");
  const b2 = await saveBtn();
  check(b2?.text === "Saved" && b2.saved && b2.glyph, `the button says Saved afterwards (${JSON.stringify(b2)})`);

  // A: the status line's "Saved for later." belongs to the post it was said about: stepping to the next post clears it
  check(/Saved for later/.test(await status()), `after saving the open post the status line says so (${await status()})`);
  await pg.click(".blyg-reader-header .blyg-reader-step-next");
  await eventually(async () => !/Saved for later/.test(await status()));
  check(!/Saved for later|Removed from saved/.test(await status()), `moving to the next post clears that message (${JSON.stringify(await status())})`);
  await pg.click(".blyg-reader-header .blyg-reader-step-prev");
  await eventually(async () => (await saveBtn())?.text === "Saved");

  // ---- back to the feed, the Saved view: one read, no write, an older post the feed did not load, in the shelf's order
  await pg.click(".blyg-reader-header .blyg-reader-back");
  await pg.waitForSelector(".blyg-reader-card", { timeout: 15000 });
  await pg.click(".blyg-reader-menubtn"); // (DG19: Sort & filter is a row of the header's menu)
  await pg.click(".blyg-reader-filterbtn");
  await pg.waitForSelector(".blyg-reader-chip", { timeout: 10000 });
  const reads0 = state.savedLists.length;
  const puts0 = state.puts.length;
  const chipText = await pg.evaluate(() => [...document.querySelectorAll(".blyg-reader-chip")].map((b) => b.textContent));
  check(chipText.some((t) => /^Saved \(5\)$/.test(t ?? "")), `the filter row has a Saved chip with the count (${JSON.stringify(chipText)})`);
  await pg.evaluate(() => [...document.querySelectorAll(".blyg-reader-chip")].find((b) => /^Saved/.test(b.textContent ?? ""))?.click());
  await eventually(() => state.savedLists.length > reads0);
  await wait(1200);
  const view = await cards();
  check(state.savedLists.length === reads0 + 1 && state.puts.length === puts0, `the Saved view is one read and no write (${state.savedLists.length - reads0} reads, ${state.puts.length - puts0} writes)`);
  check(/order=newest/.test(state.savedLists.at(-1) ?? ""), `it asks with order=newest, which writes nothing on the Studio (${state.savedLists.at(-1)})`);
  check(view.length === 5 && view.some((c) => c.text.includes("older post that the feed never loaded")), `it shows all five saved posts, the older one included (${view.length})`);
  check(view.every((c) => c.saved === "Saved"), "every card in the Saved view has the mark");
  const order = view.map((c) => ["Orchard", "Market", "Harbour", "Glacier", "older post"].findIndex((w) => c.text.includes(w)));
  check(JSON.stringify(order) === JSON.stringify([0, 1, 2, 3, 4]), `the Saved view keeps the shelf's order (${JSON.stringify(order)})`);

  // ---- remove from saved: one PUT, the card leaves the view
  await longPress("Market");
  const m2 = await menu();
  check(m2.some((e) => e.title === "Remove from saved"), `a saved card offers "Remove from saved" (${JSON.stringify(m2.map((e) => e.title))})`);
  await pick("Remove from saved");
  await eventually(() => state.puts.length > puts0);
  check(state.puts.length === puts0 + 1 && !state.shelf.some((e) => e.remoteId === "p3"), `removing is one PUT and takes out only that post (${state.shelf.map((e) => e.remoteId)})`);
  check(!(await cards()).some((c) => c.text.includes("Market")) && (await cards()).length === 4, "the card is gone from the Saved view");
  await pg.evaluate(() => [...document.querySelectorAll(".blyg-reader-chip")].find((b) => /^Saved/.test(b.textContent ?? ""))?.click());
  await wait(800);
  check((await cards()).length === 4 && !(await cards()).some((c) => c.text.includes("older post")), "leaving the Saved view shows the feed again");

  // ---- a full shelf: said plainly, no PUT, nothing dropped
  state.shelf = Array.from({ length: 50 }, (_, i) => ({ sub: "s1", remoteId: i === 0 ? "p2" : `x${i}` }));
  state.revision++;
  await openReader();
  await eventually(() => state.gets >= 2);
  const puts1 = state.puts.length;
  await longPress("Harbour");
  const m3 = await menu();
  const entry = m3.find((e) => e.title === "Save for later");
  check(entry?.disabled === true, `on a full shelf the menu shows Save for later disabled (${JSON.stringify(m3)})`);
  await closeMenu();
  await pg.evaluate(() => [...document.querySelectorAll(".blyg-reader-card")].find((x) => x.textContent?.includes("Harbour"))?.click());
  await pg.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 15000 });
  const full = await saveBtn();
  check(full?.disabled === true && /full \(50 posts\)/.test(full.title ?? ""), `the open post's Save is disabled and says the shelf is full (${JSON.stringify(full)})`);
  check(state.puts.length === puts1 && state.shelf.length === 50, "nothing was sent and nothing was dropped");

  // ---- a token without owner:manage: the message names the permission, nothing is sent
  state.shelf = [{ sub: "s1", remoteId: "p2" }];
  state.revision++;
  await useToken(WITHOUT_MANAGE);
  await openReader();
  const puts2 = state.puts.length;
  await pg.evaluate(() => [...document.querySelectorAll(".blyg-reader-card")].find((x) => x.textContent?.includes("Harbour"))?.click());
  await pg.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 15000 });
  await pg.click(".blyg-reader-header .blyg-reader-savebtn");
  await eventually(async () => /owner:manage/.test(await status()));
  check(/owner:manage/.test(await status()) && state.puts.length === puts2, `without owner:manage the status line names the permission and nothing is sent (${await status()})`);

  check(errors.length === 0, `no uncaught page error (${errors.join(" | ")})`);
});
