// The open post of the reader when it was opened from the Daily (fix batch FX1, four bugs seen on a phone), in real Obsidian against a stand-in Studio that records every write:
//  1. a read mark made in the open post (opened from the digest) reaches the Studio (one PUT), shows in the digest afterwards (the post and its story) and in a reopened post;
//  2. the header of the open post does not change while it settles: its children and the place of Save are the same in every frame of the first 1.5 s;
//  3. a save that loses its connection puts Save back with one line, and a second tap saves;
//  4. the feed opened for the first time shows a thin spinner (labelled "Loading…", still when motion is reduced) while its first list is on its way, never "nothing to show";
//  5. (DG19) the open post's header: Back and the counter on the first row, the counter never cut at 393, 360 and 320 px; the bookmark Save; icon-only Previous and Next; and the one saved mark
//     (a bookmark before the meta line) drawn the same in the open post, a digest post row and a feed card.
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
  let spin = null; // measured in the first frame that has the spinner (the Studio answers the other routes at once, so the spinner is there for a moment only)
  let still = null;
  for (let i = 0; i < 30; i++) {
    const x = await page.evaluate(() => ({ note: document.querySelector(".blyg-reader-column .blyg-reader-note")?.textContent ?? null, spinner: !!document.querySelector(".blyg-reader-column .blyg-reader-loading .blyg-reader-spinner"), label: document.querySelector(".blyg-reader-column .blyg-reader-loading")?.getAttribute("aria-label") ?? null, all: document.querySelector(".view-content.blyg-reader")?.innerText ?? "" }));
    seen.push(x);
    if (x.spinner && spin === null) {
      spin = await page.evaluate(() => { const sp = document.querySelector(".blyg-reader-column .blyg-reader-loading .blyg-reader-spinner"); const h = document.querySelector(".blyg-reader-header"); const v = document.querySelector(".view-content.blyg-reader"); if (!sp || !h || !v) return null; const r = sp.getBoundingClientRect(); const vr = v.getBoundingClientRect(); return { size: Math.round(r.width), underHeader: r.top >= h.getBoundingClientRect().bottom, centred: Math.abs(r.left + r.width / 2 - (vr.left + vr.width / 2)) <= 2, anim: getComputedStyle(sp).animationName, role: document.querySelector(".blyg-reader-loading")?.getAttribute("role") }; });
      await s.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await wait(60);
      still = await page.evaluate(() => { const sp = document.createElement("span"); sp.className = "blyg-reader-spinner"; document.querySelector(".view-content.blyg-reader").appendChild(sp); const n = getComputedStyle(sp).animationName; sp.remove(); return n; }); // (a probe with the same class: the real one may be gone by now)
      await s.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    }
    await wait(100);
  }
  check(seen.every((x) => !/nothing to show/i.test(x.all)), `the feed never says "nothing to show" while its first list is pending (${JSON.stringify([...new Set(seen.map((x) => x.note))])})`);
  check(seen.some((x) => x.spinner && x.label === "Loading…" && x.note === null), `the feed shows a spinner, labelled for a screen reader, in place of a note while its first list is pending (${JSON.stringify([...new Set(seen.map((x) => `${x.spinner}/${x.label}`))])})`);
  check(spin && spin.size <= 28 && spin.underHeader && spin.centred && spin.anim !== "none" && spin.role === "status", `the spinner is thin, centred, under the header, and turning (${JSON.stringify(spin)})`);
  check(still === "none", `with reduced motion asked for, the spinner is the static ring (${still})`);
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
  check(/^Digest · \d+ of \d+$/.test(await page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-stepcount")?.textContent ?? "")), "the counter (its place in the digest, opened from it) is there from the first frame");

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
  const story = await page.evaluate(() => ({ label: document.querySelector(".blyg-daily .blyg-story .blyg-storymark")?.textContent, dim: document.querySelectorAll(".blyg-daily .blyg-story.blyg-is-read").length }));
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
  const saveText = () => page.evaluate(() => ({ text: document.querySelector(".blyg-reader-header .blyg-reader-savebtn")?.getAttribute("aria-label") ?? "", glyph: !!document.querySelector(".blyg-reader-header .blyg-reader-savebtn svg"), words: document.querySelector(".blyg-reader-header .blyg-reader-savebtn")?.textContent?.trim() ?? "", disabled: !!document.querySelector(".blyg-reader-header .blyg-reader-savebtn")?.disabled }));
  const statusText = () => page.evaluate(() => document.querySelector(".blyg-reader-status")?.textContent ?? "");
  check((await saveText()).text === "Save for later" && (await saveText()).glyph && (await saveText()).words === "", `the open post offers Save for later as a bookmark glyph with no word on it (${JSON.stringify(await saveText())})`);
  await dropToasts();
  state.dropPut = true;
  await page.click(".blyg-reader-header .blyg-reader-savebtn");
  check(await eventually(async () => /Could not save, no connection\. Tap Save to try again\./.test(await statusText())), `a save that loses its connection says so in one line (${JSON.stringify(await statusText())})`);
  const failed = await saveText();
  check(failed.text === "Save for later" && !failed.disabled && state.shelf.length === 0, `and Save is back, not disabled, nothing shown as saved (${JSON.stringify(failed)})`);
  state.dropPut = false;
  await page.click(".blyg-reader-header .blyg-reader-savebtn");
  check(await eventually(async () => (await saveText()).text === "Saved"), `tapping Save again saves it (${JSON.stringify(await saveText())}, ${state.shelf.length} on the shelf)`);
  check(state.shelf.length === 1 && [id("p", 20), id("p", 21)].includes(state.shelf[0].remoteId), "the Studio's shelf holds exactly that one post");

  // ---- 5. the open post's header, geometry at 393, 360 and 320 px: the phone layout (the page reloads), the Daily, the first single post (the one just saved)
  await s.phone();
  await openDaily();
  await page.click(".blyg-daily .blyg-story-mixed .blyg-story-main");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  await eventually(() => page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-savebtn")?.getAttribute("aria-label") === "Saved"));
  await wait(800);
  const bookmark = await page.evaluate(() => { const b = document.querySelector(".blyg-reader-header .blyg-reader-savebtn"); const r = b.getBoundingClientRect(); const sv = b.querySelector("svg"); return { w: Math.round(r.width), h: Math.round(r.height), saved: b.classList.contains("is-saved"), pressed: b.getAttribute("aria-pressed"), filled: getComputedStyle(sv).fill !== "none", colour: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor, border: getComputedStyle(b).borderTopWidth }; });
  check(bookmark.w >= 32 && bookmark.h >= 32 && bookmark.saved && bookmark.pressed === "true" && bookmark.filled && bookmark.bg === "rgba(0, 0, 0, 0)" && bookmark.border === "0px", `the saved bookmark is a quiet 32 px control, filled, with no grey box (${JSON.stringify(bookmark)})`);
  const headerLook = (w) => page.evaluate((w) => {
    const h = document.querySelector(".blyg-reader-header");
    const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
    const top = h.querySelector(".blyg-reader-bar-main");
    const thumb = h.querySelector(".blyg-reader-bar-thumb");
    const count = top.querySelector(".blyg-reader-stepcount");
    const num = count?.querySelector(".blyg-reader-stepnum");
    const title = count?.querySelector(".blyg-reader-steptitle");
    const meta = h.querySelector(".blyg-reader-postmeta");
    const kids = (e) => [...e.children].map((c) => (c.className || "").split(" ").filter((x) => !/^is-|^clickable/.test(x)).join("."));
    const hr = R(h);
    const accent = (() => { const e = document.createElement("span"); e.style.color = "var(--interactive-accent)"; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; })();
    const reply = thumb.querySelector(".blyg-reader-replybtn");
    const prev = thumb.querySelector(".blyg-reader-step-prev");
    const next = thumb.querySelector(".blyg-reader-step-next");
    return {
      w, vw: window.innerWidth, sw: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      topKids: kids(top), thumbKids: kids(thumb), counter: count?.textContent ?? null, italic: count ? getComputedStyle(count).fontStyle : null, muted: count ? getComputedStyle(count).color !== getComputedStyle(top.querySelector(".blyg-reader-back")).color : null,
      numWhole: !!num && num.scrollWidth <= num.clientWidth + 0.5 && R(num).r <= R(count).r + 0.5 && R(num).l >= R(count).l - 0.5, numbers: num?.textContent ?? null,
      counterRight: count ? Math.abs(R(count).r - (R(top).r)) <= 2 : false, counterInRow: count ? R(count).r <= window.innerWidth + 0.5 && R(count).l >= R(top.querySelector(".blyg-reader-back")).r - 0.5 : false,
      sameLineAsBack: count ? Math.abs((R(count).t + R(count).b) / 2 - (R(top.querySelector(".blyg-reader-back")).t + R(top.querySelector(".blyg-reader-back")).b) / 2) <= 6 : false,
      titleCut: title ? title.scrollWidth > title.clientWidth + 0.5 : null,
      metaBelowRow: R(meta).t >= R(top).b - 0.5 && meta.querySelector(".blyg-reader-postblyg") !== null && meta.querySelector(".blyg-reader-postrest") !== null,
      thumbBelowMeta: R(thumb).t >= R(meta).b - 0.5,
      save: R(thumb.querySelector(".blyg-reader-savebtn")), check: R(thumb.querySelector(".blyg-reader-check")), replyFilled: getComputedStyle(reply).backgroundColor === accent, replyR: R(reply).r, stepsR: R(thumb.querySelector(".blyg-reader-steps")).r,
      stepsIconOnly: [prev, next].every((b) => b && b.textContent.trim() === "" && !!b.querySelector("svg") && !!b.getAttribute("aria-label")), hr,
      inside: [...top.children, ...thumb.children].every((c) => R(c).r <= window.innerWidth + 0.5 && R(c).l >= -0.5),
    };
  }, w);
  for (const [w, hh] of [[393, 852], [360, 780], [320, 700]]) {
    await s.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: hh, deviceScaleFactor: 2, mobile: true });
    await wait(1200);
    const L = await headerLook(w);
    check(L.topKids[0]?.includes("blyg-reader-back") && L.topKids.length === 2 && L.topKids[1]?.includes("blyg-reader-stepcount") && L.sameLineAsBack && L.counterRight && L.counterInRow, `${w} px: the first row holds Back and the counter, the counter right-aligned on the same line (${JSON.stringify({ kids: L.topKids, same: L.sameLineAsBack, right: L.counterRight, inRow: L.counterInRow })})`);
    check(L.numWhole && /^ · \d+ of \d+$/.test(L.numbers ?? "") && /\d+ of \d+$/.test(L.counter ?? "") && L.italic === "italic" && L.muted, `${w} px: the counter is italic, muted and never truncated: its numbers are whole ("${L.counter}", name cut: ${L.titleCut})`);
    check(L.metaBelowRow && L.thumbBelowMeta, `${w} px: the source name and the small print are the second line, the thumb row the third`);
    check(JSON.stringify(L.thumbKids.map((k) => k.split(".")[0] === "blyg-reader-bar" ? k : k)) !== "[]" && L.thumbKids[0]?.includes("blyg-reader-check") && L.thumbKids[1]?.includes("blyg-reader-savebtn") && L.thumbKids[2]?.includes("blyg-reader-spacer") && L.thumbKids[3]?.includes("blyg-reader-replybtn") && L.thumbKids.at(-1)?.includes("blyg-reader-steps"), `${w} px: the third row is read mark, bookmark, space, Reply, then the steps (${JSON.stringify(L.thumbKids)})`);
    check(L.replyFilled && L.stepsIconOnly && L.save.w >= 32 && L.save.h >= 32 && L.inside && L.sw, `${w} px: Reply is filled, Previous and Next are icon-only buttons with a label, the bookmark is at least 32 px, and nothing is wider than the screen (${JSON.stringify({ filled: L.replyFilled, icons: L.stepsIconOnly, save: L.save, inside: L.inside, sw: L.sw })})`);
    check(Math.abs(L.save.l - (L.check.r)) <= 12 && L.save.l >= L.check.r - 0.5, `${w} px: the bookmark follows the read mark at the left (${Math.round(L.check.r)} then ${Math.round(L.save.l)})`);
  }
  await s.cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });

  // ---- 2. (DG19) one saved mark, drawn by one helper, in three places: the open post, a digest post row and a feed card
  const markSig = (sel) => page.evaluate((q) => {
    const m = document.querySelector(q);
    if (!m) return null;
    const sv = m.querySelector("svg");
    const r = sv.getBoundingClientRect();
    return { role: m.getAttribute("role"), label: m.getAttribute("aria-label"), words: m.textContent.trim(), size: `${Math.round(r.width)}x${Math.round(r.height)}`, colour: getComputedStyle(m).color, fill: getComputedStyle(sv).fill, svg: sv.innerHTML.length, first: m.parentElement.firstElementChild === m || m.parentElement.firstChild === m };
  }, sel);
  const inPost = await markSig(".blyg-reader-header .blyg-reader-postrest .blyg-savedmark");
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-story-mixed", { state: "attached", timeout: 20000 });
  await eventually(() => page.evaluate(() => !!document.querySelector(".blyg-daily .blyg-story-mixed .blyg-savedmark")));
  const inRow = await markSig(".blyg-daily .blyg-story-mixed .blyg-savedmark");
  await page.evaluate(() => [...document.querySelectorAll(".blyg-daily .blyg-modebtn")].find((b) => b.textContent === "Feed").click());
  await page.waitForSelector(".blyg-reader-card", { timeout: 30000 });
  await eventually(() => page.evaluate(() => !!document.querySelector(".blyg-reader-card .blyg-savedmark")));
  const inCard = await markSig(".blyg-reader-card .blyg-savedmark");
  check(inPost && inRow && inCard && inPost.words === "" && inPost.label === "Saved" && inPost.role === "img" && inPost.size === "11x11" && JSON.stringify(inPost) === JSON.stringify(inRow) && JSON.stringify(inRow) === JSON.stringify(inCard) && inPost.fill !== "none", `the saved mark is the same 11 px filled bookmark in the open post, a digest post row and a feed card (${JSON.stringify([inPost, inRow, inCard])})`);
  check(inCard?.first === true && inRow?.first === true && inPost?.first === true, "... and it comes first on its line (before the meta text) in all three");
  // the mark's colour against the page, in both themes (a graphic: 3 to 1)
  const markContrast = (theme) => page.evaluate(async (theme) => {
    document.body.classList.toggle("theme-dark", theme === "dark");
    document.body.classList.toggle("theme-light", theme !== "dark");
    await new Promise((r) => setTimeout(r, 300));
    const num = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lum = (c) => { const [r, g, b] = num(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(1); };
    const ground = getComputedStyle(document.querySelector(".view-content.blyg-reader")).backgroundColor;
    const solid = /rgba\(.*, 0\)$/.test(ground) || ground === "transparent" ? getComputedStyle(document.body).backgroundColor : ground;
    return ratio(getComputedStyle(document.querySelector(".blyg-reader-card .blyg-savedmark")).color, solid);
  }, theme);
  const mDark = await markContrast("dark");
  const mLight = await markContrast("light");
  check(mDark >= 3 && mLight >= 3, `the saved mark is visible in both themes (contrast ${mDark} dark, ${mLight} light)`);
  check(await page.evaluate(() => document.querySelectorAll(".blyg-reader-savedmark").length === 0 && ![...document.querySelectorAll(".blyg-reader-card .blyg-reader-badge")].some((b) => b.textContent === "saved")), "the word 'saved' is gone from the cards");
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
});
