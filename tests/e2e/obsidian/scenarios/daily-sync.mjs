// The Daily on a second device (DG16), in real Obsidian: another device's edition file is put into the plugin's synced folder BEFORE the Daily is opened, and the Daily
// shows THAT edition: its story headlines (the other device's AI texts), its sections and bylines, "made on <the other device>", no second edition record of this device,
// and no AI request (automatic writing is on, with consent and a key, and still nothing is sent: the texts are already there). Then the foreign file is changed while the Daily is open
// and the page redraws by itself, without a tap and without a request to the Studio or the AI. The end state is reset (the folder emptied, no leaf open).
// NOT two real devices and not a real sync service: one Obsidian, a file written the way a sync service would drop it.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/daily-sync.mjs
import http from "node:http";
import { STUDIO, TOKEN, fixtureData, runScenario, wait } from "../lib.mjs";

const others = []; // every request that reaches the stand-in Studio besides the saved-list reads (which are never answered)
const hung = [];
const stub = http.createServer((req, res) => {
  if (req.method === "GET" && /\/api\/(reading|mentions)(\?|$)/.test(req.url ?? "")) { req.resume(); hung.push(res); return; } // no answer: the saved list stays
  others.push(`${req.method} ${req.url}`);
  const up = http.request(`${STUDIO}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(STUDIO).host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); });
  req.pipe(up);
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;
data.features = { daily: true, "digest-ai": true };
data.digest = { useAi: true, endpoint: "https://llm.example.invalid", model: "test-model", keySecretName: "llm-key", dailyTokenCeiling: 2000000, autoWrite: true, time: "07:00" };

const DIR = ".obsidian/plugins/blyg/digest";
const FOREIGN = "e2eforeign";

await runScenario({ data }, async (s) => {
  const { check } = s;
  const page = s.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  const llm = [];
  page.on("request", (r) => { if (/llm\.example\.invalid/.test(r.url())) llm.push(r.url()); });
  const id = (c, i) => `${c}${String(i).padStart(25, "0")}`.slice(0, 26);
  const mk = (i, text, who, over = {}) => ({
    subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: id("p", i), kind: "fragment", withdrawn: false, version: 1, readVersion: null,
    observedAt: new Date(Date.now() - (i + 1) * 60e3).toISOString(), created: null, isReply: false, stubTarget: null, authorName: who, authorUrl: null, sourceUrl: null,
    contentHtml: `<p>${text}</p>`, contentMd: "", ...over,
  });
  const posts = [];
  ["harbour tide lantern", "orchard cider press", "glacier survey drone", "market ledger tariff"].forEach((t, k) => {
    const a = mk(k * 2, `Alpha ${t} story body number ${k} for the day.`, `Lead${k}`);
    posts.push(a, mk(k * 2 + 1, `Reply on ${t} story body ${k}.`, `Rep${k}`, { isReply: true, stubTarget: { origin: "https://one.example.com/", id: a.remoteId } }));
  });
  posts.push(mk(20, "Mushrooms grow quietly under old oak trees.", "Cy"));
  const ad = (fn, ...args) => page.evaluate(fn, ...args);
  await ad((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/reader-cache.json", json), JSON.stringify({ v: 1, origin: `${base}/`, savedAt: Date.now(), posts, mentions: [] }));
  // consent for the provider's host and a key: an automatic write WOULD be sent if the edition had no texts yet
  await ad(() => window.app.secretStorage.setSecret("llm-key", "not-a-real-key"));
  await ad((t) => window.app.secretStorage.setSecret("smoke-studio", t), TOKEN);
  await ad((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/digest-ai.json", json), JSON.stringify({ v: 1, entries: {}, trail: [], consent: { host: "llm.example.invalid", model: "test-model", at: Date.now() }, tally: null, sections: {} }));
  await ad(async (d) => { for (const f of (await window.app.vault.adapter.list(d).catch(() => ({ files: [] }))).files) await window.app.vault.adapter.remove(f); }, DIR);
  await s.clearNotices();
  await wait(800);

  // the other device's edition: the cutoff the Daily would use now (07:00, this clock), four stories with the other device's texts, sections and a byline
  const cutoff = await ad(() => { const n = new Date(); const t = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 7, 0).getTime(); return t <= n.getTime() ? t : t - 24 * 3600e3; });
  const reg = (c, v) => ({ c, d: FOREIGN, v });
  const foreign = (headlines, about) => {
    const f = { v: 2, id: cutoff, device: FOREIGN, label: "Test iPad", at: Date.now(), created: { at: cutoff, d: FOREIGN }, posts: {}, regs: {}, clock: about === "" ? 5 : 6 };
    for (const p of posts) f.posts[p.remoteId] = cutoff + 1000;
    for (let k = 0; k < 4; k++) {
      const key = `fk${k}|3|test-model`;
      f.regs[`story/sf${k}`] = reg(1, 1);
      f.regs[`place/${id("p", k * 2)}`] = reg(1, `sf${k}`);
      f.regs[`place/${id("p", k * 2 + 1)}`] = reg(1, `sf${k}`);
      f.regs[`sec/sf${k}`] = reg(2, k % 2 ? "Town" : "Garden");
      f.regs[`txt/sf${k}`] = reg(3, { key, posts: [id("p", k * 2), id("p", k * 2 + 1)] });
      f.regs[`ai/${key}`] = reg(about === "" ? 3 : 4, { headline: headlines[k], summary: `Summary written on the other device ${k}.`, at: Date.now(), posts: 2 });
    }
    f.regs[`place/${id("p", 20)}`] = reg(1, "");
    f.regs.order = reg(2, ["Garden", "Town"]);
    f.regs["about/Garden"] = reg(about === "" ? 2 : 5, about || "Soil and seeds");
    f.regs.auto = reg(3, {});
    return f;
  };
  const writeForeign = (f) => ad(([p, json]) => window.app.vault.adapter.write(p, json), [`${DIR}/ed-${cutoff}.${FOREIGN}.json`, JSON.stringify(f)]);
  const heads = (suffix) => [0, 1, 2, 3].map((k) => `Foreign headline ${k}${suffix}`);
  await ad((d) => window.app.vault.adapter.mkdir(d).catch(() => {}), DIR);
  await writeForeign(foreign(heads(""), ""));
  await wait(500);

  // ---- 1. the Daily opens on THAT edition
  await s.resetWorkspace();
  await ad(() => window.app.commands.executeCommandById("blyg:open-daily"));
  await s.waitCount(".blyg-daily .blyg-story-headline", (n) => n >= 4, 30000);
  await s.pollUntil("the other device's headlines", () => ad(() => document.querySelector(".view-content.blyg-daily")?.innerText ?? ""), (t) => /Foreign headline 0/.test(t) && /Foreign headline 3/.test(t), 30000);
  const first = await ad(() => {
    const v = document.querySelector(".view-content.blyg-daily");
    return { text: v?.innerText ?? "", heads: [...v.querySelectorAll(".blyg-story-headline")].map((e) => e.textContent), sync: document.querySelector(".blyg-daily-sync")?.textContent ?? "" };
  });
  check([0, 1, 2, 3].every((k) => first.heads.includes(`Foreign headline ${k}`)), `the Daily shows the other device's four story headlines (${JSON.stringify(first.heads)})`);
  check(/Soil and seeds/.test(first.text) && /Garden/.test(first.text) && /Town/.test(first.text), `... under the sections and the byline of the other device's file`);
  check(/made on Test iPad/.test(first.sync) && /Synced from 1 device/.test(first.sync), `the masthead line says where it was made and that it is synced (${JSON.stringify(first.sync)})`);
  await wait(2500); // an automatic write, if it were going to happen, has started by now
  const files = await ad(async (d) => (await window.app.vault.adapter.list(d)).files, DIR);
  check(files.length === 1 && files[0].endsWith(`ed-${cutoff}.${FOREIGN}.json`), `no second edition was made: the folder holds the one file of the other device (${JSON.stringify(files)})`);
  check(llm.length === 0, `no AI request, although the automatic write is on and consent and a key are there: the texts were already in the file (${llm.length})`);
  check(!others.some((r) => /^(PUT|POST|DELETE|PATCH)/.test(r)), `no write to the Studio (${JSON.stringify(others.filter((r) => /^(PUT|POST|DELETE|PATCH)/.test(r)))})`);

  // ---- 2. the other device's file changes while the Daily is open: the page follows, by itself
  await s.clearNotices();
  const before = await ad(() => { window.__sync = document.querySelector(".view-content.blyg-daily"); return document.querySelectorAll(".blyg-daily .blyg-story-headline").length; });
  // what Obsidian reports about the folder, so that a failure says what happened (the "raw" event is not in Obsidian's typed API)
  await ad((d) => { window.__rawSeen = []; window.__rawRef = window.app.vault.on("raw", (p) => window.__rawSeen.push(`${Date.now()} ${p}`)); window.__dir = d; }, DIR);
  const wroteAt = Date.now();
  await writeForeign(foreign(heads(" (updated)"), "Soil, seeds and rain"));
  const followed = await s.pollUntil("the page to follow the changed file", () => ad(() => document.querySelector(".view-content.blyg-daily")?.innerText ?? ""), (t) => /Foreign headline 0 \(updated\)/.test(t) && /Soil, seeds and rain/.test(t), 45000); // the "raw" event or the app coming to the front normally says so at once; the page's own fallback re-read is every 30 s
  const diag = await ad(async (d) => {
    const st = await window.app.vault.adapter.stat(d);
    const files = await window.app.vault.adapter.list(d);
    const stats = await Promise.all(files.files.map(async (f) => `${f} ${JSON.stringify(await window.app.vault.adapter.stat(f))}`));
    const leaf = window.app.workspace.getLeavesOfType("blyg-daily")[0];
    return { raw: window.__rawSeen, dir: st, files: stats, visibility: document.visibilityState, hasLeaf: !!leaf, text: (document.querySelector(".view-content.blyg-daily")?.innerText ?? "").slice(0, 400) };
  }, DIR);
  await ad(() => window.app.vault.offref(window.__rawRef));
  console.error(`  (sync diagnostics: wrote at ${wroteAt}; ${JSON.stringify(diag)})`);
  check(followed.ok, `the open Daily shows the changed headlines and byline without a tap (raw events seen: ${JSON.stringify(diag.raw)}; files: ${JSON.stringify(diag.files)}; visibility: ${diag.visibility})`);
  const after = await ad(() => ({ same: window.__sync === document.querySelector(".view-content.blyg-daily"), n: document.querySelectorAll(".blyg-daily .blyg-story-headline").length }));
  check(after.same && after.n === before, `... in the same page, with the same number of stories (${before} -> ${after.n})`);
  await wait(1500);
  check(llm.length === 0 && !others.some((r) => /^(PUT|POST|DELETE|PATCH)/.test(r)), `the redraw asked nothing of the AI or the Studio (${llm.length} AI requests)`);
  check(errors.length === 0, `no error on the page (${JSON.stringify(errors.slice(0, 2))})`);

  // ---- end state
  await s.resetWorkspace();
  await ad(async (d) => { for (const f of (await window.app.vault.adapter.list(d)).files) await window.app.vault.adapter.remove(f); }, DIR);
  const left = await ad(async (d) => (await window.app.vault.adapter.list(d)).files.length, DIR);
  check(left === 0, `the end state is reset: the synced folder is empty (${left})`);
});
