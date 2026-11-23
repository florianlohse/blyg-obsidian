// The Daily (digest) page opens in real Obsidian and is not blank: from a saved list, on first open, again after a restart (`app:reload`) with the edition record
// the first open left behind, and with sections, bylines and AI lines already in that record (the AI layer is off here, so they are read but not drawn). Reads the page's text, the errors on the page, and that nothing scrolls sideways.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/daily.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const stub = http.createServer((req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); });
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
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
});
