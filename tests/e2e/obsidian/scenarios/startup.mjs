// Starting Obsidian with the reader open must cost Obsidian's start nothing it can feel (decision of 2026-11-16: "zero impact on Obsidian startup speed").
// Obsidian waits for a restored view to finish opening before it finishes restoring its layout, so nothing the reader does may be waited for there: the
// view opens as an empty shell, and the saved list, the drawing and the Studio come after the layout is ready, when the app is idle, a first screenful at a time.
//
// The Studio here is a stand-in that answers every request only after 6 seconds, which is what made the old code take 6.4 s to get ready. The saved list holds
// 200 posts. The app is restarted (`app:reload`) with the reader tab open, and read back: when the layout was ready, how many cards were built, and the longest
// stall of the main thread in the seconds after. Numbers are printed; the limits are loose (a shared CI runner is slow and noisy), so they catch a regression
// of kind (waiting for the network, building the whole list), not of a few milliseconds.
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/startup.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const stub = http.createServer((req, res) => {
  setTimeout(() => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); }, 6000);
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;

await runScenario({ data }, async (s) => {
  const { check } = s;
  const page = s.page;

  // 200 saved posts, a few kilobytes each, as a session that read a lot would have left behind
  const para = (i, j) => `<p>Paragraph ${j} of post ${i}. ${"The quick brown fox jumps over the lazy dog while a reader scrolls past. ".repeat(4)}<a href="https://example.com/${i}/${j}">a link</a> and <em>emphasis</em>.</p>`;
  const id = (i) => `0123456789abcdefghjkmnpqrstvwxyz`.slice(0, 6) + String(i).padStart(20, "0");
  const posts = Array.from({ length: 200 }, (_, i) => ({
    subscriptionId: `s${i % 8}`, subscriptionTitle: `Blog ${i % 8}`, origin: `https://blog${i % 8}.example/`, remoteId: id(i), kind: i % 5 === 0 ? "thread" : "fragment", withdrawn: false,
    version: 1, readVersion: i % 3 === 0 ? 1 : null, observedAt: new Date(Date.now() - i * 3600e3).toISOString(), created: new Date(Date.now() - i * 3600e3).toISOString(),
    authorName: `Author ${i % 8}`, authorUrl: null, sourceUrl: `https://blog${i % 8}.example/f/${id(i)}/`, contentHtml: [1, 2, 3, 4, 5, 6].map((j) => para(i, j)).join(""), contentMd: "",
  }));
  await page.evaluate((json) => window.app.vault.adapter.write(".obsidian/plugins/blyg/reader-cache.json", json), JSON.stringify({ v: 1, origin: `${base}/`, savedAt: Date.now(), posts, mentions: [] }));

  // read back after every start of the page: when the layout was ready, when the first card appeared, and the stalls of the main thread
  await page.addInitScript(() => {
    window.__lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch { /* none */ }
    const poll = setInterval(() => {
      if (!window.__ready && window.app?.workspace?.layoutReady) window.__ready = Math.round(performance.now());
      if (!window.__cards && document.querySelector(".blyg-reader-card")) window.__cards = Math.round(performance.now());
      if (window.__ready && performance.now() > 30000) clearInterval(poll);
    }, 5);
  });

  // the reader tab open, and the layout saved with it
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
  await page.waitForSelector(".blyg-reader-card", { timeout: 30000 });
  await page.evaluate(() => window.app.workspace.requestSaveLayout());
  await wait(3000);

  // the restart
  await page.evaluate(() => window.app.commands.executeCommandById("app:reload")).catch(() => {});
  await wait(1500);
  await page.waitForFunction(() => window.__ready, undefined, { timeout: 90000, polling: 50 });
  await wait(8000);
  const r = await page.evaluate(() => ({
    ready: window.__ready, cards: window.__cards ?? null, lt: window.__lt, built: document.querySelectorAll(".blyg-reader-card").length,
    more: !!document.querySelector(".blyg-reader-more"), plugin: !!window.app.plugins.plugins.blyg,
  }));
  const after = r.lt.filter(([t]) => t > r.ready && t <= r.ready + 8000);
  const longest = Math.max(0, ...after.map(([, d]) => d));
  const total = after.reduce((a, [, d]) => a + d, 0);
  console.log(`startup: layout ready at ${r.ready} ms, first card at ${r.cards ?? "never"} ms, ${r.built} cards built of 200, stalls after ready: ${after.length} (longest ${longest} ms, total ${total} ms)`);

  check(r.plugin, "startup: the plugin loaded with the reader open");
  check(r.ready < 3500, `startup: Obsidian's layout is ready at ${r.ready} ms although the Studio answers only after 6 s (the old reader made it wait for the Studio: 6.4 s)`);
  check(r.cards !== null, "startup: the saved list is shown, behind the layout");
  check(r.built <= 40 && r.more, `startup: only a first screenful of the 200 saved posts is built (${r.built} cards), the rest comes as you scroll`);
  check(longest < 250, `startup: no stall of the main thread over 250 ms after the layout is ready (longest ${longest} ms)`);

  // and the rest of the list is there when asked for
  await page.evaluate(() => document.querySelector(".blyg-reader-more button")?.click());
  await wait(500);
  const more = await page.evaluate(() => document.querySelectorAll(".blyg-reader-card").length);
  check(more > r.built, `startup: "Show more posts" adds cards (${r.built} → ${more})`);
});
stub.close();
