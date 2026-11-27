// The Daily on a SECOND device whose first open comes BEFORE Obsidian Sync has delivered the first device's edition (DG21). In real Obsidian: no sync state at all, the Daily is opened,
// shows the plain digest labelled "Checking for your other devices…" and makes/writes NO edition of its own; then the other device's key arrives in data.json (written the way Sync drops it)
// and the SAME page shows THAT edition ("Synced from 2 devices"), with no page ever showing a headline that is not the other device's, no own key written over it, and no AI request.
// NOT two real devices and not a real sync service.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/daily-sync-late.mjs
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
    // DG19 / one editor: an edition an earlier version wrote in a named voice ("crossword-setter") shows no editor line and no name any more
    f.regs.editor = reg(3, "crossword-setter");
    f.regs[`usage/${FOREIGN}`] = reg(4, { tokens: 14200, cost: 0.0412 });
    f.regs["usage/e2esecond"] = { c: 4, d: "e2esecond", v: { tokens: 9000, cost: 0.02 } };
    return f;
  };
  const writeForeign = (f) => ad(([p, json]) => window.app.vault.adapter.write(p, json), [`${DIR}/ed-${cutoff}.${FOREIGN}.json`, JSON.stringify(f)]);
  const heads = (suffix) => [0, 1, 2, 3].map((k) => `Foreign headline ${k}${suffix}`);
  const DATA = ".obsidian/plugins/blyg/data.json";
  const KEY = "digestSync_" + FOREIGN;
  const readData = () => ad(async (p) => JSON.parse(await window.app.vault.adapter.read(p)), DATA);
  const syncKeys = async () => Object.keys(await readData()).filter((k) => k.startsWith("digestSync_"));
  const strip = async () => ad(async (p) => { const a = window.app.vault.adapter; const d = JSON.parse(await a.read(p)); for (const k of Object.keys(d)) if (k.startsWith("digestSync_")) delete d[k]; await a.write(p, JSON.stringify(d)); }, DATA);
  await strip(); // a device Sync has not reached yet
  await s.resetWorkspace();

  // sample the page every 100 ms from the open on: every headline that ever shows must be the other device's
  await ad(() => { window.__heads = new Set(); window.__texts = []; window.__tick = setInterval(() => { const v = document.querySelector(".view-content.blyg-daily"); if (!v) return; v.querySelectorAll(".blyg-story-headline").forEach((e) => window.__heads.add(e.textContent)); window.__texts.push(document.querySelector(".blyg-daily-sync")?.textContent ?? ""); }, 100); });
  await ad(() => window.app.commands.executeCommandById("blyg:open-daily"));
  await s.pollUntil("the page", () => ad(() => document.querySelector(".blyg-daily .blyg-daily-sync")?.textContent ?? ""), (t) => /Checking for your other devices/.test(t), 15000).then((r) => check(r.ok, "the first open shows 'Checking for your other devices…' under the masthead"));
  const own = await syncKeys();
  check(own.length === 0, `while checking, this device wrote no edition key into data.json (${JSON.stringify(own)})`);
  await ad(() => { window.__page = document.querySelector(".view-content.blyg-daily"); });
  await wait(1500);

  // Sync delivers the other device's key (the whole key, the rest of the file untouched)
  const f = foreign(heads(""), "");
  const payload = { v: 1, device: FOREIGN, label: "", at: Date.now(), editions: [f] };
  await ad(async ([p, k, v]) => { const a = window.app.vault.adapter; const d = JSON.parse(await a.read(p)); d[k] = v; await a.write(p, JSON.stringify(d)); }, [DATA, KEY, payload]);
  const got = await s.pollUntil("the other device's headlines", () => ad(() => document.querySelector(".view-content.blyg-daily")?.innerText ?? ""), (t) => /Foreign headline 0/.test(t) && /Foreign headline 3/.test(t), 30000);
  check(got.ok, "the open Daily shows the other device's edition once its key has arrived, without a tap");
  const end = await ad(() => { clearInterval(window.__tick); return { heads: [...window.__heads], sync: document.querySelector(".blyg-daily-sync")?.textContent ?? "", same: window.__page === document.querySelector(".view-content.blyg-daily"), lines: [...new Set(window.__texts)] }; });
  check(end.heads.every((h) => /^Foreign headline \d$/.test(h) || /^Alpha /.test(h)), `every headline on the page was the plain digest's or the other device's, never a locally written one (${JSON.stringify(end.heads)})`);
  check(/^Synced from 2 devices$/.test(end.sync.trim()), `the masthead then says "Synced from 2 devices" (${JSON.stringify(end.sync)}; lines seen: ${JSON.stringify(end.lines)})`);
  check(end.same, "... in the same page (the leaf was not reopened)");
  const keys = await syncKeys();
  check(keys.length === 1 && keys[0] === KEY, `this device wrote no edition of its own over it (${JSON.stringify(keys)})`);
  check(llm.length === 0, `no AI request (${llm.length})`);
  check(errors.length === 0, `no error on the page (${JSON.stringify(errors.slice(0, 2))})`);

  // ---- fail open: with nothing arriving the device makes its own edition after the bound (a single-device user waits at most that long, once)
  await s.resetWorkspace();
  await strip();
  await ad(async (d) => { for (const f of (await window.app.vault.adapter.list(d).catch(() => ({ files: [] }))).files) await window.app.vault.adapter.remove(f); }, DIR);
  await ad(() => window.app.commands.executeCommandById("blyg:open-daily"));
  await s.pollUntil("the page", () => ad(() => document.querySelector(".blyg-daily .blyg-daily-sync")?.textContent ?? ""), (t) => /Checking for your other devices/.test(t), 15000);
  const made = await s.pollUntil("an own key after the bound", async () => (await syncKeys()).length, (n) => n >= 1, 30000);
  check(made.ok, "nothing arrived: after the bound the device makes and writes its own edition");
  await s.pollUntil("the label gone", () => ad(() => document.querySelector(".blyg-daily-sync")?.textContent ?? ""), (t) => !/Checking/.test(t), 15000).then((r) => check(r.ok, "... and the 'Checking' line goes away"));

  // ---- end state
  await s.resetWorkspace();
  await strip();
  await ad(async (d) => { for (const f of (await window.app.vault.adapter.list(d).catch(() => ({ files: [] }))).files) await window.app.vault.adapter.remove(f); }, DIR);
});
