// The open post of the reader when it was opened from the Daily (fix batch FX1, four bugs seen on a phone), in real Obsidian against a stand-in Studio that records every write:
//  1. a read mark made in the open post (opened from the digest) reaches the Studio (one PUT), shows in the digest afterwards (the post and its story) and in a reopened post;
//  2. the header of the open post does not change while it settles: its children and the place of Save are the same in every frame of the first 1.5 s;
//  3. a save that loses its connection puts Save back with one line, and a second tap saves;
//  4. the feed opened for the first time says "Loading…" while its first list is on its way, never "nothing to show".
// (Chromium emulation of a desktop layout, not iOS.)
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/reader-detail.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (scope) => `${b64({ typ: "at+jwt", alg: "RS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, scope })}.c2lnbmF0dXJl`;
const WITH_MANAGE = jwt("owner:read owner:draft owner:publish owner:manage reading:state");

const marks = []; // PUT .../read
const unmarks = []; // DELETE .../read
const hung = []; // list requests left unanswered (they hold the app's few connections to this host)
const state = { shelf: [], revision: 1, puts: [], dropPut: false };
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const path = url.pathname;
    if (/\/reading\/[^/]+\/[^/]+\/read$/.test(path) && req.method === "PUT") { marks.push({ at: Date.now(), path }); return reply(res, 200, { readVersion: 1 }); }
    if (/\/reading\/[^/]+\/[^/]+\/read$/.test(path) && req.method === "DELETE") { unmarks.push({ at: Date.now(), path }); return reply(res, 200, { readVersion: null }); }
    if (path === "/blyg.json") return reply(res, 200, { blyg: "0.4", level: 2, generator: "blygger-studio/0.69.0", site: `http://127.0.0.1:${stub.address().port}/`, title: "Stand-in", items: "items/index.json" });
    if (path === "/api/capabilities") return reply(res, 200, { contractVersion: "6.2.0", endpoints: {}, extensions: [], operations: ["getCapabilities", "listItems", "listSubscriptions", "listReading", "listImportedReading", "getShelf", "putShelf"] });
    if (path === "/api/shelf" && req.method === "GET") return reply(res, 200, { entries: state.shelf, revision: state.revision });
    if (path === "/api/shelf" && req.method === "PUT") {
      const body = JSON.parse(raw || "{}");
      if (state.dropPut) { state.puts.push({ dropped: true }); req.socket.destroy(); return; } // the connection is lost mid-request
      state.shelf = body.entries; state.revision++;
      state.puts.push({ entries: body.entries });
      return reply(res, 200, { entries: state.shelf, revision: state.revision });
    }
    // The list and the mentions are never answered: the reader keeps what it has saved, and the first load of an empty reader stays pending.
    if (req.method === "GET" && /\/api\/(reading|mentions)(\?|$)/.test(req.url ?? "")) { hung.push(res); return; }
    if (req.method === "GET" && path === "/api/subscriptions/poll") return reply(res, 200, { polling: 0 });
    if (req.method === "GET" && path.startsWith("/api/")) return reply(res, 200, { items: [], page: { limit: 50, nextCursor: null } });
    return reply(res, 404, { code: "not-found", message: "not found" });
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;
data.features = { daily: true, shelf: true }; // experimental features are off in the release flavour this harness loads

