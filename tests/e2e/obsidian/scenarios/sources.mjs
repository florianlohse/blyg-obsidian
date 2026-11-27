// "Sources" (the blygs the Studio follows) in real Obsidian: a small muted "Sources" link in the feed header that moves nothing, the list shown at once from what
// was kept with ONE silent read per opening (a counting stand-in Studio that answers slowly, then not at all), the field's "Follow" button, a small muted
// "Rename in the Studio" link per row, and the one-line "Not followed" row under a post of a blyg that is not followed, at 393, 360 and 320 px wide, light and dark.
// Chromium emulation of Obsidian's mobile UI, not iOS.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/sources.mjs
import http from "node:http";
import { STUDIO, fixtureData, runScenario, wait } from "../lib.mjs";

let mode = "slow"; // how the stand-in answers GET /subscriptions: "slow" (after a delay), "fail" (503)
const asked = []; // every GET /subscriptions, with its time
let answered = 0;
const live = (title) => [
  { id: "s1", kind: "blyg", origin: "https://one.example.com/", feedUrl: "https://one.example.com/feed.xml", title, status: "active", lastPollAt: new Date(Date.now() - 120e3).toISOString(), failCount: 0, titleFollowsSource: true, hopperFeedUrl: null },
  { id: "s2", kind: "blyg", origin: "https://two.example.com/", feedUrl: "https://two.example.com/feed.xml", title: "Second blyg", status: "paused", lastPollAt: null, failCount: 0, titleFollowsSource: false, hopperFeedUrl: null },
];
const hung = [];
const stub = http.createServer((req, res) => {
  if (req.method === "GET" && /\/api\/subscriptions(\?|$)/.test(req.url ?? "")) {
    asked.push(Date.now());
    req.resume();
    if (mode === "fail") { res.writeHead(503, { "content-type": "application/json" }); return res.end("{}"); }
    return void setTimeout(() => { answered++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ items: live("Fresh title"), page: { nextCursor: null } })); }, 2500);
  }
  if (req.method === "GET" && /\/api\/(reading|mentions)(\?|$)/.test(req.url ?? "")) { req.resume(); hung.push(res); return; } // never answered: the saved list stays
  const up = http.request(`${STUDIO}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(STUDIO).host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); });
  req.pipe(up);
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;
data.features = { daily: true };

await runScenario({ data }, async (s) => {
  const { check } = s;
  const page = s.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  const id = (c, i) => `${c}${String(i).padStart(25, "0")}`.slice(0, 26);
  const posts = [0, 1, 2].map((i) => ({ subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: id("p", i), kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: new Date(Date.now() - (i + 1) * 600e3).toISOString(), created: null, isReply: false, stubTarget: null, authorName: `Au${i}`, authorUrl: null, sourceUrl: null, contentHtml: `<p>Harbour tide lantern number ${i}.</p>`, contentMd: "" }));
  const dir = ".obsidian/plugins/blyg";
  const keptRows = [live("Kept title")[0], live("x")[1]].map((r) => ({ ...r }));
  const write = (name, obj) => page.evaluate(([p, json]) => window.app.vault.adapter.write(p, json), [`${dir}/${name}`, JSON.stringify(obj)]);
  const seed = async () => {
    await write("reader-cache.json", { v: 1, origin: `${base}/`, savedAt: Date.now(), posts, mentions: [] });
    await write("followed-cache.json", { v: 1, origin: `${base}/`, savedAt: Date.now() - 5 * 60e3, complete: true, subscriptions: keptRows });
  };
  const reopenReader = async () => {
    await page.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-reader"));
    await wait(400);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await page.waitForSelector(".blyg-reader-header .blyg-modeswitch", { timeout: 30000 });
    await page.waitForSelector(".blyg-reader-card", { timeout: 30000 });
    await wait(800);
  };
  const box = (sel) => page.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; }, sel);
  const theme = (t) => page.evaluate(async (t) => { document.body.classList.toggle("theme-dark", t === "dark"); document.body.classList.toggle("theme-light", t !== "dark"); await new Promise((r) => setTimeout(r, 300)); }, t);
  const modalText = (q) => page.evaluate((sel) => [...activeDocument.querySelectorAll(`.modal-container ${sel}`)].map((e) => e.textContent ?? ""), q);
  /** The menu's "Sources" row, as a person gets to it: unfold the menu, tap the row (it folds the menu again and opens the list). */
  const openSources = () => page.evaluate(() => { const m = document.querySelector(".blyg-reader-header .blyg-reader-menubtn"); if (m.getAttribute("aria-expanded") !== "true") m.click(); document.querySelector(".blyg-reader-sources").click(); });
  const closeModal = async () => { await page.keyboard.press("Escape"); await wait(600); };

  await seed();
  await page.evaluate(() => window.app.workspace.requestSaveLayout());
  await wait(1500);
  await page.evaluate(() => window.app.commands.executeCommandById("app:reload")).catch(() => {});
  await wait(2500);
  await page.waitForFunction(() => window.app?.workspace?.layoutReady && window.app.plugins.plugins.blyg, undefined, { timeout: 90000 });
  await seed();

  // Where the kept list is read: never when the feed opens, only when the Sources screen opens (a read of it also looks the Studio's token up).
  const countReads = () => page.evaluate(() => {
    window.__followedReads = 0;
    const a = window.app.vault.adapter;
    if (!a.__counted) { const read = a.read.bind(a); a.read = (p, ...r) => { if (String(p).endsWith("followed-cache.json")) window.__followedReads++; return read(p, ...r); }; a.__counted = true; }
  })
  const pass = async (label) => {
    await countReads();
    await page.evaluate(() => { window.__followedReads = 0; });
    await reopenReader();
    await wait(2500);
    check((await page.evaluate(() => window.__followedReads)) === 0, `${label}: opening the feed does not read the kept Sources list (nor look up the token for it)`);
    // ---- the header (DG19): "Sources" is a row of the hamburger menu at the right end of the first row (after the Feed | Digest toggle); unfolding the menu moves neither the toggle nor the first row
    const slot0 = await box(".blyg-reader-header .blyg-modeslot");
    const bar0 = await box(".blyg-reader-header .blyg-reader-bar");
    const hamburger = await page.evaluate(() => { const m = document.querySelector(".blyg-reader-header .blyg-reader-menubtn"); const t = document.querySelector(".blyg-reader-header .blyg-modeslot"); const row = document.querySelector(".blyg-reader-header .blyg-reader-bar"); if (!m || !t || !row) return null; const mr = m.getBoundingClientRect(); const tr = t.getBoundingClientRect(); const rr = row.getBoundingClientRect(); return { tag: m.tagName, label: m.getAttribute("aria-label"), expanded: m.getAttribute("aria-expanded"), beforeToggle: mr.right <= tr.left + 0.5, refreshBetween: (() => { const f = row.querySelector(".blyg-reader-refresh")?.getBoundingClientRect(); return !!f && f.left >= mr.right - 0.5 && f.right <= tr.left + 0.5; })(), toggleLast: t === row.lastElementChild && Math.abs(tr.right - rr.right) <= 12, w: Math.round(mr.width), h: Math.round(mr.height), icon: !!m.querySelector("svg") }; });
    const inStatusRow = await page.evaluate(() => !!document.querySelector(".blyg-reader-statusrow .blyg-reader-sources"));
    await page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-menubtn").click());
    await wait(300);
    const link = await page.evaluate(() => { const l = document.querySelector(".blyg-reader-header .blyg-reader-sources"); if (!l) return null; const r = l.getBoundingClientRect(); return { tag: l.tagName, label: l.querySelector(".blyg-menurow-label")?.textContent, opens: l.querySelector(".blyg-menurow-go")?.textContent, inMenu: !!l.closest(".blyg-reader-menu"), h: r.height, tab: l.tabIndex }; });
    const slot = await box(".blyg-reader-header .blyg-modeslot");
    const bar = await box(".blyg-reader-header .blyg-reader-bar");
    const fit = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-reader"); const l = document.querySelector(".blyg-reader-sources").getBoundingClientRect(); return { sw: v.scrollWidth <= v.clientWidth, inside: l.right <= window.innerWidth + 0.5 && l.left >= 0 }; });
    check(hamburger && hamburger.tag === "BUTTON" && hamburger.label === "Menu" && hamburger.icon && hamburger.beforeToggle && hamburger.refreshBetween && hamburger.toggleLast && hamburger.h >= 44 && hamburger.w >= 44, `${label}: the hamburger is a labelled 44 px button in the first row, then Refresh, then the Feed | Digest toggle at the row's right edge (${JSON.stringify(hamburger)})`);
    check(link && link.tag === "BUTTON" && link.label === "Sources" && link.opens === "›" && link.inMenu && link.tab !== -1 && !inStatusRow, `${label}: the menu has a "Sources" row that is a real button, with the › of a row that opens something, and the link is no longer in the status row (${JSON.stringify(link)})`);
    check(slot && slot0 && Math.abs(slot.l - slot0.l) <= 0.5 && Math.abs(slot.t - slot0.t) <= 0.5 && Math.abs(slot.r - slot0.r) <= 0.5 && bar && bar0 && Math.abs(bar.h - bar0.h) <= 0.5, `${label}: unfolding the menu moves neither the Feed | Digest toggle nor the first row (toggle ${JSON.stringify(slot)} vs ${JSON.stringify(slot0)})`);
    check(fit.sw && fit.inside, `${label}: the row is inside the screen and nothing scrolls sideways (${JSON.stringify(fit)})`);
    await page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-menubtn").click());
    await wait(200);

    // ---- the screen: the kept list at once, one silent read per opening
    const before = asked.length;
    const ans0 = answered;
    await openSources();
    await page.waitForSelector(".modal-container .blyg-follow-row", { timeout: 10000 });
    const early = await page.evaluate(() => ({ names: [...activeDocument.querySelectorAll(".modal-container .blyg-follow-name")].map((e) => e.textContent), fresh: activeDocument.querySelector(".modal-container .blyg-follow-fresh")?.textContent ?? "" }));
    const reads = await page.evaluate(() => window.__followedReads);
    check(reads === 1, `${label}: opening the Sources screen reads the kept list once (${reads})`);
    check(early.names[0] === "Kept title" && early.names.length === 2 && answered === ans0, `${label}: the list is there at once from what was kept, before the Studio has answered (${JSON.stringify(early.names)}, answered ${answered - ans0})`);
    check(/^updated 5 min ago/.test(early.fresh), `${label}: a small muted line says how old it is (${JSON.stringify(early.fresh)})`);
    await page.evaluate(() => { activeDocument.querySelector(".modal-container .modal-content").scrollTop = 0; });
    await wait(3500);
    const late = await page.evaluate(() => ({ names: [...activeDocument.querySelectorAll(".modal-container .blyg-follow-name")].map((e) => e.textContent), fresh: activeDocument.querySelector(".modal-container .blyg-follow-fresh")?.textContent ?? "" }));
    check(late.names[0] === "Fresh title" && /^updated (just now|\d+ min ago)$/.test(late.fresh) && asked.length === before + 1, `${label}: the one silent read replaced the list (${JSON.stringify(late)}; ${asked.length - before} request)`);
    await wait(1500);
    check(asked.length === before + 1, `${label}: no further request while it stays open (${asked.length - before})`);

    // ---- the field and the rows
    const look = await page.evaluate(() => {
      const d = activeDocument;
      const m = d.querySelector(".modal-container");
      const btns = [...m.querySelectorAll(".setting-item button")];
      const input = m.querySelector(".setting-item input");
      const row = m.querySelector(".blyg-follow-row");
      const name = m.querySelector(".blyg-follow-name");
      const ren = [...m.querySelector(".blyg-follow-row").querySelectorAll(".blyg-linkbtn")];
      const stat = m.querySelector(".blyg-follow-status");
      const rr = row.getBoundingClientRect();
      const second = m.querySelectorAll(".blyg-follow-row")[1];
      return { btns: btns.map((b) => [b.textContent, b.classList.contains("mod-cta")]), placeholder: input?.getAttribute("placeholder"), nameW: +getComputedStyle(name).fontWeight, rename: ren.map((b) => [b.textContent, getComputedStyle(b).backgroundColor, getComputedStyle(b).borderTopWidth, parseFloat(getComputedStyle(b).fontSize), b.tagName]), statusFs: parseFloat(getComputedStyle(stat).fontSize), sep: second ? getComputedStyle(second).borderTopWidth : null, boxed: getComputedStyle(row).backgroundColor !== "rgba(0, 0, 0, 0)" || getComputedStyle(row).borderLeftWidth !== "0px", over: rr.right > innerWidth + 0.5 || ren.some((b) => b.getBoundingClientRect().right > innerWidth + 0.5), modalW: m.querySelector(".modal").scrollWidth <= m.querySelector(".modal").clientWidth + 1 };
    });
    check(look.btns[0]?.[0] === "Follow" && look.btns[0]?.[1] === false && !look.btns.some(([t]) => t === "Look up"), `${label}: the field's button says Follow, flat (not the accent fill) (${JSON.stringify(look.btns)})`);
    check(/address/i.test(look.placeholder ?? "") && /https/.test(look.placeholder ?? ""), `${label}: the placeholder says what to enter (${JSON.stringify(look.placeholder)})`);
    check(look.nameW <= 400 && look.rename.length === 2 && look.rename[0][0] === "Rename in the Studio" && look.rename[1][0] === "Unfollow" && look.rename.every(([, bg, bw, fs]) => bg === "rgba(0, 0, 0, 0)" && bw === "0px" && fs <= look.statusFs + 0.5), `${label}: rows: normal-weight title, Rename in the Studio and Unfollow as small flat text actions (${JSON.stringify(look)})`);
    check(look.sep === "1px" && !look.boxed && !look.over && look.modalW, `${label}: a thin separator between rows, no boxes, nothing wider than the screen (${JSON.stringify({ sep: look.sep, boxed: look.boxed, over: look.over, modalW: look.modalW })})`);
    // Unfollow is still asked about first
    await page.evaluate(() => activeDocument.querySelector(".modal-container .blyg-follow-unfollow").click());
    await wait(400);
    const q = await page.evaluate(() => activeDocument.querySelector(".modal-container .modal-content")?.textContent ?? "");
    check(/Unfollow Fresh title\?/.test(q) && /deletes the posts it imported/.test(q), `${label}: Unfollow still asks first and says what the Studio deletes`);
    await page.evaluate(() => [...activeDocument.querySelectorAll(".modal-container button")].find((b) => b.textContent === "Keep following")?.click());
    await wait(400);
    // Rename opens the rename view (the capability is kept)
    await page.evaluate(() => activeDocument.querySelector(".modal-container .blyg-follow-row .blyg-linkbtn").click());
    await wait(400);
    check((await modalText(".setting-item-name")).includes("Name"), `${label}: Rename in the Studio still opens the rename view`);
    await page.evaluate(() => [...activeDocument.querySelectorAll(".modal-container button")].find((b) => b.textContent === "Cancel")?.click());
    await wait(400);
    check(asked.length === before + 1, `${label}: going to Rename and back asked nothing more (${asked.length - before})`);
    await closeModal();
    await wait(3000);
    check(asked.length === before + 1, `${label}: nothing is asked while the screen is closed (${asked.length - before})`);

    // ---- a second opening: one more request; it fails, and the kept list stays with a quiet line
    mode = "fail";
    await openSources();
    await page.waitForSelector(".modal-container .blyg-follow-row", { timeout: 10000 });
    await wait(1500);
    const failed = await page.evaluate(() => ({ names: [...activeDocument.querySelectorAll(".modal-container .blyg-follow-name")].map((e) => e.textContent), fresh: activeDocument.querySelector(".modal-container .blyg-follow-fresh")?.textContent ?? "" }));
    check(asked.length === before + 2 && failed.names[0] === "Fresh title" && /^could not update/.test(failed.fresh), `${label}: a failed read keeps the list and says "could not update", with no retry (${JSON.stringify(failed)}; ${asked.length - before} requests)`);
    await closeModal();
    await wait(2000);
    check(asked.length === before + 2, `${label}: no retry loop after the failure (${asked.length - before})`);
    mode = "slow";

    // ---- the row under a post of a blyg that is not followed: one line high, and it leaves the post where it was
    await page.evaluate(() => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.mentions = [{ id: "m1", targetItemId: "t1", relation: "stub", status: "verified", hidden: false, sourceOrigin: "https://far.example", sourceId: "z1", sourcePage: null, sourceAuthorName: "Far Author", firstSeen: new Date().toISOString() }];
      view.host.mentionPost = async (m) => ({ subscriptionId: "", subscriptionTitle: "Far", origin: m.sourceOrigin, remoteId: m.sourceId, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: m.firstSeen, created: m.firstSeen, isReply: true, contentHtml: "<p>Reply words here</p>", contentMd: "", authorName: m.sourceAuthorName, authorUrl: null, sourceUrl: null });
      view.host.ownExcerpt = async () => "my own words";
      view.tab = "mentions";
      view.draw();
    });
    await wait(600);
    await page.evaluate(() => document.querySelector(".blyg-reader-mention")?.click());
    await page.waitForSelector(".blyg-reader-header .blyg-reader-follownote", { timeout: 10000 });
    await wait(400);
    const note = await page.evaluate(() => {
      const n = document.querySelector(".blyg-reader-follownote");
      const cs = getComputedStyle(n);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      const link = n.querySelector("button");
      const lr = link.getBoundingClientRect();
      const r = n.getBoundingClientRect();
      const body = document.querySelector(".blyg-reader-body")?.getBoundingClientRect();
      const hdr = document.querySelector(".blyg-reader-header").getBoundingClientRect();
      return { text: n.textContent, h: r.height, lh, fs: parseFloat(cs.fontSize), bg: cs.backgroundColor, bl: cs.borderLeftWidth, linkText: link.textContent, linkLabel: link.getAttribute("aria-label"), linkBg: getComputedStyle(link).backgroundColor, linkInside: lr.right <= innerWidth + 0.5 && lr.left >= 0, noteInside: r.right <= innerWidth + 0.5, hdrH: hdr.height, bodyTop: body?.top ?? 0, hdrBottom: hdr.bottom, replyTitle: document.querySelector(".blyg-reader-replybtn")?.getAttribute("title") ?? "", sw: document.querySelector(".view-content.blyg-reader").scrollWidth <= document.querySelector(".view-content.blyg-reader").clientWidth };
    });
    check(/^Not followed · Reply sends a link without a quote/.test(note.text) && note.linkText === "Follow" && note.linkLabel === "Follow this blyg", `${label}: the row says "Not followed · Reply sends a link without a quote" with a small Follow link (${JSON.stringify(note.text)})`);
    check(note.h <= note.lh * 1.3 && note.bg === "rgba(0, 0, 0, 0)" && note.bl === "0px" && note.linkBg === "rgba(0, 0, 0, 0)", `${label}: it is one text line high (${note.h.toFixed(1)} px, line ${note.lh.toFixed(1)}), no box, no filled button`);
    check(note.linkInside && note.noteInside && note.sw, `${label}: the Follow link stays on screen and nothing scrolls sideways`);
    check(/^Reply with a link to this post, without a quote\. Follow this blyg to quote it\.$/.test(note.replyTitle), `${label}: the Reply button's tooltip is unchanged (${JSON.stringify(note.replyTitle)})`);
    check(note.bodyTop >= note.hdrBottom - 1, `${label}: the post text starts below the header (header ${note.hdrBottom.toFixed(0)}, text ${note.bodyTop.toFixed(0)})`);
  };

  await s.phone();
  const cdp = await page.context().newCDPSession(page);
  for (const [w, h] of [[393, 852], [360, 780], [320, 700]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1200);
    for (const t of ["light", "dark"]) {
      await theme(t);
      await seed();
      await pass(`phone ${w} px, ${t}`);
    }
  }
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
  hung.splice(0).forEach((r) => r.socket?.destroy());
  stub.close();
});
