// One Refresh, in real Obsidian: the feed's Refresh and the digest's Refresh are the same action. One tap asks the (stand-in, counted) Studio to fetch once and reads the
// list once, in both; nothing is requested without a tap; the digest takes the new posts into its edition WITHOUT redrawing the page (the page element and its scroll position
// stay, no "Reading your list…" blank page, one draw), marked new; "Write the digest" sends nothing and starts nothing without consent; the 60 s pause holds.
// DG18: with the automatic write OFF, Refresh sends nothing to the AI and says in one line that the new posts are grouped but not written; the menu holds one update action and the
// manual writes sit under "Advanced"; with the automatic write ON (and consent recorded), the same Refresh also tries the missing texts, by the automatic rules, with the same Studio requests.
// The stand-in answers the poll, the change counters and the list itself, so every request is counted by kind.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/daily-refresh.mjs
import http from "node:http";
import { STUDIO, TOKEN, fixtureData, runScenario, wait } from "../lib.mjs";

const live = { rows: [], subs: 0, counts: {}, writes: [] };   // writes: every non-GET request but the Refresh poll, kept across reset() (Cloudflare budget guard, docs/CLOUDFLARE-LOAD.md)
const bump = (k) => (live.counts[k] = (live.counts[k] ?? 0) + 1);
const json = (res, body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/^\/(api\/)?/, "/");
  if (req.method !== "GET" && req.method !== "HEAD" && !(req.method === "POST" && path === "/subscriptions/poll")) live.writes.push(`${req.method} ${path}`);
  if (req.method === "POST" && path === "/subscriptions/poll") { req.resume(); bump("poll"); return json(res, { polling: 1 }); }
  if (req.method === "GET" && path === "/changes") { bump("changes"); return json(res, { epoch: "e1", domains: { reading: live.rows.length, subscriptions: live.subs++ } }); }
  if (req.method === "GET" && path === "/reading/imported") { bump("list"); return json(res, { items: live.rows, page: { nextCursor: null } }); }
  if (req.method === "GET" && path === "/reading") { bump("own"); return json(res, { items: [], page: { nextCursor: null } }); }
  if (req.method === "GET" && path === "/mentions") { bump("mentions"); return json(res, { items: [], page: { nextCursor: null } }); }
  if (req.method === "GET" && /^\/(capabilities|manifest|\.well-known)/.test(path) || req.method === "GET" && path === "/") { /* the local Studio answers what it must (manifest, capabilities) */ }
  else bump(`other ${req.method} ${path}`);
  const up = http.request(`${STUDIO}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(STUDIO).host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); });
  req.pipe(up);
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;
data.features = { daily: true, "digest-ai": true };
data.digest = { useAi: true, endpoint: "https://llm.example.invalid", model: "test-model", keySecretName: "llm-key", dailyTokenCeiling: 2000000, autoWrite: false, time: "07:00" };

await runScenario({ data }, async (s) => {
  const { check } = s;
  const page = s.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  const llmRequests = [];
  page.on("request", (r) => { if (/llm\.example\.invalid/.test(r.url())) llmRequests.push(r.url()); });
  const id = (c, i) => `${c}${String(i).padStart(25, "0")}`.slice(0, 26);
  const mk = (i, text, who, over = {}) => ({
    subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: id("p", i), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
    observedAt: new Date(Date.now() - (i + 1) * 600e3).toISOString(), created: null, isReply: false, stubTarget: null, authorName: who, authorUrl: null, sourceUrl: null,
    contentHtml: `<p>${text}</p>`, contentMd: "", ...over,
  });
  const wire = (p) => ({ ...p, author: { name: p.authorName, url: null }, stubOf: p.stubTarget ? { origin: p.stubTarget.origin, id: p.stubTarget.id, version: 1 } : undefined, page: undefined });
  const posts = [];
  ["harbour tide lantern", "orchard cider press", "glacier survey drone", "market ledger tariff"].forEach((t, k) => {
    const a = mk(k * 2, `Alpha ${t} story body number ${k} for the day.`, `Lead${k}`);
    posts.push(a, mk(k * 2 + 1, `Reply on ${t} story body ${k}.`, `Rep${k}`, { isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId } }));
  });
  posts.push(mk(20, "Mushrooms grow quietly under old oak trees. https://example.com/" + "a".repeat(120), "Cy"));
  live.rows = posts.map(wire);
  await page.evaluate((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/reader-cache.json", json), JSON.stringify({ v: 1, origin: `${base}/`, savedAt: Date.now(), posts, mentions: [] }));
  await page.evaluate(([t]) => { window.app.secretStorage.setSecret("smoke-studio", t); window.app.secretStorage.setSecret("llm-key", "not-a-real-key"); }, [TOKEN]);
  await wait(800);
  const reset = () => { for (const k of Object.keys(live.counts)) delete live.counts[k]; };
  const snap = () => ({ ...live.counts });
  const pause = () => page.evaluate(() => { window.app.plugins.plugins.blyg.readerService.state.checkedAt = 0; }); // as a person waiting a minute would

  // ---- the feed's Refresh: one tap
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
  await page.waitForSelector(".blyg-reader-refresh", { timeout: 30000 });
  await wait(3500);
  reset();
  await wait(3000);
  check(Object.keys(snap()).length === 0, `the feed asks the Studio for nothing by itself (${JSON.stringify(snap())})`);
  await pause();
  await page.evaluate(() => document.querySelector(".blyg-reader-refresh")?.click());
  await page.waitForFunction(() => /checked (just now|\d+ min ago)$/.test(document.querySelector(".blyg-reader-status")?.textContent ?? ""), null, { timeout: 45000 }).catch(() => {});
  await wait(1500);
  const feedTap = snap();
  check(feedTap.poll === 1 && feedTap.list === 1, `one tap in the feed: one poll and one read of the list (${JSON.stringify(feedTap)})`);

  // ---- the digest's Refresh: the same requests
  await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-modebtn")].find((b) => b.textContent === "Digest").click());
  await page.waitForSelector(".blyg-daily .blyg-daily-refresh", { timeout: 30000 });
  await wait(2500);
  reset();
  await wait(3000);
  check(Object.keys(snap()).length === 0, `the digest asks the Studio for nothing by itself (${JSON.stringify(snap())})`);
  const icon = await page.evaluate(() => { const b = document.querySelector(".blyg-daily .blyg-daily-barrow .blyg-daily-refresh"); const e = document.querySelector(".blyg-daily .blyg-daily-panel .blyg-daily-refreshbtn"); const w = document.querySelector(".blyg-daily .blyg-daily-panel .blyg-story-write"); return { bar: !!b?.querySelector("svg"), label: b?.getAttribute("aria-label"), entry: e?.querySelector(".blyg-menurow-label")?.textContent, value: e?.querySelector(".blyg-menurow-value")?.textContent, hint: e?.getAttribute("title"), write: w?.getAttribute("title"), writeValue: w?.querySelector(".blyg-menurow-value")?.textContent }; });
  check(icon.bar && icon.label === "Refresh" && icon.entry === "Refresh" && icon.value === "may use tokens" && /^Fetches new posts from your blygs and groups them\. Writes the missing texts only if “Write the digest automatically” is on/.test(icon.hint ?? "") && /Writes headlines and summaries with your AI model, uses tokens/.test(icon.write ?? "") && icon.writeValue === "uses tokens", `the bar has a Refresh icon and the menu rows say in words what Refresh and Write cost: a short value at the right, the longer explanation in the title (${JSON.stringify(icon)})`);

  // DG18: one update action in the menu; "Write the digest" and "Re-sort sections" are under a labelled "Advanced" part (a row of the menu that unfolds the writes as rows)
  const menu = await page.evaluate(() => {
    const panel = document.querySelector(".blyg-daily .blyg-daily-panel");
    const adv = panel?.querySelector("details.blyg-daily-advanced");
    const rows = [...(panel?.querySelectorAll(".blyg-menurow") ?? [])];
    const outside = rows.filter((r) => !adv?.contains(r)).map((r) => r.querySelector(".blyg-menurow-label")?.textContent ?? "");
    return { label: adv?.querySelector("summary .blyg-menurow-label")?.textContent ?? null, opens: adv?.querySelector("summary .blyg-menurow-go")?.textContent ?? null, outside, inside: [...(adv?.querySelectorAll("button.blyg-menurow .blyg-menurow-label") ?? [])].map((b) => b.textContent), writeIn: !!adv?.querySelector(".blyg-story-write"), mainWrite: !!panel?.querySelector(":scope > .blyg-story-write") };
  });
  check(menu.label === "Advanced" && menu.opens === "›" && JSON.stringify(menu.outside) === JSON.stringify(["Refresh"]) && menu.writeIn && !menu.mainWrite && menu.inside.includes("Write the digest"), `the main menu has one update action (Refresh); "Write the digest" (and "Re-sort sections" once there are sections) are under "Advanced", a row with the › of a row that opens something (${JSON.stringify(menu)})`);

  // new posts arrive on the blyg: a reply that joins the first story, and an unrelated post
  live.rows = [...posts, mk(30, "Alpha harbour tide lantern story body number 0 follow up from the quay.", "Late", { isReply: true, stubTarget: { origin: "https://one.example.com/", id: posts[0].remoteId } }), mk(31, "Zebra crossing paint dries slowly on the new bridge deck.", "Zed")].map(wire);
  await pause();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 380, deviceScaleFactor: 1, mobile: false }); // a short screen: the page scrolls
  await wait(1200);
  const before = await page.evaluate(() => {
    const v = document.querySelector(".view-content.blyg-daily");
    window.__page = v;
    v.scrollTop = Math.min(120, v.scrollHeight - v.clientHeight);
    window.__draws = { bars: 0, reading: 0, empty: 0, status: [] };
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.(".blyg-daily-bar") || n.querySelector?.(".blyg-daily-bar")) window.__draws.bars++;
        if (/Reading your list/.test(n.textContent ?? "")) window.__draws.reading++;
      }
      const st = document.querySelector(".blyg-daily-markstatus")?.textContent;
      if (st && window.__draws.status.at(-1) !== st) window.__draws.status.push(st);
    }).observe(v, { childList: true, subtree: true, characterData: true });
    const vis = [...v.querySelectorAll(".blyg-story-headline, .blyg-story-line")].find((e) => e.getBoundingClientRect().top > v.getBoundingClientRect().top + 60);
    window.__anchor = vis ? { text: vis.textContent, y: vis.getBoundingClientRect().top } : null;
    return { top: v.scrollTop, text: v.innerText, anchor: window.__anchor };
  });
  reset();
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-refresh")?.click());
  await wait(300);
  const busy = await page.evaluate(() => ({ disabled: document.querySelector(".blyg-daily .blyg-daily-refresh")?.disabled, busy: document.querySelector(".blyg-daily .blyg-daily-refresh")?.classList.contains("is-busy"), aria: document.querySelector(".blyg-daily .blyg-daily-refresh")?.getAttribute("aria-busy"), status: document.querySelector(".blyg-daily-markstatus")?.textContent }));
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-refresh")?.click()); // a second tap while it runs does nothing
  check(busy.disabled && busy.busy && busy.aria === "true" && /Checking/.test(busy.status ?? ""), `while it runs the Refresh button is busy and the status says Checking (${JSON.stringify(busy)})`);
  await page.waitForFunction(() => /new post|Nothing new/.test(document.querySelector(".blyg-daily-markstatus")?.textContent ?? ""), null, { timeout: 45000 });
  await wait(1200);
  const digestTap = snap();
  const after = await page.evaluate(() => {
    const v = document.querySelector(".view-content.blyg-daily");
    const a = window.__anchor && [...v.querySelectorAll(".blyg-story-headline, .blyg-story-line")].find((e) => e.textContent === window.__anchor.text);
    return { same: v === window.__page, top: v.scrollTop, moved: a ? Math.abs(a.getBoundingClientRect().top - window.__anchor.y) : null, draws: window.__draws, status: document.querySelector(".blyg-daily-markstatus")?.textContent, tags: [...document.querySelectorAll(".blyg-story-newtag")].map((e) => e.textContent), updated: [...document.querySelectorAll(".blyg-story-updated")].map((e) => e.textContent), newRows: document.querySelectorAll(".blyg-is-new").length, busy: document.querySelector(".blyg-daily .blyg-daily-refresh")?.classList.contains("is-busy"), text: v.innerText };
  });
  // (the feed also reads the owner's own items for its replies chip, GET /items: feed-only, not a list read of the reading list)
  check(digestTap.poll === feedTap.poll && digestTap.list === feedTap.list && digestTap.mentions === feedTap.mentions && digestTap.own === feedTap.own && digestTap.changes === feedTap.changes, `one tap in the digest makes the same Studio requests as one tap in the feed (digest ${JSON.stringify(digestTap)}, feed ${JSON.stringify(feedTap)})`);
  check(before.top > 20 && after.same && after.moved !== null && after.moved <= 2, `the page element stays and what you were reading stays where it was on screen (same element ${after.same}; scrolled ${before.top} -> ${after.top}, the story on screen moved ${after.moved} px)`);
  check(after.draws.bars === 1 && after.draws.reading === 0, `the page is drawn once and never shows "Reading your list…" (${JSON.stringify(after.draws)})`);
  check(/2 new posts/.test(after.status ?? "") && after.tags.includes("new") && after.updated.some((t) => /\+1 new post/.test(t)) && after.newRows >= 1, `the new posts are marked: "+1 new post" on its story, a "new" tag on the post in the Mixed bag, "2 new posts" in the status (${JSON.stringify({ status: after.status, tags: after.tags, updated: after.updated, newRows: after.newRows })})`);
  check(!after.busy && llmRequests.length === 0, `the button is free again and Refresh made no AI request (${llmRequests.length})`);
  check(/grouped, texts not written \(automatic writing is off\)/.test(after.status ?? "") && (after.status ?? "").split("\n").length === 1, `with the automatic write off, one plain line says the new posts are grouped and their texts are not written (${after.status})`);
  // the same tap again inside the 60 s pause: the Studio is not asked to fetch again (one read of the list), "Nothing new"
  reset();
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-refresh")?.click());
  await page.waitForFunction(() => /Nothing new/.test(document.querySelector(".blyg-daily-markstatus")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
  await wait(800);
  const paused = snap();
  check(!paused.poll && paused.list === 1, `a second tap within the 60 s pause asks no blyg again, reads the list once, and says "Nothing new" (${JSON.stringify(paused)})`);
  // the list was kept for the next session: the feed shows the new posts too
  await wait(3600);
  const cache = await page.evaluate(async () => JSON.parse(await window.app.vault.adapter.read(".obsidian/plugins/blyg/reader-cache.json")).posts.length);
  check(cache === posts.length + 2, `the list read by the digest's Refresh is saved for the next session (${cache} posts)`);

  // ---- DG19, Menu 1: every row is a label at the left and a muted value right-aligned; all rows end on one right edge; a long value is cut with an ellipsis and never takes room from the label
  await page.evaluate(() => { document.querySelector(".blyg-daily .blyg-daily-menu").click(); document.querySelector(".view-content.blyg-daily").scrollTop = 0; });
  await wait(400);
  const menu1 = await page.evaluate(() => {
    const adv = document.querySelector(".blyg-daily-panel details.blyg-daily-advanced");
    const advWas = adv?.open ?? false;
    if (adv) adv.open = true;
    const rows = [...document.querySelectorAll(".blyg-daily-panel .blyg-menurow")];
    const R = (e) => e.getBoundingClientRect();
    const first = rows[0];
    const lab = first.querySelector(".blyg-menurow-label");
    const val = first.querySelector(".blyg-menurow-value");
    const keep = val.textContent;
    const labelW = R(lab).width;
    val.textContent = "an unreasonably long value that cannot fit on one line of the menu at all, ever, however narrow";
    const cut = val.scrollWidth > val.clientWidth && getComputedStyle(val).textOverflow === "ellipsis" && getComputedStyle(val).whiteSpace === "nowrap";
    const labelKept = Math.abs(R(lab).width - labelW) < 0.5 && R(first).height < 60;
    const valueRightWhenCut = R(val).right;
    val.textContent = keep;
    if (adv) adv.open = advWas;
    return {
      n: rows.length, labels: rows.every((r) => Math.abs(R(r.querySelector(".blyg-menurow-label")).left - R(r).left) <= 1),
      valueEdges: [...new Set(rows.map((r) => Math.round(R(r.querySelector(".blyg-menurow-value")).right * 2) / 2))], goEdges: [...new Set(rows.map((r) => Math.round(R(r.querySelector(".blyg-menurow-go")).right * 2) / 2))], rowEdges: [...new Set(rows.map((r) => Math.round(R(r).right * 2) / 2))],
      aligned: rows.every((r) => getComputedStyle(r.querySelector(".blyg-menurow-value")).textAlign === "right"), muted: rows.every((r) => getComputedStyle(r.querySelector(".blyg-menurow-value")).color !== getComputedStyle(r.querySelector(".blyg-menurow-label")).color),
      plain: rows.every((r) => getComputedStyle(r).backgroundColor === "rgba(0, 0, 0, 0)" && getComputedStyle(r).boxShadow === "none"), cut, labelKept, cutRight: valueRightWhenCut === R(val).right, inside: rows.every((r) => R(r).right <= window.innerWidth + 0.5),
    };
  });
  check(menu1.n >= 2 && menu1.labels && menu1.valueEdges.length === 1 && menu1.goEdges.length === 1 && menu1.rowEdges.length === 1 && menu1.goEdges[0] === menu1.rowEdges[0] && menu1.aligned && menu1.muted && menu1.plain && menu1.inside, `the digest menu's rows: labels at the left, values muted and right-aligned, all on one right edge, no box (${JSON.stringify(menu1)})`);
  check(menu1.cut && menu1.labelKept, `a long value is cut with an ellipsis and the label keeps its room (${JSON.stringify({ cut: menu1.cut, labelKept: menu1.labelKept })})`);
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-menu").click());

  // ---- "Write the digest" sends nothing without consent
  const writeText = await page.evaluate(() => document.querySelector(".blyg-daily .blyg-story-write .blyg-menurow-label")?.textContent ?? "");
  check(writeText === "Write the digest", `the menu has "Write the digest" (${writeText})`);
  reset();
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-story-write")?.click());
  await page.waitForFunction(() => !!activeDocument.querySelector(".modal-container .modal"), null, { timeout: 15000 }).catch(() => {});
  const modal = await page.evaluate(() => activeDocument.querySelector(".modal-container .modal")?.textContent ?? "");
  check(/AI model/.test(modal) && /Agree/.test(modal) && /Cancel/.test(modal), `"Write the digest" asks for consent first (${modal.slice(0, 80)})`);
  await page.evaluate(() => [...activeDocument.querySelectorAll(".modal-container .modal button")].find((b) => b.textContent === "Cancel")?.click());
  await wait(1500);
  const afterCancel = await page.evaluate(() => ({ modal: !!activeDocument.querySelector(".modal-container .modal"), busy: document.querySelector(".blyg-daily .blyg-story-write")?.getAttribute("aria-busy") }));
  check(!afterCancel.modal && afterCancel.busy !== "true" && llmRequests.length === 0 && !Object.keys(snap()).some((k) => /^other/.test(k)), `declining sends nothing and starts nothing (${llmRequests.length} AI requests, ${JSON.stringify(snap())})`);
  // ---- DG18: with the automatic write ON and consent recorded, the same Refresh also tries the missing texts, by the automatic rules (the provider here does not exist: the try fails, which is the proof it was made)
  await page.evaluate(async () => {
    const f = ".obsidian/plugins/blyg/digest-ai.json";
    const cur = (await window.app.vault.adapter.exists(f)) ? JSON.parse(await window.app.vault.adapter.read(f)) : { v: 1, entries: {}, trail: [], consent: null, tally: null, sections: {} };
    cur.consent = { host: "llm.example.invalid", model: "test-model", at: Date.now() };
    await window.app.vault.adapter.write(f, JSON.stringify(cur));
    window.app.plugins.plugins.blyg.settings.digest.autoWrite = true;
  });
  live.rows = [...live.rows, wire(mk(40, "Quince jelly sets best with the skins left in the pot.", "Quin"))];
  await pause();
  reset();
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-refresh")?.click());
  await page.waitForFunction(() => /automatic|Written by/i.test(document.querySelector(".blyg-daily-markstatus")?.textContent ?? ""), null, { timeout: 60000 }).catch(() => {});
  await wait(1500);
  const auto = await page.evaluate(() => ({ status: document.querySelector(".blyg-daily-markstatus")?.textContent ?? "", modal: !!activeDocument.querySelector(".modal-container .modal") }));
  const autoTap = snap();
  check(/1 new post/.test(auto.status) && /The automatic write did not work|Not written automatically|Written by/.test(auto.status) && !/automatic writing is off/.test(auto.status) && !auto.modal, `with the automatic write on, Refresh also tried the missing texts by the automatic rules, asked nothing, and did not say they are unwritten (${JSON.stringify(auto)})`);
  check(autoTap.poll === 1 && autoTap.list === 1 && !Object.keys(autoTap).some((k) => /^other/.test(k)), `the Refresh that writes made the same Studio requests as one without (${JSON.stringify(autoTap)})`);
  // Cloudflare budget guard: opening the reader, the digest, two Refresh taps and the pause caused no Studio write request at all (a read mark would be a PUT, a follow a POST); every poll above was the Refresh's one POST
  check(live.writes.length === 0, `opening the reader and the digest and tapping Refresh sent no write request to the Studio (${JSON.stringify(live.writes)})`);
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
});
