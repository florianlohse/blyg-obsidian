// The Daily (digest) page opens in real Obsidian and is not blank: from a saved list, on first open, again after a restart (`app:reload`) with the edition record
// the first open left behind, and with sections, bylines and AI lines already in that record (the AI layer is off here, so they are read but not drawn). Reads the page's text, the errors on the page, and that nothing scrolls sideways.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/daily.mjs
import http from "node:http";
import { STUDIO, TOKEN, fixtureData, runScenario, wait } from "../lib.mjs";

// A stand-in Studio: everything is refused (503) except a read mark, which is counted with its time (the digest's "Mark read" must be one request per unread post, spaced out, and none by itself).
const marks = [];
const unmarks = []; // DELETE .../read: the digest's read symbol put back
const histories = []; // GET .../history: the change notes of a revised post, asked lazily
const hung = []; // list requests left unanswered: they hold the app's few connections to this host open until they are closed
const others = []; // every other request that reaches the stand-in Studio, with its path
const stub = http.createServer((req, res) => {
  if (req.method === "PUT" && /\/reading\/[^/]+\/[^/]+\/read$/.test(req.url ?? "")) {
    marks.push({ at: Date.now(), path: req.url });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ readVersion: 1 }));
  }
  if (req.method === "DELETE" && /\/reading\/[^/]+\/[^/]+\/read$/.test(req.url ?? "")) {
    unmarks.push({ at: Date.now(), path: req.url });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ readVersion: null }));
  }
  if (req.method === "GET" && /\/imports\/[^/]+\/[^/]+\/history$/.test(req.url ?? "")) {
    histories.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ current: 2, withdrawn: false, changelog: [{ version: 2, at: "2030-01-01T00:00:00Z", note: "Fixed the <b>March</b> total", pinned: false, generated: false }] }));
  }
  others.push(`${req.method} ${req.url}`);
  // The list and the mentions are never answered, so the reader keeps the saved list and the feed has the posts below.
  if (req.method === "GET" && /\/api\/(reading|mentions)(\?|$)/.test(req.url ?? "")) {
    req.resume();
    hung.push(res);
    return;
  } // (no answer: the saved list stays on screen)
  // Anything else goes to the local Studio (its manifest and capabilities, which the client reads before any write); the saved list in this scenario is fixed, so nothing it answers is shown.
  const up = http.request(`${STUDIO}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(STUDIO).host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); });
  req.pipe(up);
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;
data.features = { daily: true }; // an experimental feature is off in the release flavour this harness loads

await runScenario({ data }, async (s) => {
  const { check } = s;
  const page = s.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
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
  posts.push(mk(20, "Mushrooms grow quietly under old oak trees. https://example.com/" + "a".repeat(120), "Cy"), mk(21, "Trains were delayed again today. And more.", "Di", { version: 2 }));
  await page.evaluate((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/reader-cache.json", json), JSON.stringify({ v: 1, origin: `${base}/`, savedAt: Date.now(), posts, mentions: [] }));

  const open = async () => {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-daily"));
    await page.waitForSelector(".blyg-daily", { state: "attached", timeout: 30000 });
    await wait(2500);
    return page.evaluate(() => {
      const v = document.querySelector(".view-content.blyg-daily");
      return { text: v?.innerText ?? "", h: v?.getBoundingClientRect().height ?? 0, sw: v?.scrollWidth ?? 0, cw: v?.clientWidth ?? 0, rows: document.querySelectorAll(".blyg-daily-section").length };
    });
  };
  const first = await open();
  check(/your digest/i.test(first.text) && first.rows > 0, `the digest page has content on first open (${JSON.stringify(first.text.slice(0, 80))})`);
  check(first.sw <= first.cw, `it does not scroll sideways (${first.sw} of ${first.cw})`);

  // a restart with the edition record the first open saved, plus sections and lines in it
  // (the edition record lives in this device's own file of the synced folder since DG16: the sections, bylines and lines are registers of that file)
  const dir = ".obsidian/plugins/blyg/digest";
  // DG21: a first-ever open waits up to 8 s for another device's edition before it makes its own
  const found = await s.pollUntil("this device's edition file", () => page.evaluate(async (d) => (await window.app.vault.adapter.list(d).catch(() => ({ files: [] }))).files.find((f) => /\/ed-\d+\./.test(f)) ?? "", dir), (f) => f !== "", 30000);
  const file = found.value;
  check(file !== "", `the first open left this device's edition file in ${dir} (${file})`);
  const rec = JSON.parse(await page.evaluate((f) => window.app.vault.adapter.read(f), file));
  const reg = (v) => ({ c: rec.clock + 1, d: rec.device, v });
  Object.keys(rec.regs).filter((k) => k.startsWith("story/")).map((k) => k.slice(6)).forEach((sid, i) => (rec.regs[`sec/${sid}`] = reg(i % 2 ? "Town" : "Garden")));
  rec.regs.order = reg(["Garden", "Town"]);
  rec.regs["about/Garden"] = reg("Soil and seeds");
  rec.regs[`pSec/${id("p", 20)}`] = reg("Garden");
  rec.regs[`pSec/${id("p", 21)}`] = reg("Town");
  rec.regs[`pLine/${id("p", 20)}`] = reg("Cy on old oak mushrooms");
  rec.clock += 1;
  await page.evaluate(([f, json]) => window.app.vault.adapter.write(f, json), [file, JSON.stringify(rec)]);
  await page.evaluate(() => window.app.workspace.requestSaveLayout());
  await wait(2000);
  await page.evaluate(() => window.app.commands.executeCommandById("app:reload")).catch(() => {});
  await wait(2500);
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, undefined, { timeout: 90000 });
  const second = await open();
  check(/your digest/i.test(second.text) && second.rows > 0, "the digest page has content after a restart, with sections and lines in the record");

  // DG7 / DG19: a past edition written by an editor shows "Editor: <name>" as the top line under the masthead (small caps, muted, text only); today's edition, plain here (the AI layer is off), draws no top line at all.
  check(await page.evaluate(() => document.querySelectorAll(".blyg-daily .blyg-daily-priceline").length) === 0, "a plain edition draws no top line (no price, no editor)");
  const pastId = rec.id - 24 * 3600 * 1000;
  const pastRec = { id: pastId, at: pastId + 1000, stories: [{ headline: "Harbour lanterns lit early", summary: "A calm start to the day.", posts: [] }], singles: [], sections: null, who: {}, editor: "harbour-master" };
  // (the history is the `hist` register of an edition's file since DG16: a file of another device that carries only that, so it can be removed again below)
  const pastFile = `${dir}/ed-${pastId}.e2epast.json`;
  await page.evaluate(([f, json]) => window.app.vault.adapter.write(f, json), [pastFile, JSON.stringify({ v: 2, id: pastId, device: "e2epast", label: "Test", at: Date.now(), posts: {}, regs: { hist: { c: 1, d: "e2epast", v: pastRec } }, clock: 1 })]);
  await page.evaluate(() => document.querySelectorAll(".notice").forEach((n) => n.remove())); // no stray toast in the way of the touch steps
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-daily"));
  await open();
  // Older editions: the date line is the control. A small ▾ marks it, a tap opens a list of editions under the date (today's first), Escape closes it and gives the focus back, a pick shows the older edition read-only,
  // "Back to today" returns. The list stays inside the pane (no sideways scroll). The menu holds no edition switcher any more.
  await page.waitForSelector(".blyg-daily .blyg-daily-datebtn", { timeout: 20000 });
  const dateInfo = await page.evaluate(() => { const b = document.querySelector(".blyg-daily .blyg-daily-datebtn"); return { text: document.querySelector(".blyg-daily .blyg-daily-date")?.textContent ?? "", mark: b?.querySelector(".blyg-daily-datemark")?.textContent, markHidden: b?.querySelector(".blyg-daily-datemark")?.getAttribute("aria-hidden"), expanded: b?.getAttribute("aria-expanded"), tag: b?.tagName }; });
  check(dateInfo.tag === "BUTTON" && dateInfo.mark === "▾" && dateInfo.markHidden === "true" && dateInfo.expanded === "false", `the date is a button with a small ▾ when older editions exist (${JSON.stringify(dateInfo)})`);
  // The date is English whatever the device's language: English weekday and month and an English ordinal ("Friday, November 27th, 2026"), not the locale's ("Freitag, 27. November 2026").
  check(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}\u25BE?$/.test(dateInfo.text), `the header date is English and does not follow the device locale (${dateInfo.text})`);
  check(await page.evaluate(() => !document.querySelector(".blyg-daily .blyg-daily-switcher, .blyg-daily .blyg-daily-select, .blyg-daily .blyg-daily-panel select")), "the menu holds no edition switcher");
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-datebtn").click());
  await page.waitForSelector(".blyg-daily .blyg-daily-editions.is-open", { state: "visible", timeout: 20000 });
  const pop = await page.evaluate(() => {
    const v = document.querySelector(".view-content.blyg-daily"); const l = document.querySelector(".blyg-daily .blyg-daily-editions"); const d = document.querySelector(".blyg-daily .blyg-daily-bar .blyg-daily-date"); const R = (e) => e.getBoundingClientRect();
    const rows = [...l.querySelectorAll("button.blyg-daily-edition")];
    return { n: rows.length, first: rows[0]?.querySelector(".blyg-daily-edition-date")?.textContent, current: rows.filter((r) => r.getAttribute("aria-current") === "true").length, below: R(l).top >= R(d).bottom - 1, inside: R(l).left >= R(v).left - 1 && R(l).right <= R(v).right + 1, sw: v.scrollWidth <= v.clientWidth, tall: rows.every((r) => R(r).height >= 40), expanded: document.querySelector(".blyg-daily .blyg-daily-datebtn")?.getAttribute("aria-expanded"), focus: document.activeElement === rows[0] };
  });
  check(pop.n === 2 && pop.first === "Today" && pop.current === 1 && pop.below && pop.inside && pop.sw && pop.tall && pop.expanded === "true" && pop.focus, `the date opens a list of editions under it, today's first and marked, inside the pane, no sideways scroll, rows at touch height, focus on the current one (${JSON.stringify(pop)})`);
  // the same list at phone widths: nothing scrolls sideways and the list stays inside the pane (393, 360, 320 px)
  const cdpW = await page.context().newCDPSession(page);
  // (the desktop shell keeps its side docks at their desktop width when the window shrinks, which leaves the page a sliver: fold them for the measurement, as a phone has no docks, and put them back after)
  const docks = await page.evaluate(() => { const w = window.app.workspace; const was = { left: !w.leftSplit?.collapsed, right: !w.rightSplit?.collapsed }; w.leftSplit?.collapse?.(); w.rightSplit?.collapse?.(); return was; });
  const fitNow = () => page.evaluate(() => { const v = document.querySelector(".view-content.blyg-daily"); const l = document.querySelector(".blyg-daily .blyg-daily-editions"); const R = (e) => e.getBoundingClientRect(); return { sw: v.scrollWidth <= v.clientWidth, list: R(l).left >= -0.5 && R(l).right <= window.innerWidth + 0.5, rows: [...l.querySelectorAll("button.blyg-daily-edition")].every((r) => r.scrollWidth <= r.clientWidth + 1), w: window.innerWidth, vw: [v.scrollWidth, v.clientWidth], lw: [Math.round(R(l).left), Math.round(R(l).right)] }; });
  for (const [w, h] of [[393, 852], [360, 780], [320, 700]]) {
    await cdpW.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1500); // the phone layout needs a moment to settle after the resize (as in the width checks below)
    let fit = await fitNow();
    for (let i = 0; i < 6 && !(fit.sw && fit.list && fit.rows); i++) { await wait(500); fit = await fitNow(); }
    check(fit.sw && fit.list && fit.rows, `${w} px: the list of editions fits the pane, no sideways scroll (${JSON.stringify(fit)})`);
  }
  await cdpW.send("Emulation.clearDeviceMetricsOverride");
  await page.evaluate((was) => { const w = window.app.workspace; if (was.left) w.leftSplit?.expand?.(); if (was.right) w.rightSplit?.expand?.(); }, docks);
  await wait(400);
  await page.keyboard.press("Escape");
  const closed = await page.evaluate(() => ({ open: document.querySelector(".blyg-daily .blyg-daily-editions")?.classList.contains("is-open"), expanded: document.querySelector(".blyg-daily .blyg-daily-datebtn")?.getAttribute("aria-expanded"), focus: document.activeElement === document.querySelector(".blyg-daily .blyg-daily-datebtn") }));
  check(!closed.open && closed.expanded === "false" && closed.focus, `Escape closes the list and the date button has the focus back (${JSON.stringify(closed)})`);
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-datebtn").click());
  await page.waitForSelector(".blyg-daily .blyg-daily-editions.is-open", { state: "visible", timeout: 20000 });
  await page.evaluate(() => document.querySelectorAll(".blyg-daily .blyg-daily-editions button.blyg-daily-edition")[1].click());
  const line = await page.waitForSelector(".blyg-daily .blyg-daily-priceline", { timeout: 20000 }).then((el) => el.evaluate((n) => { const c = getComputedStyle(n); const first = document.querySelector(".blyg-daily .blyg-story, .blyg-daily .blyg-daily-section"); return { text: n.textContent, kids: n.children.length, caps: c.fontVariantCaps, above: !first || n.getBoundingClientRect().bottom <= first.getBoundingClientRect().top + 1 }; }));
  check(line.text === "Editor: Harbour Master Okafor" && line.kids === 0 && line.caps === "small-caps" && line.above, `a past edition shows its editor, and no price it does not have, as one small-caps line of plain text above the first story (${JSON.stringify(line)})`);
  const past = await page.evaluate(() => ({ kicker: document.querySelector(".blyg-daily .blyg-daily-kicker")?.textContent, back: document.querySelector(".blyg-daily .blyg-daily-back")?.textContent, closed: !document.querySelector(".blyg-daily .blyg-daily-editions.is-open") }));
  check(past.kicker === "Earlier edition" && past.back === "‹ Back to today" && past.closed, `a past edition says so and offers Back to today; the list closed after the pick (${JSON.stringify(past)})`);
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-back").click());
  check(await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-kicker")?.textContent === "Your digest" && !document.querySelector(".blyg-daily .blyg-daily-back")), "Back to today shows today's edition again");
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-daily"));
  await page.evaluate((f) => window.app.vault.adapter.remove(f), pastFile); // the later steps start without a past edition (no day switcher)

  // The page's actions, in real Obsidian: single-post lines, Mark read (one request per unread post, none by itself), a tap on a post of an unfolded story, Back.
  // (Sections, the contents and the AI lines need the AI layer, which this scenario leaves off: they are covered by unit tests only.)
  await page.evaluate((t) => window.app.secretStorage.setSecret("smoke-studio", t), TOKEN);
  await wait(800);
  await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-daily").forEach((l) => l.detach()));
  await open();
  const look = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".blyg-daily .blyg-story-mixed")];
    const line = rows[0]?.querySelector(".blyg-story-line");
    const by = rows[0]?.querySelector(".blyg-story-by");
    return { rows: rows.length, weight: line ? Number(getComputedStyle(line).fontWeight) : 0, italic: by ? getComputedStyle(by).fontStyle : "", byText: by?.textContent ?? "", minutes: /\b\d+ min\b/.test(document.querySelector(".blyg-daily")?.innerText ?? ""), time: document.querySelectorAll(".blyg-story-time").length };
  });
  check(look.rows === 2 && look.weight >= 600 && look.italic === "italic" && /^by \w+/.test(look.byText), `a single post: bold content line, "by Author" in italics (${JSON.stringify(look)})`);
  check(!look.minutes && look.time === 0, "a single post shows no reading time");
  // a revised post: its change note is read lazily from the history route and leads the correction line (bold), the headline second; shown as text, not as markup
  await wait(1500);
  const corr = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".blyg-daily .blyg-daily-row")].find((r) => r.querySelector(".blyg-correction-note"));
    const lead = row?.querySelector(".blyg-correction-note");
    return { lead: lead?.textContent ?? "", weight: lead ? Number(getComputedStyle(lead).fontWeight) : 0, first: row?.querySelector(".blyg-correction-headline")?.nextElementSibling === lead && lead?.nextElementSibling?.classList.contains("blyg-daily-meta"), size: lead && row?.querySelector(".blyg-correction-headline") ? getComputedStyle(lead).fontSize === getComputedStyle(row.querySelector(".blyg-correction-headline")).fontSize : false, head: row?.querySelector(".blyg-correction-headline")?.textContent ?? "", markup: !!lead?.querySelector("b") };
  });
  check(corr.lead === "Fixed the <b>March</b> total" && !corr.markup && corr.weight >= 600 && corr.first && corr.size && /Trains were delayed/.test(corr.head), `a revised post's change note leads its correction line in bold, as plain text, after the headline at the same size and before the author line (${JSON.stringify(corr)})`);
  check(histories.length === 1, `the note was asked for once, for the one revised post (${histories.length} request)`);
  const before = marks.length;
  const sym = await page.evaluate(() => { const b = document.querySelector(".blyg-daily .blyg-story-mixed .blyg-mark"); return { label: b?.getAttribute("aria-label"), text: b?.textContent ?? "x", svg: !!b?.querySelector("svg"), w: b?.getBoundingClientRect().width ?? 0 }; });
  check(sym.label === "Mark read" && sym.text === "" && sym.svg && sym.w >= 28, `the read mark is a symbol (an icon, no word) with a label in words and a tappable size (${JSON.stringify(sym)})`);
  await page.click(".blyg-daily .blyg-story-mixed .blyg-mark");
  await wait(1500);
  const afterOne = await page.evaluate(() => ({ dim: document.querySelectorAll(".blyg-daily .blyg-story-mixed.blyg-is-read").length, labels: [...document.querySelectorAll(".blyg-daily .blyg-story-mixed .blyg-mark")].map((b) => b.getAttribute("aria-label")), svgs: [...document.querySelectorAll(".blyg-daily .blyg-story-mixed .blyg-mark")].every((b) => b.querySelector("svg")) }));
  check(marks.length === before + 1 && afterOne.dim === 1 && afterOne.labels.includes("Mark unread") && afterOne.svgs, `Mark read on a single post: one request, dimmed at once, the symbol now offers Mark unread (${marks.length - before} request, ${JSON.stringify(afterOne)})`);
  const undoAt = unmarks.length;
  await page.click('.blyg-daily .blyg-story-mixed .blyg-mark[aria-label="Mark unread"]');
  await wait(1500);
  const afterUndo = await page.evaluate(() => ({ dim: document.querySelectorAll(".blyg-daily .blyg-story-mixed.blyg-is-read").length, labels: [...document.querySelectorAll(".blyg-daily .blyg-story-mixed .blyg-mark")].map((b) => b.getAttribute("aria-label")) }));
  check(unmarks.length === undoAt + 1 && marks.length === before + 1 && afterUndo.dim === 0 && afterUndo.labels.every((l) => l === "Mark read"), `tapping the read symbol marks the post unread again: one request, not dimmed, nothing re-marked (${unmarks.length - undoAt} request, ${JSON.stringify(afterUndo)})`);
  await page.click('.blyg-daily .blyg-story-mixed .blyg-mark[aria-label="Mark read"]'); // read again: the rest of the scenario starts from one read single post
  await wait(1500);
  check(marks.length === before + 2, "marking the same post read again is one more request");
  // an unfolded story: a tap on the preview text (not the name) opens the post; Back returns with the story still unfolded and the page where it was
  await page.click(".blyg-daily .blyg-story-headline");
  await wait(300);
  const members = await page.evaluate(() => document.querySelectorAll(".blyg-daily .blyg-daily-member").length);
  check(members === 2, `a story unfolds into its posts (${members})`);
  const set = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-daily"); const max = v.scrollHeight - v.clientHeight; v.scrollTop = Math.min(max, 120); return { top: v.scrollTop, max }; });
  await wait(300);
  const asked = others.length;
  const digestOrder = await page.evaluate(() => [...new Set(window.app.workspace.getLeavesOfType("blyg-daily")[0].view.order.map((p) => p.remoteId))]); // the posts of the page, top to bottom (what the reader walks)
  await page.click(".blyg-daily .blyg-daily-member .blyg-daily-preview");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  await wait(1500);
  // DG18: Next and Previous walk ALL posts of the digest, top to bottom, read ones included, and the counter counts that same list and names it
  const counter = () => page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-stepcount")?.textContent ?? "");
  const shownId = () => page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId ?? "");
  const start = await shownId();
  const at0 = digestOrder.indexOf(start);
  const c1 = await counter();
  await page.click(".blyg-reader-header .blyg-reader-step-next");
  await wait(600);
  const c2 = await counter();
  await page.click(".blyg-reader-header .blyg-reader-step-prev");
  await wait(600);
  const c3 = await counter();
  check(digestOrder.length >= 8 && at0 >= 0 && c1 === `Digest · ${at0 + 1} of ${digestOrder.length}` && c2 === `Digest · ${at0 + 2} of ${digestOrder.length}` && c3 === c1, `Next and Previous count the digest's whole list and name it: "${c1}", then "${c2}", then "${c3}" (the page holds ${digestOrder.length} posts)`);
  // all the way to the end: every post of the page once, in the page's order, across the stories and into the singles
  const seenForward = [await shownId()];
  for (let i = at0; i < digestOrder.length - 1; i++) {
    await page.click(".blyg-reader-header .blyg-reader-step-next");
    await s.pollUntil("the next post of the digest", shownId, (id) => id !== seenForward.at(-1), 8000);
    seenForward.push(await shownId());
  }
  const endState = await page.evaluate(() => ({ next: document.querySelector(".blyg-reader-header .blyg-reader-step-next")?.disabled, prev: document.querySelector(".blyg-reader-header .blyg-reader-step-prev")?.disabled, count: document.querySelector(".blyg-reader-header .blyg-reader-stepcount")?.textContent ?? "" }));
  check(JSON.stringify(seenForward) === JSON.stringify(digestOrder.slice(at0)) && endState.next === true && endState.prev === false && endState.count === `Digest · ${digestOrder.length} of ${digestOrder.length}`, `Next goes through the page's posts in order to the end, across stories and singles, and stops there (${JSON.stringify({ seenForward: seenForward.length, expected: digestOrder.length - at0, endState })})`);
  // back to the first one: the same list the other way
  for (let i = digestOrder.length - 1; i > at0; i--) {
    const before = await shownId();
    await page.click(".blyg-reader-header .blyg-reader-step-prev");
    await s.pollUntil("the previous post of the digest", shownId, (id) => id !== before, 8000);
  }
  check((await shownId()) === start && (await counter()) === c1, `Previous walks the same list back to where it started ("${await counter()}")`);
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-daily-member", { state: "attached", timeout: 20000 });
  await wait(1500);
  const back = await page.evaluate(() => ({ members: document.querySelectorAll(".blyg-daily .blyg-daily-member").length, top: document.querySelector(".view-content.blyg-daily")?.scrollTop ?? -1 }));
  check(back.members === 2 && Math.abs(back.top - set.top) <= 2, `Back from a post of an unfolded story: still unfolded (${back.members}) at the same place (${back.top} of ${set.top})`);
  await wait(3000);
  check(others.length === asked, `opening a post from the digest, stepping, and Back asked the Studio for nothing (${others.slice(asked).join(", ") || "0 requests"})`);
  // a single post opened from the digest walks the same list (one rule for every entry point, not the feed's order)
  await page.click(".blyg-daily .blyg-story-mixed .blyg-story-line");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-stepcount", { timeout: 20000 });
  await wait(800);
  const singleId = await shownId();
  const singleCount = await counter();
  check(digestOrder.includes(singleId) && singleCount === `Digest · ${digestOrder.indexOf(singleId) + 1} of ${digestOrder.length}`, `a single post opened from the digest walks the same ${digestOrder.length} posts, at its place in the page's order ("${singleCount}")`);
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-story-mixed", { state: "attached", timeout: 20000 });
  await wait(1500);
  const storyAt = marks.length;
  await page.click(".blyg-daily .blyg-story .blyg-storymark");
  await wait(2500);
  const gaps = marks.slice(storyAt).map((m, i, a) => (i ? m.at - a[i - 1].at : Infinity)).slice(1);
  check(marks.length === storyAt + 2 && gaps.every((g) => g >= 300), `Mark story read: one request per unread post (${marks.length - storyAt}), spaced out (${gaps.join(", ")} ms)`);
  const storySym = await page.evaluate(() => document.querySelector(".blyg-daily .blyg-story .blyg-storymark")?.textContent);
  check(storySym === "Mark story unread", `a story whose posts are all read offers Mark story unread (${storySym})`);
  const unAt = unmarks.length;
  await page.click(".blyg-daily .blyg-story .blyg-storymark");
  await wait(2500);
  const ugaps = unmarks.slice(unAt).map((m, i, a) => (i ? m.at - a[i - 1].at : Infinity)).slice(1);
  const storyAfter = await page.evaluate(() => ({ label: document.querySelector(".blyg-daily .blyg-story .blyg-storymark")?.textContent, dim: document.querySelectorAll(".blyg-daily .blyg-story.blyg-is-read").length }));
  check(unmarks.length === unAt + 2 && ugaps.every((g) => g >= 300) && storyAfter.label === "Mark story read" && storyAfter.dim === 0, `tapping a read story marks every read post unread again: one request per post (${unmarks.length - unAt}), spaced out (${ugaps.join(", ")} ms), shown at once (${JSON.stringify(storyAfter)})`);
  const quiet0 = marks.length + unmarks.length;
  await wait(2500);
  check(marks.length + unmarks.length === quiet0, "no mark is repeated by itself after an undo");
  await page.click(".blyg-daily .blyg-story .blyg-storymark"); // read again so the remaining checks see what they did before
  await wait(2500);
  const quiet = marks.length;
  await wait(3000);
  check(marks.length === quiet, "nothing is marked again by itself");
  // The Feed | Digest switch: small tabs in both headers; the mode is kept; going to the Feed reads the list at most once (the reader opens from nothing), and going back and forth asks nothing more.
  const bar = await page.evaluate(() => {
    const v = document.querySelector(".view-content.blyg-daily");
    const b = document.querySelector(".blyg-daily .blyg-daily-bar");
    const slot = b?.querySelector(".blyg-modeslot");
    const panel = b?.querySelector(".blyg-daily-panel");
    const r0 = b?.getBoundingClientRect();
    v.scrollTop = 300;
    const r1 = b?.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    return { title: b?.querySelector(".blyg-daily-date")?.textContent ?? "", ordinal: /\b\d+(st|nd|rd|th)\b/.test(b?.querySelector(".blyg-daily-date")?.textContent ?? ""), kicker: !!b?.querySelector(".blyg-daily-kicker"), toggle: slot?.querySelectorAll(".blyg-modebtn").length ?? 0, menu: !!b?.querySelector(".blyg-daily-menu svg"), folded: getComputedStyle(panel).display === "none", scrolled: v.scrollTop, stuck: Math.abs((r1?.top ?? -99) - vr.top) <= 2, off: (r1?.top ?? -99) - vr.top, pad: getComputedStyle(v).paddingTop, pos: getComputedStyle(b).position, moved: r0 && r1 ? r0.top !== r1.top || v.scrollTop === 0 : false, sw: v.scrollWidth <= v.clientWidth, h: r1?.height ?? 0 };
  });
  check(bar.ordinal && bar.kicker && bar.toggle === 2 && bar.menu && bar.folded, `the bar is folded: dateline with an ordinal, title, the Feed | Digest toggle and one menu icon (${JSON.stringify(bar)})`);
  check(bar.scrolled > 0 ? bar.stuck : true, `the bar stays on top while the page scrolls (${JSON.stringify({ scrolled: bar.scrolled, off: bar.off, pad: bar.pad, pos: bar.pos, h: bar.h })})`);
  check(bar.sw, "the folded bar causes no sideways scroll");
  // DG11, in real Obsidian: (a) the contents list the headings the page draws, in that order, "Top stories" first, with a counter equal to the posts drawn under each heading (the stories' own "N posts" lines, the singles);
  // (b) a story is a card (own background, thin border, radius) with a chevron that turns when it is unfolded, readable in the light and the dark theme, nothing under the chevron, no sideways scroll.
  const toc = await page.evaluate(() => {
    const names = [...document.querySelectorAll(".blyg-daily .blyg-toc-name")].map((e) => e.textContent);
    const counts = [...document.querySelectorAll(".blyg-daily .blyg-toc-count")].map((e) => e.textContent);
    const heads = [...document.querySelectorAll(".blyg-daily .blyg-daily-section > h3")].map((e) => e.textContent);
    const drawn = [...document.querySelectorAll(".blyg-daily .blyg-daily-section")].filter((s) => s.querySelector(":scope > h3")).map((s) => {
      const posts = [...s.querySelectorAll(".blyg-story > .blyg-daily-meta")].reduce((k, m) => k + Number((/^(\d+) post/.exec(m.textContent ?? "") ?? [0, 0])[1]), 0) + s.querySelectorAll(".blyg-story-mixed").length;
      const rows = [...s.children].filter((c) => c.classList.contains("blyg-daily-row") && !c.classList.contains("blyg-story-mixed")).length;
      return { name: s.querySelector(":scope > h3").textContent, n: posts || rows };
    });
    return { names, counts, heads, drawn };
  });
  check(toc.names.length >= 2 && toc.names[0] === "Top stories" && JSON.stringify(toc.names) === JSON.stringify(toc.heads), `the contents list the headings drawn, in the order drawn, Top stories first (${JSON.stringify(toc.names)} against ${JSON.stringify(toc.heads)})`);
  check(toc.drawn.every((d, i) => toc.counts[i] === `${d.n} ${d.n === 1 ? "item" : "items"}`), `each contents counter equals what is drawn under its heading (${JSON.stringify(toc.counts)} against ${JSON.stringify(toc.drawn)})`);
  // DG14: a story is typography, not a box. Measured in both themes: no background, border, radius or shadow on a story, a hairline between stories, the headline larger than the summary, the meta line small, muted and italic, a "›" mark and no chevron element, contrast of headline, summary and meta.
  const typeLook = (theme) => page.evaluate(async (theme) => {
    if (theme) { document.body.classList.toggle("theme-dark", theme === "dark"); document.body.classList.toggle("theme-light", theme !== "dark"); await new Promise((r) => setTimeout(r, 400)); } // (Obsidian's own theme classes: all the variables follow them)
    const num = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lum = (c) => { const [r, g, b] = num(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(1); };
    const stories = [...document.querySelectorAll(".blyg-daily .blyg-daily-cluster.blyg-story")];
    const card = stories[0];
    const head = card.querySelector(":scope > .blyg-story-headline");
    const sum = card.querySelector(":scope > .blyg-story-summary");
    const meta = card.querySelector(":scope > .blyg-daily-meta");
    const page = getComputedStyle(document.querySelector(".view-content.blyg-daily")).backgroundColor;
    const bg = getComputedStyle(document.querySelector(".blyg-daily")).backgroundColor;
    const solid = (c) => (/rgba\(.*, 0\)$/.test(c) || c === "transparent" ? (/rgba?\(0, 0, 0/.test(bg) ? getComputedStyle(document.body).backgroundColor : bg) : c);
    const ground = solid(page);
    const probe = document.createElement("span"); probe.style.color = "var(--text-accent)"; document.body.appendChild(probe); const accent = getComputedStyle(probe).color; probe.remove();
    const box = (el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, shadow: c.boxShadow, radius: c.borderTopLeftRadius, l: c.borderLeftWidth, r: c.borderRightWidth, b: c.borderBottomWidth, t: c.borderTopWidth }; };
    const bx = stories.map(box);
    const plain = bx.every((c) => (c.bg === "rgba(0, 0, 0, 0)" || c.bg === "transparent") && c.shadow === "none" && c.radius === "0px" && c.l === "0px" && c.r === "0px" && c.b === "0px");
    const rules = stories.slice(1).map((el, i) => stories[i].nextElementSibling === el && getComputedStyle(el).borderTopWidth === "1px");
    const px = (el) => parseFloat(getComputedStyle(el).fontSize);
    const ms = getComputedStyle(meta);
    const v = document.querySelector(".view-content.blyg-daily");
    const mark = card.querySelector(":scope > .blyg-daily-meta > .blyg-story-more");
    return { theme: document.body.classList.contains("theme-dark") ? "dark" : "light", stories: stories.length, plain, ruleBetween: rules.length ? rules.every(Boolean) : null, firstTop: getComputedStyle(card).borderTopWidth, headPx: px(head), sumPx: sum ? px(sum) : null, metaPx: px(meta), headWeight: +getComputedStyle(head).fontWeight, headLead: getComputedStyle(head).lineHeight, metaStyle: ms.fontStyle, headContrast: ratio(getComputedStyle(head).color, ground), sumContrast: sum ? ratio(getComputedStyle(sum).color, ground) : null, metaContrast: ratio(ms.color, ground), accentContrast: ratio(accent, ground), chevron: document.querySelectorAll(".blyg-daily .blyg-story-chevron, .blyg-daily .blyg-story > svg, .blyg-daily .blyg-story > button.clickable-icon").length, markText: mark?.textContent ?? null, markTag: mark?.tagName ?? null, markLabel: mark?.getAttribute("aria-label") ?? null, headIsButton: head.tagName === "BUTTON" && head.hasAttribute("aria-expanded"), sectionRule: getComputedStyle(document.querySelector(".blyg-daily .blyg-daily-section > h3")).borderBottomWidth, sw: v.scrollWidth <= v.clientWidth };
  }, theme);
  const lookDark = await typeLook("dark");
  const lookLight = await typeLook("light");
  for (const c of [lookDark, lookLight]) {
    check(c.plain && c.firstTop === "0px" && c.ruleBetween !== false && c.chevron === 0 && c.headIsButton, `a story is plain type in the ${c.theme} theme: no background, border, radius or shadow, a hairline between stories, no chevron, the headline still a button with aria-expanded (${JSON.stringify(c)})`);
    check(c.headPx > (c.sumPx ?? 0) && c.headWeight >= 600 && c.metaPx < (c.sumPx ?? c.headPx) && c.metaStyle === "italic" && /^[+−]$/.test(c.markText ?? "") && c.markTag === "BUTTON" && !!c.markLabel, `the ${c.theme} theme: headline larger than summary, bold; meta line smaller and italic, ending in a "+" (or "−" while unfolded) button with a label in words (${JSON.stringify(c)})`);
    check(c.headContrast >= 4.5 && (c.sumContrast === null || c.sumContrast >= 4.5) && c.metaContrast >= 4.5 && c.accentContrast >= 3 && +c.sectionRule.replace("px", "") >= 2 && c.sw, `the ${c.theme} theme: contrast of headline, summary and meta at least 4.5, accent at least 3 (large text), a heavier rule under the section heading, no sideways scroll (${JSON.stringify(c)})`);
  }
  check(lookLight.stories >= 2 && lookLight.ruleBetween === true, `the page holds at least two stories in a row and a rule sits between them (${lookLight.stories} stories, rule ${lookLight.ruleBetween})`);
  // DG18: posts already read are dimmed in place: a muted colour (not opacity, not struck through), still readable and tappable; a story whose posts are all read has its headline lighter too; unread ones are unchanged. Both themes.
  const readLook = (theme) => page.evaluate(async (theme) => {
    document.body.classList.toggle("theme-dark", theme === "dark"); document.body.classList.toggle("theme-light", theme !== "dark"); await new Promise((r) => setTimeout(r, 400));
    const num = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lum = (c) => { const [r, g, b] = num(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(1); };
    const colour = (v) => { const probe = document.createElement("span"); probe.style.color = `var(${v})`; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; };
    const ground = getComputedStyle(document.querySelector(".view-content.blyg-daily")).backgroundColor;
    const pick = (q) => document.querySelector(q);
    const readHead = pick(".blyg-daily .blyg-story.blyg-is-read > .blyg-story-headline");
    const unreadHead = pick(".blyg-daily .blyg-story:not(.blyg-is-read) > .blyg-story-headline");
    const readLine = pick(".blyg-daily .blyg-story-mixed.blyg-is-read .blyg-story-line");
    const unreadLine = pick(".blyg-daily .blyg-story-mixed:not(.blyg-is-read) .blyg-story-line");
    const st = (el) => (el ? getComputedStyle(el) : null);
    const solid = (c) => (/rgba\(.*, 0\)$/.test(c) || c === "transparent" ? getComputedStyle(document.body).backgroundColor : c);
    return {
      theme, muted: colour("--text-muted"), normal: colour("--text-normal"),
      readHead: st(readHead)?.color ?? null, unreadHead: st(unreadHead)?.color ?? null, readLine: st(readLine)?.color ?? null, unreadLine: st(unreadLine)?.color ?? null,
      opacity: [readHead, readLine].map((el) => (el ? getComputedStyle(el).opacity + "/" + getComputedStyle(el.closest(".blyg-story, .blyg-story-mixed")).opacity : null)),
      decoration: [readHead, readLine].map((el) => (el ? getComputedStyle(el).textDecorationLine : null)),
      tappable: [readHead, readLine].map((el) => !!el && !el.disabled && getComputedStyle(el).pointerEvents !== "none"),
      contrast: [readHead, readLine].map((el) => (el ? ratio(getComputedStyle(el).color, solid(ground)) : null)),
    };
  }, theme);
  await page.mouse.move(0, 0); // (a pointer resting on a headline would show its hover colour)
  for (const theme of ["dark", "light"]) {
    const r = await readLook(theme);
    check(r.readHead !== null && r.readLine !== null && r.unreadHead !== null && r.unreadLine !== null, `the ${theme} theme: the page holds a read story and a read single post, and unread ones to compare (${JSON.stringify(r)})`);
    check(r.readHead === r.muted && r.readLine === r.muted && r.unreadHead === r.normal && r.unreadLine === r.normal, `the ${theme} theme: a read story's headline and a read post's line are the muted colour, unread ones are unchanged (${JSON.stringify(r)})`);
    check(r.opacity.every((o) => o === "1/1") && r.decoration.every((d) => d === "none") && r.tappable.every(Boolean) && r.contrast.every((c) => c >= 4.5), `the ${theme} theme: read text is not made see-through or struck through, stays tappable, contrast at least 4.5 (${JSON.stringify(r)})`);
  }
  const lead = await page.evaluate(() => { const s = [...document.querySelectorAll(".blyg-daily .blyg-daily-cluster.blyg-story")]; const f = (el) => parseFloat(getComputedStyle(el.querySelector(":scope > .blyg-story-headline")).fontSize); const lead = s.find((e) => !(e.previousElementSibling?.classList.contains("blyg-story"))); const next = s.find((e) => e.previousElementSibling?.classList.contains("blyg-story")); return lead && next ? { lead: f(lead), next: f(next) } : null; });
  check(lead && lead.lead > lead.next, `the first story of a block is set larger than the next (${JSON.stringify(lead)})`);
  const rot = async () => page.evaluate(async () => { await new Promise((r) => setTimeout(r, 150)); const c = document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story"); return { open: c.classList.contains("is-open"), expanded: c.querySelector(".blyg-story-headline").getAttribute("aria-expanded"), members: c.querySelectorAll(".blyg-daily-member").length, ruled: c.querySelector(".blyg-daily-members") ? getComputedStyle(c.querySelector(".blyg-daily-members")).borderLeftWidth : null }; });
  const t0 = await rot(); // (a story may already be unfolded by an earlier step: the check is that each tap flips it)
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-headline").click());
  const t1 = await rot();
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-summary, .blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-headline").click());
  const t2 = await rot();
  check(t0.open !== t1.open && t2.open === t0.open && [t0, t1, t2].every((o) => o.expanded === String(o.open) && (o.members > 0) === o.open) && [t0, t1, t2].filter((o) => o.open).every((o) => o.ruled === "1px"), `the headline unfolds and folds the story, aria-expanded follows, the posts sit under a left hairline (${JSON.stringify([t0, t1, t2])})`);
  if (t0.open) await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-headline").click()); // leave it as the later steps found it (folded)
  // DG19 (mockups 3A and 3B): the marker at the right end of the meta line ("+" folded, "−" unfolded) without a new line or any height; no accent on the headline, open or pressed;
  // a read mark at the right of each post row; "Mark story read" as the last item of the unfolded list, and no line under a folded story.
  const storyLook = () => page.evaluate(() => {
    const card = document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story");
    card.scrollIntoView({ block: "center" });
    const head = card.querySelector(":scope > .blyg-story-headline");
    const meta = card.querySelector(":scope > .blyg-daily-meta");
    const mark = meta.querySelector(".blyg-story-more");
    const colour = (v) => { const e = document.createElement("span"); e.style.color = v; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; };
    const mr = meta.getBoundingClientRect();
    const kr = mark.getBoundingClientRect();
    const h0 = Math.round(meta.getBoundingClientRect().height * 10) / 10;
    mark.style.display = "none";
    const h1 = Math.round(meta.getBoundingClientRect().height * 10) / 10;
    mark.style.display = "";
    const members = [...card.querySelectorAll(".blyg-daily-member")];
    const list = card.querySelector(".blyg-daily-members");
    const last = list?.lastElementChild;
    const lastBtn = last?.querySelector("button");
    const lr = list?.getBoundingClientRect();
    const lbr = lastBtn?.getBoundingClientRect();
    return {
      open: card.classList.contains("is-open"), mark: mark.textContent, markLabel: mark.getAttribute("aria-label"), markExpanded: mark.getAttribute("aria-expanded"),
      markAtRight: kr.left + kr.width / 2 > mr.left + mr.width * 0.8 && kr.top + kr.height / 2 >= mr.top - 1 && kr.top + kr.height / 2 <= mr.bottom + 1, metaWithMark: h0, metaWithout: h1,
      headColour: getComputedStyle(head).color, normal: colour("var(--text-normal)"), accent: colour("var(--text-accent)"), markColour: getComputedStyle(mark).color, tapHighlight: getComputedStyle(head).webkitTapHighlightColor,
      members: members.length, marksInRows: members.filter((m) => { const b = m.querySelector(".blyg-mark"); if (!b) return false; const br = b.getBoundingClientRect(); const rr = m.getBoundingClientRect(); return br.left + br.width / 2 > rr.left + rr.width * 0.6 && br.right <= rr.right + 1 && br.width >= 28; }).length,
      lastIsStoryMark: !!last?.classList.contains("blyg-storymark-row") && /^Mark story (read|unread)$/.test(lastBtn?.textContent ?? "") && !members.some((m) => m.contains(lastBtn)),
      lastQuiet: lastBtn ? { italic: getComputedStyle(lastBtn).fontStyle, colour: getComputedStyle(lastBtn).color, bg: getComputedStyle(lastBtn).backgroundColor, rightGap: Math.round(lr.right - lbr.right) } : null,
      kids: [...card.children].map((c) => c.className.split(" ")[0]), listShown: list ? getComputedStyle(list).display !== "none" : false, cardH: Math.round(card.getBoundingClientRect().height),
    };
  });
  const folded = await storyLook();
  check(!folded.open && folded.mark === "+" && folded.markExpanded === "false" && folded.markAtRight && folded.metaWithMark === folded.metaWithout, `a folded story has "+" at the right end of its meta line, which has the same height with and without it (${JSON.stringify(folded)})`);
  check(!folded.kids.includes("blyg-story-markrow") && !folded.listShown && folded.members === 0, `a folded story has no line of its own under it (${JSON.stringify(folded.kids)}, list shown ${folded.listShown})`);
  check(folded.headColour !== folded.accent, `a folded story's headline is in its text colour (normal, or the muted read colour once its posts are read), never the accent (${folded.headColour}, accent ${folded.accent})`);
  await page.click(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-more");
  await wait(300);
  const unfoldedLook = await storyLook();
  check(unfoldedLook.open && unfoldedLook.mark === "−" && unfoldedLook.markExpanded === "true" && unfoldedLook.markAtRight && unfoldedLook.metaWithMark === unfoldedLook.metaWithout, `tapping the marker unfolds the story and the marker becomes "−" at the same place, same height (${JSON.stringify(unfoldedLook)})`);
  check(unfoldedLook.headColour !== unfoldedLook.accent && unfoldedLook.markColour !== unfoldedLook.accent, `an open story's headline and marker do not take the accent colour (${unfoldedLook.headColour} against text ${unfoldedLook.normal}, accent ${unfoldedLook.accent}, marker ${unfoldedLook.markColour})`);
  check(unfoldedLook.members >= 2 && unfoldedLook.marksInRows === unfoldedLook.members, `every post of the unfolded story has the read mark at the right of its row (${unfoldedLook.marksInRows} of ${unfoldedLook.members})`);
  check(unfoldedLook.lastIsStoryMark && unfoldedLook.lastQuiet.italic === "italic" && unfoldedLook.lastQuiet.bg === "rgba(0, 0, 0, 0)" && unfoldedLook.lastQuiet.colour !== unfoldedLook.accent && unfoldedLook.lastQuiet.rightGap <= 2, `"Mark story read" is the last item of the unfolded list, quiet italic text without a box, right-aligned (${JSON.stringify(unfoldedLook.lastQuiet)})`);
  // a press: underlined and lighter, never the accent, and the browser's own tap highlight is off
  const hb = await page.locator(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-headline").first().boundingBox();
  await page.mouse.move(hb.x + 8, hb.y + hb.height / 2);
  await page.mouse.down();
  const pressed = await page.evaluate(() => { const h = document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-headline"); const c = getComputedStyle(h); return { colour: c.color, deco: c.textDecorationLine, highlight: c.webkitTapHighlightColor }; });
  await page.mouse.move(2, 2);
  await page.mouse.up();
  check(pressed.deco === "underline" && pressed.colour !== unfoldedLook.accent && /rgba\(0, 0, 0, 0\)|transparent/.test(pressed.highlight), `a pressed headline is underlined and lighter, not the accent, with no tap highlight (${JSON.stringify(pressed)})`);
  await page.click(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-more"); // fold it again with the marker
  await wait(300);
  check(!(await storyLook()).open, "the marker folds the story again");
  await page.evaluate(() => { document.querySelector(".view-content.blyg-daily").scrollTop = 0; });
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-menu").click());
  await wait(300);
  const unfolded = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-daily"); const p = document.querySelector(".blyg-daily-panel"); return { shown: getComputedStyle(p).display !== "none", text: p.innerText, sw: v.scrollWidth <= v.clientWidth, expanded: document.querySelector(".blyg-daily-menu")?.getAttribute("aria-expanded") }; });
  check(unfolded.shown && /Refresh/.test(unfolded.text) && unfolded.sw && unfolded.expanded === "true", `the menu unfolds Refresh and the other controls without sideways scroll (${JSON.stringify(unfolded)})`);
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-menu").click());
  const tabs = await page.evaluate(() => [...document.querySelectorAll(".blyg-daily .blyg-modebtn")].map((b) => `${b.textContent}${b.classList.contains("is-active") ? "*" : ""}`).join(" "));
  check(tabs === "Feed Digest*", `the digest has the Feed | Digest switch, Digest pressed (${tabs})`);
  await page.evaluate(() => [...document.querySelectorAll(".blyg-daily .blyg-modebtn")].find((b) => b.textContent === "Feed").click());
  await page.waitForSelector(".blyg-reader-header .blyg-modeswitch", { timeout: 20000 });
  // the reader opens from nothing: its one read of the list starts when the app is idle (up to 3 s) and takes a moment; wait until the requests stop
  for (let seen = -1, stable = 0, i = 0; stable < 4 && i < 40; i++) { await wait(1000); stable = others.length === seen ? stable + 1 : 0; seen = others.length; }
  const afterFeed = others.length;
  const mode1 = await page.evaluate(() => window.app.plugins.plugins.blyg.settings.readerPane.mode ?? "feed");
  await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-modebtn")].find((b) => b.textContent === "Digest").click());
  await page.waitForSelector(".blyg-daily .blyg-modeswitch", { timeout: 20000 });
  await wait(1500);
  const mode2 = await page.evaluate(() => window.app.plugins.plugins.blyg.settings.readerPane.mode ?? "feed");
  await page.evaluate(() => [...document.querySelectorAll(".blyg-daily .blyg-modebtn")].find((b) => b.textContent === "Feed").click());
  await page.waitForSelector(".blyg-reader-header .blyg-modeswitch", { timeout: 20000 });
  await wait(2500);
  check(mode1 === "feed" && mode2 === "digest", `the mode is kept in the settings (${mode1}, then ${mode2})`);
  check(others.length === afterFeed, `switching between Feed and Digest asks the Studio for nothing more (${others.slice(afterFeed).join(", ") || "0 requests"})`);
  check(histories.length === 1, `opening the digest again, a post and Back asked for no note again (${histories.length} requests)`);

  // ---- Layout parity (DG9): MEASUREMENTS of the Feed | Digest toggle and of an open post's header, in the desktop layout, then in the phone layout at 393 and 360 px wide.
  // The toggle is one slot (the right end of the first header row) in a feed with a list, in a feed without Sort & filter (the Mentions tab) and in the digest; an open post
  // draws the same controls in the same places from a story and from the feed, and nothing in it is wider than the screen. (Chromium emulation, not iOS.)
  const tap = (sel) => page.evaluate((q) => document.querySelector(q)?.click(), sel);
  const box = (sel) => page.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; }, sel);
  const CONTROLS = { back: ".blyg-reader-header .blyg-reader-back", check: ".blyg-reader-header .blyg-reader-check", reply: ".blyg-reader-header .blyg-reader-replybtn", prev: ".blyg-reader-header .blyg-reader-step-prev", next: ".blyg-reader-header .blyg-reader-step-next" };
  const openPost = async () => {
    const o = {};
    for (const [k, sel] of Object.entries(CONTROLS)) o[k] = await box(sel);
    o.count = await box(".blyg-reader-header .blyg-reader-stepcount");
    o.view = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-reader"); const b = document.querySelector(".blyg-reader-scroll"); return { vw: window.innerWidth, sw: v?.scrollWidth ?? 0, cw: v?.clientWidth ?? 0, bsw: b?.scrollWidth ?? 0, bcw: b?.clientWidth ?? 0, dsw: document.documentElement.scrollWidth, dcw: document.documentElement.clientWidth }; });
    return o;
  };
  const inView = (o) => Object.keys(CONTROLS).every((k) => o[k] && o[k].r <= o.view.vw + 0.5 && o[k].l >= 0) && o.view.sw <= o.view.cw && o.view.bsw <= o.view.bcw && o.view.dsw <= o.view.dcw;
  // The reader starts from the saved list (the stand-in Studio never answers the list): first an empty one (the feed with nothing to show), then the full one.
  const startWith = async (list) => {
    // Nothing an earlier step left open may come back: the layout saved below is restored by the reload, and an open post or a leftover leaf there once made a LATER check
    // ("the empty feed ... 1 cards") fail in CI only. A clean workspace first (every leaf closed, the Feed mode, no choices kept), then the saved list.
    const clean = await s.resetWorkspace();
    if (!clean.ok) check(false, `a clean workspace before the reader starts from the saved list (${clean.state})`);
    await page.evaluate((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/reader-cache.json", json), JSON.stringify({ v: 1, origin: `${base}/`, savedAt: Date.now(), posts: list, mentions: [] }));
    await page.evaluate(() => window.app.workspace.requestSaveLayout());
    await wait(1500);
    await page.evaluate(() => window.app.commands.executeCommandById("app:reload")).catch(() => {});
    await wait(2500);
    await page.waitForFunction(() => window.app?.workspace?.layoutReady && window.app.plugins.plugins.blyg, undefined, { timeout: 90000 });
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await page.waitForSelector(".blyg-reader-header .blyg-modeswitch", { timeout: 30000 });
    await wait(3000);
    // (a load that was under way when the app reloaded may have written the list again: write ours once more and open the reader afresh, from the file)
    await page.evaluate((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/reader-cache.json", json), JSON.stringify({ v: 1, origin: `${base}/`, savedAt: Date.now(), posts: list, mentions: [] }));
    await page.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-reader"));
    await wait(500);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await page.waitForSelector(".blyg-reader-header .blyg-modeswitch", { timeout: 30000 });
    await wait(1500);
  };
  const layoutPass = async (label) => {
    await startWith(posts);
    await page.waitForSelector(".blyg-reader-card", { timeout: 30000 }).catch(async () => { console.error("cache:", await page.evaluate(() => window.app.vault.adapter.read(".obsidian/plugins/blyg/reader-cache.json").then((t) => t.slice(0, 200))), "base", base, "studio", await page.evaluate(() => window.app.plugins.plugins.blyg.settings.studio?.baseUrl)); console.error("view data:", await page.evaluate(() => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0]?.view; return JSON.stringify({ posts: v?.data?.posts?.length, filter: v?.filter, tab: v?.tab, status: v?.status }); })); console.error("reader shows:", await page.evaluate(() => document.querySelector(".view-content.blyg-reader")?.innerText?.slice(0, 400) ?? "(no reader)")); throw new Error("the feed shows no cards"); });
    const slotFeed = await box(".blyg-reader-header .blyg-modeslot");
    const hamb = await box(".blyg-reader-header .blyg-reader-menubtn"); // (DG19: the feed's menu button is the last item of the first row, after the toggle)
    await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-reader-btn")].find((b) => /^Mentions/.test(b.textContent ?? ""))?.click());
    await wait(500);
    const slotMentions = await box(".blyg-reader-header .blyg-modeslot");
    await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-reader-btn")].find((b) => b.textContent === "Reading")?.click());
    await wait(500);
    const verRect = await box(".blyg-reader-header .blyg-reader-version");
    const verClear = !verRect || !slotFeed || verRect.r <= slotFeed.l || verRect.l >= slotFeed.r || verRect.t >= slotFeed.b - 0.5; // (below the toggle: the version label is in the status row, under the first row)
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
    await wait(800);
    const feedPost = await openPost();
    await tap(".blyg-reader-header .blyg-reader-back");
    await page.waitForSelector(".blyg-reader-card", { timeout: 20000 });
    await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-modebtn")].find((b) => b.textContent === "Digest").click());
    await page.waitForSelector(".blyg-daily .blyg-modeswitch", { timeout: 20000 });
    await wait(1200);
    const slotDigest = await box(".blyg-daily .blyg-modeswitch"); // (the switch itself: the bar wraps it in a slot of its own)
    // D: the menu icon, the Refresh icon and the Feed | Digest toggle share one horizontal line (their vertical centres agree) in the Daily's header and the menu icon and the toggle in the feed's
    const mid = (r) => (r ? (r.t + r.b) / 2 : null);
    const dMenu = await box(".blyg-daily-bar .blyg-daily-menu"), dRefresh = await box(".blyg-daily-bar .blyg-daily-refresh");
    check(dMenu && dRefresh && slotDigest && Math.abs(mid(dMenu) - mid(slotDigest)) <= 1.5 && Math.abs(mid(dRefresh) - mid(slotDigest)) <= 1.5, `${label}: in the digest's header the menu icon (${mid(dMenu)}), the Refresh icon (${mid(dRefresh)}) and the toggle (${mid(slotDigest)}) are on one line`);
    check(hamb && slotFeed && Math.abs(mid(hamb) - mid(slotFeed)) <= 1.5, `${label}: in the feed's header the menu icon (${mid(hamb)}) and the toggle (${mid(slotFeed)}) are on one line`);
    // (the emulated phone layout draws a 12 px scrollbar inside the digest's page; a device draws none: the right edge is read without it)
    const bar = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-daily"); return v ? v.offsetWidth - v.clientWidth : 0; });
    const fitOf = (theme) => page.evaluate(async (theme) => { document.body.classList.toggle("theme-dark", theme === "dark"); document.body.classList.toggle("theme-light", theme !== "dark"); await new Promise((r) => setTimeout(r, 250)); const v = document.querySelector(".view-content.blyg-daily"); const c = document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story"); const h = c?.querySelector(".blyg-story-headline"); const m = c?.querySelector(".blyg-daily-meta"); if (!c || !h || !m) return null; const cr = c.getBoundingClientRect(); const over = [...c.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > cr.right + 1).length; return { sw: v.scrollWidth <= v.clientWidth, over, cardR: cr.right, vw: window.innerWidth, headH: Math.round(h.getBoundingClientRect().height), chev: !!c.querySelector(".blyg-story-chevron"), plain: getComputedStyle(c).backgroundColor === "rgba(0, 0, 0, 0)" && getComputedStyle(c).borderLeftWidth === "0px" && getComputedStyle(c).borderRadius === "0px" }; }, theme);
    for (const theme of ["dark", "light"]) {
      const cardFit = await fitOf(theme);
      check(cardFit && cardFit.sw && cardFit.over === 0 && !cardFit.chev && cardFit.plain && cardFit.cardR <= cardFit.vw, `${label}, ${theme} theme: a story fits the screen as plain type, nothing in it is wider than it and there is no chevron (${JSON.stringify(cardFit)})`);
    }
    await tap(".blyg-daily .blyg-story-headline");
    await wait(300);
    await tap(".blyg-daily .blyg-daily-member .blyg-daily-preview");
    await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
    await wait(1000);
    const storyPost = await openPost();
    const storyText = await page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-stepcount")?.textContent ?? "");
    await tap(".blyg-reader-header .blyg-reader-back");
    await page.waitForSelector(".blyg-daily .blyg-modeswitch", { timeout: 20000 });
    await page.evaluate(() => [...document.querySelectorAll(".blyg-daily .blyg-modebtn")].find((b) => b.textContent === "Feed").click());
    await page.waitForSelector(".blyg-reader-header .blyg-modeswitch", { timeout: 20000 });
    await wait(1000);
    const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
    // DG19: the feed's first row ends with the hamburger, after the toggle; the Daily's first row ends with its toggle (its own menu icon and Refresh are to the left of it): the two rows end at the same right edge,
    // the toggle is one slot in every state of the feed (with a list, the Mentions tab) and sits right before the hamburger, at the same height as the Daily's.
    check(slotFeed && slotMentions && slotDigest && hamb && near(slotFeed.r, slotMentions.r, 1) && near(slotFeed.t, slotMentions.t, 2) && near(hamb.r, slotDigest.r + bar, 1) && hamb.l >= slotFeed.r - 0.5 && hamb.l - slotFeed.r <= 12 && near(slotFeed.t, slotDigest.t, 2),
      `${label}: the Feed | Digest toggle is in one slot in the feed with a list and the Mentions tab, with the hamburger right after it at the row's right edge, the same edge where the digest's first row ends (right edges ${slotFeed?.r}, ${slotMentions?.r}; hamburger ${hamb?.l}-${hamb?.r} against the digest's ${slotDigest?.r + bar}; top ${slotFeed?.t}, ${slotMentions?.t}, ${slotDigest?.t})`);
    check(verClear, `${label}: the version label does not overlap the toggle (${JSON.stringify(verRect)} against ${JSON.stringify(slotFeed)})`);
    check(inView(feedPost) && inView(storyPost), `${label}: in an open post (feed and story) every header control is inside the viewport and nothing scrolls sideways (feed ${JSON.stringify(feedPost.view)}, story ${JSON.stringify(storyPost.view)}; right edges feed ${Object.keys(CONTROLS).map((k) => feedPost[k]?.r)}, story ${Object.keys(CONTROLS).map((k) => storyPost[k]?.r)})`);
    const same = Object.keys(CONTROLS).filter((k) => !(feedPost[k] && storyPost[k] && near(feedPost[k].l, storyPost[k].l, 1) && near(feedPost[k].t, storyPost[k].t, 1)));
    check(same.length === 0, `${label}: Back, the read check, Reply, Previous and Next are in the same places in the feed's post and the story's post (differing: ${same.join(", ") || "none"}; feed ${JSON.stringify(feedPost.reply)} against story ${JSON.stringify(storyPost.reply)}; counter "${storyText}")`);
    return slotFeed;
  };
  // DG11: the toggle in EVERY state the feed header can be in (Dev33: "toggle positioning in feed mode still seems to be broken"). Each state is put on the reader view (its fields, then its own redraw) and the
  // toggle is measured: its right edge must stay where the plain feed has it and it must sit inside the first row, vertically centred in it. States: unread-only; a chosen source; four choices (Sort & filter (4)); the choices open;
  // a long status; an error status; busy (loading); the Mentions tab with a long label; no list yet (first load); and, in the phone layout, a larger Obsidian font size (24 px).
  const statesPass = async (label, ref, font) => {
    const set = (fn) => page.evaluate((f) => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; new Function("v", f)(v); v.drawHeader(); v.drawBody?.(); }, fn);
    const where = () => page.evaluate(() => { const h = document.querySelector(".blyg-reader-header"); const row = h?.querySelector(".blyg-reader-bar"); const tg = h?.querySelector(".blyg-modeslot"); const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }; return tg && row ? { tg: R(tg), row: R(row), hsw: [h.scrollWidth, h.clientWidth], vw: window.innerWidth } : null; });
    const states = [
      ["plain feed", ""],
      ["unread only", `v.filter = { ...v.filter, unreadOnly: true }`],
      ["unread only, choices open", `v.filtersOpen = true`],
      ["source = one blyg, choices open", `v.filter = { ...v.filter, source: v.data.posts[0].subscriptionId }`],
      ["four choices, closed", `v.filtersOpen = false; v.filter = { ...v.filter, sort: "oldest", length: "short" }`],
      ["long status", `v.filter = { sort: "newest", source: null, unreadOnly: false, length: "any", repliesToMe: false }; v.status = "Checked 12 min ago, 3 new posts from 2 blygs and a very long extra remark about it"`],
      ["error status", `v.status = "The Studio could not be reached (HTTP 503). Trying again in 5 minutes."`],
      ["busy (loading)", `v.status = ""; v.busyCount = 1`],
      ["Mentions tab, long label", `v.busyCount = 0; v.tab = "mentions"`],
      ["no list yet (first load)", `v.tab = "stream"; v.data = null`],
    ];
    const bad = [];
    for (const [name, fn] of states) {
      if (fn) await set(fn);
      if (name.startsWith("Mentions")) await page.evaluate(() => { const b = [...document.querySelectorAll(".blyg-reader-header .blyg-reader-btn")].find((x) => /^Mentions/.test(x.textContent)); if (b) b.textContent = "Mentions (1234)"; });
      const w = await where();
      const same = w && ref && Math.abs(w.tg.r - ref.r) <= 1 && w.tg.l >= 0 && w.tg.r <= w.vw && w.tg.t >= w.row.t - 1 && w.tg.b <= w.row.b + 1 && Math.abs((w.tg.t + w.tg.b) / 2 - (w.row.t + w.row.b) / 2) <= 2 && (font || Math.abs(w.tg.t - ref.t) <= 1) && w.hsw[0] <= w.hsw[1];
      if (!same) bad.push(`${name}: ${JSON.stringify(w)}`);
    }
    check(bad.length === 0, `${label}: the Feed | Digest toggle stays at the right end of the first header row in all ${states.length} feed states${font ? " (Obsidian font size 24)" : ""}; ref right edge ${ref?.r}, top ${ref?.t}${bad.length ? `; MOVED: ${bad.join(" | ")}` : ""}`);
  };
  const widths = [[393, 852], [360, 780], [320, 700]];
  const refs = {};
  const deskRef = await layoutPass("desktop layout");
  await statesPass("desktop layout", deskRef, false);
  await s.phone();
  const cdp = await page.context().newCDPSession(page);
  if (process.env.E2E_CPU_THROTTLE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.E2E_CPU_THROTTLE) }); // (a slower machine, to try the timing: E2E_CPU_THROTTLE=4)
  for (const [w, h] of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1500);
    refs[w] = await layoutPass(`phone layout ${w} px`);
    await statesPass(`phone layout ${w} px`, refs[w], false);
  }
  // the feed with nothing to show (last: a reader that has held a list is not made empty again by a file): the toggle stays where the feed with a list had it, at each width
  await startWith([]);
  for (const [w, h] of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1500);
    const empty = await box(".blyg-reader-header .blyg-modeslot");
    await page.waitForFunction(() => document.querySelectorAll(".blyg-reader-card").length === 0, undefined, { timeout: 5000 }).catch(() => {});
    const cards = (await page.$$(".blyg-reader-card")).length;
    const dom = cards === 0 ? "" : ` ${await page.evaluate(() => JSON.stringify({ leaves: ["blyg-reader", "blyg-daily"].map((t) => `${t}:${window.app.workspace.getLeavesOfType(t).length}`), mode: window.app.plugins.plugins.blyg.settings.readerPane.mode, back: !!document.querySelector(".blyg-reader-header .blyg-reader-back"), texts: [...document.querySelectorAll(".blyg-reader-card")].map((c) => c.textContent.slice(0, 60)) }))}`;
    check(cards === 0 && empty && refs[w] && Math.abs(empty.r - refs[w].r) <= 1 && Math.abs(empty.t - refs[w].t) <= 2, `phone layout ${w} px: the empty feed has the toggle in the same slot as the feed with a list (${cards} cards${dom}; right edge ${empty?.r} against ${refs[w]?.r}; top ${empty?.t} against ${refs[w]?.t})`);
  }
  // a larger Obsidian font size (24 px), last because the setting stays in the vault: the toggle keeps the right end of the first row in every state, at the widest and the narrowest phone
  await page.evaluate(() => { window.app.vault.setConfig("baseFontSize", 24); window.app.vault.setConfig("baseFontSizeAction", true); window.app.updateFontSize?.(); });
  for (const [w, h] of [[393, 852], [320, 700]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1500);
    await startWith(posts);
    const big = await page.evaluate(() => { const r = document.querySelector(".blyg-reader-header .blyg-modeslot")?.getBoundingClientRect(); return r ? { r: r.right, t: r.top } : null; });
    await statesPass(`phone layout ${w} px`, big, true);
  }
  // ---- The quick menu (DG13): a long press with real touch events (CDP, phone layout) on a feed card, a post of the digest and a story card opens the menu; a scroll never does;
  // the release opens nothing; Mark read writes exactly one request. (Chromium emulation, not iOS.)
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const freeSockets = () => hung.splice(0).forEach((r) => r.socket?.destroy());
  freeSockets();
  await startWith(posts);
  await page.waitForSelector(".blyg-reader-card", { timeout: 30000 });
  const centre = (sel) => page.evaluate((q) => { const e = document.querySelector(q); const r = e?.getBoundingClientRect(); if (!r) return null; const x = Math.round(r.left + Math.min(r.width / 2, 120)), y = Math.round(r.top + Math.min(r.height / 2, 20)); return { x, y, hit: !!e.contains(document.elementFromPoint(x, y)) }; }, sel);
  const touch = async (sel, { hold = 650, drift = 0 } = {}) => {
    await page.evaluate((q) => document.querySelector(q)?.scrollIntoView({ block: "center" }), sel);
    await wait(600);
    // Environment noise, not part of what is tested: the CI machine has no keyring, so Obsidian floats a "Secrets are stored without encryption" toast over the
    // feed for a few seconds, and it can sit on the card under the finger. Dismiss any toast before measuring; every assertion below stays as it was.
    await page.evaluate(() => { for (const n of activeDocument.querySelectorAll(".notice-container .notice, .notice")) n.remove(); });
    const c = await centre(sel); // measured right before the finger goes down, and the finger must land on the element
    if (!c || !c.hit) { console.error("touch: nothing of", sel, "under", JSON.stringify(c), "found there:", JSON.stringify(c ? await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); const h = document.querySelector(".blyg-reader-header")?.getBoundingClientRect(); const k = document.querySelector(".blyg-reader-card")?.getBoundingClientRect(); return { tag: e?.tagName, cls: String(e?.className ?? "").slice(0, 80), text: (e?.textContent ?? "").slice(0, 40), hdrBottom: h?.bottom, cardTop: k?.top, fs: getComputedStyle(document.body).fontSize }; }, [c.x, c.y]) : null)); return false; }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c.x, y: c.y }] });
    if (drift) for (let i = 1; i <= 4; i++) { await wait(40); await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: c.x, y: c.y + (drift * i) / 4 }] }); }
    await wait(hold);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(500);
    return true;
  };
  const menu = () => page.evaluate(() => [...document.querySelectorAll(".menu .menu-item-title")].map((e) => e.textContent));
  const freshFeed = async () => { // the reader opened afresh (as startWith does), at its list
    await page.evaluate(() => window.app.workspace.detachLeavesOfType("blyg-reader"));
    await wait(500);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await page.waitForSelector(".blyg-reader-card", { timeout: 30000 });
    await wait(1500);
  };
  // a write waits for the Studio's capabilities first (after a reload): wait until the request arrived, then a little longer to count that no second one follows
  const settle = async (list, n) => { for (let i = 0; i < 50 && list.length < n; i++) { if (i % 5 === 0) freeSockets(); await wait(200); } await wait(1500); };
  const closeMenu = async () => { await page.keyboard.press("Escape"); await wait(300); };
  const opened = () => page.evaluate(() => !!document.querySelector(".blyg-reader-header .blyg-reader-back"));
  const pick = async (title) => {
    freeSockets(); await page.evaluate((t) => [...document.querySelectorAll(".menu .menu-item")].find((e) => e.querySelector(".menu-item-title")?.textContent === t)?.click?.(), title); await wait(1500); };


  const marked0 = marks.length;
  const others0 = others.length;
  await touch(".blyg-reader-card", { drift: 40 });
  check((await menu()).length === 0 && !(await opened()), "a press that moves (a scroll) opens no menu and no post");
  await touch(".blyg-reader-card", { hold: 200 });
  check((await menu()).length === 0 && (await opened()), "a short touch opens no menu: it is a tap and opens the post");
  await freshFeed();
  await touch(".blyg-reader-card");
  const feedMenu = await menu();
  check(JSON.stringify(feedMenu) === JSON.stringify(["Open", "Reply", "Mark read"]) && !(await opened()), `a long press on a feed card opens the menu (${JSON.stringify(feedMenu)}) and the release did not open the post`);
  check(marks.length === marked0 && others.length === others0, "opening the menu asked the Studio for nothing");
  await pick("Mark read");
  await settle(marks, marked0 + 1);
  check(marks.length === marked0 + 1, `Mark read in the feed's menu wrote exactly one request (${marks.length - marked0})`);
  await touch(".blyg-reader-card.is-read");
  const feedMenu2 = await menu();
  check(feedMenu2.includes("Mark unread") && !feedMenu2.includes("Mark read"), `the read card's menu says Mark unread (${JSON.stringify(feedMenu2)})`);
  const un0 = unmarks.length;
  await pick("Mark unread");
  await settle(unmarks, un0 + 1);
  check(unmarks.length === un0 + 1, `Mark unread wrote exactly one request (${unmarks.length - un0})`);
  await page.click(".blyg-reader-card", { button: "right" });
  await wait(500);
  check((await menu()).includes("Mark read") || (await menu()).includes("Mark unread"), "a right click on a feed card opens the same menu");
  await closeMenu();
  await touch(".blyg-reader-card");
  await pick("Open");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  check(true, "Open in the menu opens the post in the reader");
  await freshFeed();
  // the digest: a post of the Mixed bag and a story card
  await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-modebtn")].find((b) => b.textContent === "Digest").click());
  await page.waitForSelector(".blyg-daily .blyg-story-mixed", { timeout: 20000 });
  await wait(1200);
  const m1 = marks.length;
  await touch(".blyg-daily .blyg-story-mixed");
  const dm = await menu();
  check(JSON.stringify(dm) === JSON.stringify(["Open", "Reply", "Mark read"]) && !(await opened()), `a long press on a digest post opens the menu (${JSON.stringify(dm)}), the release opened nothing`);
  await pick("Mark read");
  await settle(marks, m1 + 1);
  check(marks.length === m1 + 1 && (await page.evaluate(() => document.querySelector(".blyg-daily .blyg-story-mixed")?.classList.contains("blyg-is-read"))), `Mark read in the digest wrote exactly one request and showed at once (${marks.length - m1})`);
  await touch(".blyg-daily .blyg-story .blyg-daily-meta");
  const sm = await menu();
  check(sm[0] === "Open first post" && /^Mark story (read|unread)$/.test(sm[1] ?? "") && sm.length === 2, `a long press on a story card offers Open first post and Mark story read (${JSON.stringify(sm)})`);
  await pick("Open first post");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  check(true, "Open first post opens the story's first post");
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
});