await runScenario({ data }, async (s) => {
  const { check } = s;
  const page = s.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  const eventually = async (fn, ms = 15000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await wait(200); v = await fn(); } return v; };
  const freeSockets = () => hung.splice(0).forEach((r) => r.socket?.destroy());
  const dropToasts = () => page.evaluate(() => { for (const n of activeDocument.querySelectorAll(".notice")) n.remove(); });
  await page.evaluate((t) => window.app.secretStorage.setSecret("smoke-studio", t), WITH_MANAGE);
  for (let i = 0; i < 40; i++) { if ((await page.evaluate(() => window.app.secretStorage.getSecret("smoke-studio"))) === WITH_MANAGE) break; await wait(100); }

  // ---- 4. the feed opened for the first time (no saved list, the Studio does not answer yet): "Loading…", never "nothing to show"
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
  const seen = [];
  for (let i = 0; i < 30; i++) {
    seen.push(await page.evaluate(() => ({ note: document.querySelector(".blyg-reader-column .blyg-reader-note")?.textContent ?? null, all: document.querySelector(".view-content.blyg-reader")?.innerText ?? "" })));
    await wait(100);
  }
  check(seen.every((x) => !/nothing to show/i.test(x.all)), `the feed never says "nothing to show" while its first list is pending (${JSON.stringify([...new Set(seen.map((x) => x.note))])})`);
  check(seen.some((x) => x.note === "Loading…"), "the feed says Loading… while its first list is pending");
  freeSockets();
  await wait(1000);
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-reader"));
  freeSockets();

  // ---- the saved list the Daily starts from: four stories (a post and a reply) and two single posts, all unread
  const id = (c, i) => `${c}${String(i).padStart(25, "0")}`.slice(0, 26);
  const mk = (i, text, who, over = {}) => ({
    subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: id("p", i), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
    observedAt: new Date(Date.now() - (i + 1) * 600e3).toISOString(), created: null, isReply: false, stubTarget: null, authorName: who, authorUrl: null, sourceUrl: null,
    contentHtml: `<p>${text}</p>`, contentMd: "", ...over,
  });
  const posts = [];
  ["harbour tide lantern", "orchard cider press", "glacier survey drone", "market ledger tariff"].forEach((t, k) => {
    const a = mk(k * 2, `Alpha ${t} story body number ${k} for the day.`, `Lead${k}`);
    posts.push(a, mk(k * 2 + 1, `Reply on ${t} story body ${k}.`, `Rep${k}`, { isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId } }));
  });
  posts.push(mk(20, "Mushrooms grow quietly under old oak trees. https://example.com/" + "a".repeat(120), "Cy"), mk(21, "Trains were delayed again today. And more.", "Di"));
  await page.evaluate((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/reader-cache.json", json), JSON.stringify({ v: 1, origin: `${base}/`, savedAt: Date.now(), posts, mentions: [] }));
  const openDaily = async () => {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-daily"));
    await page.waitForSelector(".blyg-daily .blyg-story-mixed", { timeout: 30000 });
    await wait(2500);
  };
  const single = () => page.evaluate(() => { const r = document.querySelector(".blyg-daily .blyg-story-mixed"); return { read: !!r?.classList.contains("blyg-is-read"), label: r?.querySelector(".blyg-mark")?.getAttribute("aria-label") ?? "" }; });
  await openDaily();
  const before = await single();
  check(!before.read && before.label === "Mark read", `the Daily starts with an unread single post (${JSON.stringify(before)})`);

  // ---- 2. open the single post from the digest and watch its header over the first 1.5 s (a frame at a time)
  await page.evaluate(() => {
    window.__frames = [];
    const t0 = performance.now();
    const tick = () => {
      const row = document.querySelector(".blyg-reader-header .blyg-reader-bar-thumb");
      if (row) {
        const save = row.querySelector(".blyg-reader-savebtn");
        window.__frames.push({ t: Math.round(performance.now() - t0), kids: [...row.children].map((c) => `${c.tagName}.${(c.className || "").replace(/\s*is-\w+/g, "").trim()}`).join(" "), save: save ? Math.round(save.getBoundingClientRect().left) : null, reply: Math.round(row.querySelector(".blyg-reader-replybtn")?.getBoundingClientRect().left ?? -1) });
      }
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const where = await page.evaluate(() => { const out = []; for (let n = document.querySelector(".blyg-daily .blyg-story-mixed .blyg-story-main"); n && n !== document.body && out.length < 9; n = n.parentElement) { const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); out.push(`${n.tagName}.${String(n.className).slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)} ${cs.display} ${cs.visibility}`); } return out; });
  console.error("diagnostic: first single post and its parents:", JSON.stringify(where), "viewport", JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight])));
  await page.click(".blyg-daily .blyg-story-mixed .blyg-story-main", { timeout: 5000 }).catch((e) => { check(false, `the first single post could not be clicked: ${JSON.stringify(where)}`); throw e; });
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  await wait(1800);
  const frames = await page.evaluate(() => window.__frames);
  const kidSets = [...new Set(frames.map((f) => f.kids))];
  const saves = frames.map((f) => f.save);
  check(frames.length >= 5 && kidSets.length === 1, `the header row has the same children in every frame of the first 1.5 s (${frames.length} frames, ${kidSets.length} different: ${JSON.stringify(kidSets)})`);
  check(saves.every((x) => x !== null) && Math.max(...saves) - Math.min(...saves) <= 1 && new Set(frames.map((f) => f.reply)).size === 1, `Save and Reply do not move while the header settles (Save at ${[...new Set(saves)]}, Reply at ${[...new Set(frames.map((f) => f.reply))]})`);
  check(/^Digest \d+ of \d+$/.test(await page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-stepcount")?.textContent ?? "")), "the counter (its place in the digest, opened from it) is there from the first frame");

  // ---- 1. mark it read in the open post: one PUT to the Studio, shown in the header, in the digest after Back, and in the post when it is opened again
  const m0 = marks.length;
  await page.click(".blyg-reader-header .blyg-reader-check");
  check(await eventually(() => marks.length === m0 + 1), `marking a post read in the open post (opened from the digest) wrote one request to the Studio (${marks.length - m0})`);
  check(await page.evaluate(() => !!document.querySelector(".blyg-reader-header .blyg-reader-check.is-read")), "the open post's read mark shows at once");
  await wait(1500);
  check(marks.length === m0 + 1, "and nothing is written again by itself");
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-story-mixed", { state: "attached", timeout: 20000 });
  await wait(1500);
  const after = await single();
  check(after.read && after.label === "Mark unread", `back in the digest the post shows as read (${JSON.stringify(after)})`);
  await page.click(".blyg-daily .blyg-story-mixed .blyg-story-main");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  await wait(800);
  check(await page.evaluate(() => !!document.querySelector(".blyg-reader-header .blyg-reader-check.is-read")), "opened again, the post is still read");
  check(marks.length === m0 + 1, `nothing was written for the reopen (${marks.length - m0})`);
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-story-mixed", { state: "attached", timeout: 20000 });
  await wait(800);

  // a story: both of its posts marked read in the open post (Next walks the story) make the story read in the digest
  await page.click(".blyg-daily .blyg-story-headline");
  await wait(400);
  const s0 = marks.length;
  await page.click(".blyg-daily .blyg-daily-member .blyg-daily-preview");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-check", { timeout: 20000 });
  await wait(500);
  await page.click(".blyg-reader-header .blyg-reader-check");
  await eventually(() => marks.length === s0 + 1);
  await page.click(".blyg-reader-header .blyg-reader-step-next");
  await wait(800);
  await page.click(".blyg-reader-header .blyg-reader-check");
  check(await eventually(() => marks.length === s0 + 2), `both posts of a story marked in the open post: one request each (${marks.length - s0})`);
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-story", { state: "attached", timeout: 20000 });
  await wait(1500);
  const story = await page.evaluate(() => ({ label: document.querySelector(".blyg-daily .blyg-story .blyg-mark")?.getAttribute("aria-label"), dim: document.querySelectorAll(".blyg-daily .blyg-story.blyg-is-read").length }));
  check(story.label === "Mark story unread" && story.dim >= 1, `back in the digest the story shows as read (${JSON.stringify(story)})`);
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-daily"));
  await openDaily();
  const again = await single();
  check(again.read, `a Daily opened afresh still shows the post as read (${JSON.stringify(again)})`);
  check(marks.length === s0 + 2 && unmarks.length === 0, "the Studio saw exactly the marks made in the open posts, no more");

  // ---- 3. Save, with the connection lost mid-request: the button returns to Save with one line; the next tap saves
  await page.click(".blyg-daily .blyg-story-mixed .blyg-story-main");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  await wait(800);
  const saveText = () => page.evaluate(() => ({ text: document.querySelector(".blyg-reader-header .blyg-reader-savebtn")?.textContent?.trim() ?? "", disabled: !!document.querySelector(".blyg-reader-header .blyg-reader-savebtn")?.disabled }));
  const statusText = () => page.evaluate(() => document.querySelector(".blyg-reader-status")?.textContent ?? "");
  check((await saveText()).text === "Save", `the open post offers Save (${JSON.stringify(await saveText())})`);
  await dropToasts();
  state.dropPut = true;
  await page.click(".blyg-reader-header .blyg-reader-savebtn");
  check(await eventually(async () => /Could not save, no connection\. Tap Save to try again\./.test(await statusText())), `a save that loses its connection says so in one line (${JSON.stringify(await statusText())})`);
  const failed = await saveText();
  check(failed.text === "Save" && !failed.disabled && state.shelf.length === 0, `and Save is back, not disabled, nothing shown as saved (${JSON.stringify(failed)})`);
  state.dropPut = false;
  await page.click(".blyg-reader-header .blyg-reader-savebtn");
  check(await eventually(async () => (await saveText()).text === "Saved"), `tapping Save again saves it (${JSON.stringify(await saveText())}, ${state.shelf.length} on the shelf)`);
  check(state.shelf.length === 1 && [id("p", 20), id("p", 21)].includes(state.shelf[0].remoteId), "the Studio's shelf holds exactly that one post");
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
});
