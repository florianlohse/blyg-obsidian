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
  // a revised post: its change note is read lazily from the history route and leads the correction line (bold), the headline second; shown as text, not as markup
  await wait(1500);
  const corr = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".blyg-daily .blyg-daily-row")].find((r) => r.querySelector(".blyg-correction-note"));
    const lead = row?.querySelector(".blyg-correction-note");
    return { lead: lead?.textContent ?? "", weight: lead ? Number(getComputedStyle(lead).fontWeight) : 0, first: row?.firstElementChild === lead, head: row?.querySelector(".blyg-correction-headline")?.textContent ?? "", markup: !!lead?.querySelector("b") };
  });
  check(corr.lead === "Fixed the <b>March</b> total" && !corr.markup && corr.weight >= 600 && corr.first && /Trains were delayed/.test(corr.head), `a revised post's change note leads its correction line in bold, as plain text, the headline second (${JSON.stringify(corr)})`);
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
  await page.click(".blyg-daily .blyg-daily-member .blyg-daily-preview");
  await page.waitForSelector(".blyg-reader-header .blyg-reader-back", { timeout: 20000 });
  await wait(1500);
  // Next and Previous walk the story, and the counter names it
  const counter = () => page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-stepcount")?.textContent ?? "");
  const c1 = await counter();
  await page.click(".blyg-reader-header .blyg-reader-step-next");
  await wait(600);
  const c2 = await counter();
  await page.click(".blyg-reader-header .blyg-reader-step-prev");
  await wait(600);
  const c3 = await counter();
  check(/^Story: .+ · 1 of 2$/.test(c1) && /^Story: .+ · 2 of 2$/.test(c2) && c3 === c1, `Next and Previous walk the story: "${c1}", then "${c2}", then "${c3}"`);
  await page.click(".blyg-reader-header .blyg-reader-back");
  await page.waitForSelector(".view-content.blyg-daily .blyg-daily-member", { state: "attached", timeout: 20000 });
  await wait(1500);
  const back = await page.evaluate(() => ({ members: document.querySelectorAll(".blyg-daily .blyg-daily-member").length, top: document.querySelector(".view-content.blyg-daily")?.scrollTop ?? -1 }));
  check(back.members === 2 && Math.abs(back.top - set.top) <= 2, `Back from a post of an unfolded story: still unfolded (${back.members}) at the same place (${back.top} of ${set.top})`);
  await wait(3000);
  check(others.length === asked, `opening a post from the digest, stepping, and Back asked the Studio for nothing (${others.slice(asked).join(", ") || "0 requests"})`);
  const storyAt = marks.length;
  await page.click(".blyg-daily .blyg-story .blyg-mark");
  await wait(2500);
  const gaps = marks.slice(storyAt).map((m, i, a) => (i ? m.at - a[i - 1].at : Infinity)).slice(1);
  check(marks.length === storyAt + 2 && gaps.every((g) => g >= 300), `Mark story read: one request per unread post (${marks.length - storyAt}), spaced out (${gaps.join(", ")} ms)`);
  const storySym = await page.evaluate(() => document.querySelector(".blyg-daily .blyg-story .blyg-mark")?.getAttribute("aria-label"));
  check(storySym === "Mark story unread", `a story whose posts are all read shows the read symbol (${storySym})`);
  const unAt = unmarks.length;
  await page.click(".blyg-daily .blyg-story .blyg-mark");
  await wait(2500);
  const ugaps = unmarks.slice(unAt).map((m, i, a) => (i ? m.at - a[i - 1].at : Infinity)).slice(1);
  const storyAfter = await page.evaluate(() => ({ label: document.querySelector(".blyg-daily .blyg-story .blyg-mark")?.getAttribute("aria-label"), dim: document.querySelectorAll(".blyg-daily .blyg-story.blyg-is-read").length }));
  check(unmarks.length === unAt + 2 && ugaps.every((g) => g >= 300) && storyAfter.label === "Mark story read" && storyAfter.dim === 0, `tapping a read story marks every read post unread again: one request per post (${unmarks.length - unAt}), spaced out (${ugaps.join(", ")} ms), shown at once (${JSON.stringify(storyAfter)})`);
  const quiet0 = marks.length + unmarks.length;
  await wait(2500);
  check(marks.length + unmarks.length === quiet0, "no mark is repeated by itself after an undo");
  await page.click(".blyg-daily .blyg-story .blyg-mark"); // read again so the remaining checks see what they did before
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
  const cardLook = (theme) => page.evaluate(async (theme) => {
    if (theme) { document.body.classList.toggle("theme-dark", theme === "dark"); document.body.classList.toggle("theme-light", theme !== "dark"); await new Promise((r) => setTimeout(r, 400)); } // (Obsidian's own theme classes: all the variables follow them)
    const num = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lum = (c) => { const [r, g, b] = num(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const card = document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story");
    const bar = document.querySelector(".blyg-daily .blyg-daily-bar");
    const head = card.querySelector(".blyg-story-headline");
    const chev = card.querySelector(".blyg-story-chevron");
    const cs = getComputedStyle(card);
    const range = document.createRange(); range.selectNodeContents(head);
    const cr = card.getBoundingClientRect(); const vr = chev.getBoundingClientRect(); const tr = range.getBoundingClientRect();
    const v = document.querySelector(".view-content.blyg-daily");
    return { theme: document.body.classList.contains("theme-dark") ? "dark" : "light", bg: cs.backgroundColor, pageBg: getComputedStyle(bar).backgroundColor, border: cs.borderTopWidth, radius: parseFloat(cs.borderTopLeftRadius), contrast: +ratio(getComputedStyle(head).color, cs.backgroundColor).toFixed(1), chevIn: vr.left >= cr.left && vr.right <= cr.right && vr.top >= cr.top && vr.bottom <= cr.bottom, clear: tr.right <= vr.left + 1, icon: !!chev.querySelector("svg"), tap: Math.round(vr.height), sw: v.scrollWidth <= v.clientWidth };
  }, theme);
  const lookDark = await cardLook("dark");
  const lookLight = await cardLook("light");
  for (const c of [lookDark, lookLight]) check(c.bg !== c.pageBg && c.border === "1px" && c.radius >= 4 && c.contrast >= 4.5 && c.chevIn && c.clear && c.icon && c.tap >= 28 && c.sw, `a story is a card with a chevron in the ${c.theme} theme (${JSON.stringify(c)})`);
  const rot = async () => page.evaluate(async () => { await new Promise((r) => setTimeout(r, 350)); const c = document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story"); return { open: c.classList.contains("is-open"), tf: getComputedStyle(c.querySelector(".blyg-story-chevron svg")).transform, expanded: c.querySelector(".blyg-story-chevron").getAttribute("aria-expanded"), members: c.querySelectorAll(".blyg-daily-member").length }; });
  const chev0 = await rot(); // (a story may already be unfolded by an earlier step: the check is that each tap flips it and the chevron follows)
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-chevron").click());
  const flipped = await rot();
  await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-headline").click());
  const chev2 = await rot();
  const turned = (o) => (o.open ? /matrix\(-1, /.test(o.tf) : o.tf === "none" || o.tf === "matrix(1, 0, 0, 1, 0, 0)");
  check(chev0.open !== flipped.open && chev2.open === chev0.open && [chev0, flipped, chev2].every((o) => turned(o) && o.expanded === String(o.open) && (o.members > 0) === o.open), `the chevron unfolds and folds the story and turns with it; the headline does the same (${JSON.stringify([chev0, flipped, chev2])})`);
  if (chev0.open) await page.evaluate(() => document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story .blyg-story-chevron").click()); // leave it as the later steps found it (folded)
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
  const box = (sel) => page.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, w: r.width }; }, sel);
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
    await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-reader-btn")].find((b) => /^Mentions/.test(b.textContent ?? ""))?.click());
    await wait(500);
    const slotMentions = await box(".blyg-reader-header .blyg-modeslot");
    await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-header .blyg-reader-btn")].find((b) => b.textContent === "Reading")?.click());
    await wait(500);
    const verRect = await box(".blyg-reader-header .blyg-reader-version");
    const verClear = !verRect || !slotFeed || verRect.r <= slotFeed.l || verRect.l >= slotFeed.r || verRect.t >= slotFeed.t + 40;
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
    // (the emulated phone layout draws a 12 px scrollbar inside the digest's page; a device draws none: the right edge is read without it)
    const bar = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-daily"); return v ? v.offsetWidth - v.clientWidth : 0; });
    const cardFit = await page.evaluate(() => { const v = document.querySelector(".view-content.blyg-daily"); const c = document.querySelector(".blyg-daily .blyg-daily-cluster.blyg-story"); const ch = c?.querySelector(".blyg-story-chevron"); const h = c?.querySelector(".blyg-story-headline"); if (!c || !ch || !h) return null; const rg = document.createRange(); rg.selectNodeContents(h); const cr = c.getBoundingClientRect(), vr = ch.getBoundingClientRect(), tr = rg.getBoundingClientRect(); return { sw: v.scrollWidth <= v.clientWidth, inCard: vr.left >= cr.left && vr.right <= cr.right, clear: tr.right <= vr.left + 1, cardR: cr.right, vw: window.innerWidth }; });
    check(cardFit && cardFit.sw && cardFit.inCard && cardFit.clear && cardFit.cardR <= cardFit.vw, `${label}: a story card fits the screen, its chevron is inside it and no headline text runs under it (${JSON.stringify(cardFit)})`);
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
    check(slotFeed && slotMentions && slotDigest && near(slotFeed.r, slotMentions.r, 1) && near(slotFeed.t, slotMentions.t, 2) && near(slotFeed.r, slotDigest.r + bar, 1) && near(slotFeed.t, slotDigest.t, 2),
      `${label}: the Feed | Digest toggle is in one slot in the feed with a list (Sort & filter shown), the Mentions tab (none) and the digest (same right edge and the same top in the feed and in the digest, whatever the title wraps to; right edge ${slotFeed?.r}, ${slotMentions?.r}, ${slotDigest?.r}; top ${slotFeed?.t}, ${slotMentions?.t}, ${slotDigest?.t})`);
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
  for (const [w, h] of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1500);
    refs[w] = await layoutPass(`phone layout ${w} px`);
    await statesPass(`phone layout ${w} px`, refs[w], false);
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
    const c = await centre(sel); // measured right before the finger goes down, and the finger must land on the element
    if (!c || !c.hit) { console.error("touch: nothing of", sel, "under", JSON.stringify(c)); return false; }
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
  // leave nothing open: the post that "Open first post" opened would be restored with the layout, and its reply cards are ".blyg-reader-card" too (the empty-feed check below counts cards)
  await page.evaluate(() => { for (const t of ["blyg-reader", "blyg-daily"]) window.app.workspace.detachLeavesOfType(t); window.app.workspace.requestSaveLayout(); });
  await page.evaluate(async () => { const b = window.app.plugins.plugins.blyg; b.settings.readerPane.mode = "feed"; await b.saveSettings(); }); // (the digest steps left the mode on Digest; the checks below start from the Feed)
  await wait(1500);

  // the feed with nothing to show (last: a reader that has held a list is not made empty again by a file): the toggle stays where the feed with a list had it, at each width
  await startWith([]);
  for (const [w, h] of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1500);
    const empty = await box(".blyg-reader-header .blyg-modeslot");
    const cards = (await page.$$(".blyg-reader-card")).length;
    check(cards === 0 && empty && refs[w] && Math.abs(empty.r - refs[w].r) <= 1 && Math.abs(empty.t - refs[w].t) <= 2, `phone layout ${w} px: the empty feed has the toggle in the same slot as the feed with a list (${cards} cards; right edge ${empty?.r} against ${refs[w]?.r}; top ${empty?.t} against ${refs[w]?.t})`);
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
  check(errors.length === 0, `no error was thrown on the page ${errors.join(" | ")}`);
});
