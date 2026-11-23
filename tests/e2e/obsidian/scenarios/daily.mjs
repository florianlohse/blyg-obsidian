// The Daily (digest) page opens in real Obsidian and is not blank: from a saved list, on first open, again after a restart (`app:reload`) with the edition record
// the first open left behind, and with sections, bylines and AI lines already in that record (the AI layer is off here, so they are read but not drawn). Reads the page's text, the errors on the page, and that nothing scrolls sideways.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/daily.mjs
import http from "node:http";
import { STUDIO, TOKEN, fixtureData, runScenario, wait } from "../lib.mjs";

// A stand-in Studio: everything is refused (503) except a read mark, which is counted with its time (the digest's "Mark read" must be one request per unread post, spaced out, and none by itself).
const marks = [];
const stub = http.createServer((req, res) => {
  if (req.method === "PUT" && /\/reading\/[^/]+\/[^/]+\/read$/.test(req.url ?? "")) {
    marks.push({ at: Date.now(), path: req.url });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ readVersion: 1 }));
  }
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
  posts.push(mk(20, "Mushrooms grow quietly under old oak trees. https://example.com/" + "a".repeat(120), "Cy"), mk(21, "Trains were delayed again today. And more.", "Di"));
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
  const rec = JSON.parse(await page.evaluate(() => window.app.vault.adapter.read(".obsidian/plugins/blyg/digest-editions.json")));
  const e = rec.editions.at(-1);
  e.stories.forEach((st, i) => (st.section = i % 2 ? "Town" : "Garden"));
  e.sections = ["Garden", "Town"];
  e.sectionAbout = { Garden: "Soil and seeds" };
  e.postSections = { [id("p", 20)]: "Garden", [id("p", 21)]: "Town" };
  e.postLines = { [id("p", 20)]: "Cy on old oak mushrooms" };
  await page.evaluate((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/digest-editions.json", json), JSON.stringify(rec));
  await page.evaluate(() => window.app.workspace.requestSaveLayout());
  await wait(2000);
  await page.evaluate(() => window.app.commands.executeCommandById("app:reload")).catch(() => {});
  await wait(2500);
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, undefined, { timeout: 90000 });
  const second = await open();
  check(/your digest/i.test(second.text) && second.rows > 0, "the digest page has content after a restart, with sections and lines in the record");

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
  const before = marks.length;
  await page.click(".blyg-daily .blyg-story-mixed .blyg-mark");
  await wait(1500);
  const afterOne = await page.evaluate(() => ({ dim: document.querySelectorAll(".blyg-daily .blyg-story-mixed.blyg-is-read").length, buttons: document.querySelectorAll(".blyg-daily .blyg-story-mixed .blyg-mark").length, status: document.querySelector(".blyg-daily-markstatus")?.textContent ?? "" }));
  check(marks.length === before + 1 && afterOne.dim === 1 && afterOne.buttons === 1, `Mark read on a single post: one request, dimmed at once, its button gone (${marks.length - before} request, ${JSON.stringify(afterOne)})`);
  // an unfolded story: a tap on the preview text (not the name) opens the post; Back returns with the story still unfolded and the page where it was
  await page.click(".blyg-daily .blyg-story-headline");
  await wait(300);
  const members = await page.evaluate(() => document.querySelectorAll(".blyg-daily .blyg-daily-member").length);
  check(members === 2, `a story unfolds into its posts (${members})`);
  const set = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-daily"); const max = v.scrollHeight - v.clientHeight; v.scrollTop = Math.min(max, 120); return { top: v.scrollTop, max }; });
  await wait(300);
  await page.click(".blyg-daily .blyg-daily-member .blyg-daily-preview");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  await wait(800);
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-daily-member", { state: "attached", timeout: 20000 });
  await wait(1500);
  const back = await page.evaluate(() => ({ members: document.querySelectorAll(".blyg-daily .blyg-daily-member").length, top: document.querySelector(".view-content.blyg-daily")?.scrollTop ?? -1 }));
  check(back.members === 2 && Math.abs(back.top - set.top) <= 2, `Back from a post of an unfolded story: still unfolded (${back.members}) at the same place (${back.top} of ${set.top})`);
  const storyAt = marks.length;
  await page.click(".blyg-daily .blyg-story .blyg-mark");
  await wait(2500);
  const gaps = marks.slice(storyAt).map((m, i, a) => (i ? m.at - a[i - 1].at : Infinity)).slice(1);
  check(marks.length === storyAt + 2 && gaps.every((g) => g >= 300), `Mark story read: one request per unread post (${marks.length - storyAt}), spaced out (${gaps.join(", ")} ms)`);
  const quiet = marks.length;
  await wait(3000);
  check(marks.length === quiet, "nothing is marked again by itself");
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
});
