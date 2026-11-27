// P12 / P1, "Send passage to note" (feature `passages`), in real Obsidian in the phone layout (Chromium emulation of Obsidian's mobile UI with touch events, NOT iOS) against a
// stand-in Studio: a passage is selected in the open post of a blyg you read, the dock appears under the post, one tap on "Send to note" opens the picker (it offers only the notes of the
// two chosen folders), a note and then a heading are chosen, and the one confirming tap writes the native quote (directive line, attached blockquote, blank line) at the end of that
// heading's section. The reader keeps its scroll position and its post; "Open note" lands on the empty line under the quote; a reaction typed there is the writer's own words. Also:
// recent destinations first, nothing offered while no folder is chosen (fail closed), and an unpublished fragment destination is asked about before anything is written.
// Not covered: iOS selection handles and the system edit menu (the selection here is made with the Selection API); see the PR's device steps.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/passage-send.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (scope) => `${b64({ typ: "at+jwt", alg: "RS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, scope })}.c2lnbmF0dXJl`;
const ID = "7c9wk2mhq0v3xj8tn5rzfd41bg";
const PARAS = Array.from({ length: 24 }, (_, i) => `Paragraph ${i} of the long post, with some words to fill a line or two of the reading surface.`);
PARAS[10] = "The point of copying a passage out by hand was never the copy. It was the minute spent deciding.";
const post = { subscriptionId: "s1", subscriptionTitle: "Example blyg", origin: "https://one.example.com/", remoteId: ID, kind: "fragment", withdrawn: false, version: 1, readVersion: 1, observedAt: new Date(Date.now() - 600e3).toISOString(), created: null, contentHtml: PARAS.map((p) => `<p>${p}</p>`).join(""), contentMd: PARAS.join("\n\n"), author: { name: "Author", url: null }, stubOf: null };
const state = { reads: [], writes: 0 };
const page = (items) => ({ items, page: { limit: 50, nextCursor: null } });
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  req.on("data", () => {});
  req.on("end", () => {
    const path = url.pathname;
    if (req.method !== "GET") state.writes++;
    if (path === "/blyg.json") return reply(res, 200, { blyg: "0.4", level: 2, generator: "blygger-studio/0.69.0", site: `http://127.0.0.1:${stub.address().port}/`, title: "Stand-in", items: "items/index.json" });
    if (path === "/api/capabilities") return reply(res, 200, { contractVersion: "6.2.0", endpoints: {}, extensions: [], operations: ["getCapabilities", "listItems", "listSubscriptions", "listReading", "listImportedReading", "getImported"] });
    if (path === `/api/imports/s1/${ID}`) { state.reads.push(path); return reply(res, 200, { id: ID, kind: "fragment", version: 1, state: "current", contentHtml: post.contentHtml }); }
    if (path === "/api/reading/imported") return reply(res, 200, page([post]));
    if (path === "/api/subscriptions/poll") return reply(res, 200, { polling: 0 });
    if (req.method === "GET" && path.startsWith("/api/")) return reply(res, 200, page([]));
    return reply(res, 404, { code: "not-found", message: "not found" });
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = fixtureData();
data.studio.baseUrl = base;
data.features = { passages: true }; // still experimental: off in the release flavour this harness loads unless switched on
data.passages = { folders: "Reading\nIdeas" };

const HABIT = "# On habit\nShort entries, every day.\n\n## Copying by hand\nA slow way.\n\n# Open questions\nDoes typing count?\n";
const QUOTE = `![[${ID} | Example blyg]]\n> The point of copying a passage out by hand was never the copy. It was the minute spent deciding.`;

await runScenario({ data }, async (s) => {
  const { check } = s;
  const pg = s.page;
  await pg.evaluate((t) => window.app.secretStorage.setSecret("smoke-studio", t), jwt("owner:read owner:draft owner:publish owner:manage reading:state"));
  await s.phone();
  const cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const eventually = async (fn, ms = 15000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await wait(250); v = await fn(); } return v; };
  const tap = async (selector, text) => {
    const c = await pg.evaluate(([sel, t]) => { const e = [...activeDocument.querySelectorAll(sel)].find((x) => t === undefined || (x.textContent ?? "").includes(t)); if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, [selector, text]);
    if (!c) return false;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [c] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(400);
    return true;
  };
  const noticeText = () => pg.evaluate(() => [...activeDocument.querySelectorAll(".notice")].map((n) => n.textContent ?? ""));
  const modal = () => pg.evaluate(() => { const m = activeDocument.querySelector(".blyg-passage-modal"); return m ? { text: m.textContent ?? "", rows: [...m.querySelectorAll(".blyg-passage-row .blyg-passage-name")].map((e) => e.textContent), groups: [...m.querySelectorAll(".blyg-passage-group")].map((e) => e.textContent), chips: [...m.querySelectorAll(".blyg-passage-chip")].map((e) => e.textContent), confirm: m.querySelector(".blyg-passage-confirm")?.textContent ?? null, confirmDisabled: m.querySelector(".blyg-passage-confirm")?.disabled ?? null, wide: m.scrollWidth > m.clientWidth + 1 } : null; });
  const selectPassage = (words) => pg.evaluate((w) => {
    const body = document.querySelector(".blyg-reader-surface .blyg-reader-body");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent.indexOf(w);
      if (at < 0) continue;
      n.parentElement.scrollIntoView({ block: "center" });
      const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + w.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return true;
    }
    return false;
  }, words);
  const scrollTop = () => pg.evaluate(() => document.querySelector(".blyg-reader-scroll")?.scrollTop ?? -1);
  const noteText = (path) => pg.evaluate((p) => window.app.vault.adapter.read(p), path);
  const SENT = "The point of copying a passage out by hand was never the copy. It was the minute spent deciding.";

  await s.createNote("Reading/Commonplace book.md", HABIT);
  await s.createNote("Reading/Essays/Nested note.md", "A note in a subfolder.\n");
  await s.createNote("Ideas/Slow reading.md", "Just a line with no heading.\n");
  await s.createNote("Private/Diary.md", "Not in a chosen folder.\n");
  await s.createNote("Blyg/Fragment 2026-11-26 0900.md", "A fragment of mine.\n");
  await s.createNote("Blyg/Fragment 2026-11-26 0901.md", "Another fragment of mine.\n");
  await pg.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.filter = { sort: "newest", source: null, unreadOnly: false, length: "any", repliesToMe: false }; });
  await pg.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
  await pg.waitForSelector(".blyg-reader-card", { timeout: 30000 });
  await eventually(() => pg.evaluate(() => !/Loading|updating|Checking/.test(document.querySelector(".blyg-reader-status")?.textContent ?? "")));
  await pg.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
  await pg.waitForSelector(".blyg-reader-surface .blyg-reader-body", { timeout: 15000 });
  check((await s.commandIds("blyg:send-passage")).length === 1, "the feature is on: the command “Send selected passage to a note” exists");
  check((await pg.evaluate(() => !document.querySelector(".blyg-passage-dock"))), "no dock while nothing is selected");

  // ---- select a passage: the dock appears at the foot, in the thumb zone; the post and the scroll position stay
  check(await selectPassage(SENT), "a passage is selected in the post (Selection API)");
  check(Boolean(await eventually(() => pg.evaluate(() => document.querySelector(".blyg-passage-dock .blyg-passage-dock-send")))), "the dock with “Send to note” appears");
  const shot = async (name) => { if (process.env.PASSAGE_SHOTS) await pg.screenshot({ path: `${process.env.PASSAGE_SHOTS}/${name}.png` }); };
  await shot("dock");
  const top1 = await scrollTop();
  const dock = await pg.evaluate(() => { const d = document.querySelector(".blyg-passage-dock"); const r = d.getBoundingClientRect(); const root = document.querySelector(".blyg-reader").getBoundingClientRect(); const b = d.querySelector(".blyg-passage-dock-send").getBoundingClientRect(); return { count: d.querySelector(".blyg-passage-dock-note")?.textContent, bottomGap: Math.round(root.bottom - r.bottom), clear: Math.round(parseFloat(getComputedStyle(document.querySelector(".blyg-reader")).paddingBottom)), btnH: Math.round(b.height), w: Math.round(r.width), vw: window.innerWidth }; });
  check(/\d+ selected characters/.test(dock.count ?? ""), `the dock says how many characters are selected (${dock.count})`);
  check(Math.abs(dock.bottomGap - dock.clear) <= 2 && dock.btnH >= 40 && dock.w <= dock.vw, `the dock is at the foot of the pane, just above Obsidian's own bottom bar, the button is at least 40 px high, nothing wider than the screen (${JSON.stringify(dock)})`);
  check(await pg.evaluate(() => { const n = document.querySelector(".mobile-navbar"); const d = document.querySelector(".blyg-passage-dock").getBoundingClientRect(); const r = n?.getBoundingClientRect(); return !r || n.offsetParent === null || d.bottom <= r.top + 1; }), "the dock is clear of Obsidian's own bottom bar, so a tap on Send lands on it");
  check(state.writes === 0 && state.reads.length === 0, "selecting asks nothing of the Studio and writes nothing");

  // ---- one tap on Send: the quotation is read first (so a post that cannot be quoted is said before the writer looks for a note), then the picker
  await tap(".blyg-passage-dock-send");
  check(Boolean(await eventually(() => modal())), "the picker opens after one tap");
  const m1 = await modal();
  await shot("picker");
  check(m1?.rows.includes("Commonplace book") && m1.rows.includes("Slow reading") && !m1.rows.includes("Diary"), `the picker offers the notes of both chosen folders and not the others (${JSON.stringify(m1?.rows)})`);
  // H: with subfolders under the chosen folders the notes are clustered by folder, under headings that carry the folder's path; hover and focus use the accent colour
  check(m1?.groups.includes("Reading/Essays") && m1.groups.includes("Reading") && m1.groups.includes("Ideas"), `the list is clustered by folder, the subfolder under its own heading (${JSON.stringify(m1?.groups)})`);
  const hoverCss = await pg.evaluate(() => { const st = [...document.styleSheets].flatMap((sh) => { try { return [...sh.cssRules]; } catch { return []; } }).flatMap((r) => (r instanceof CSSMediaRule ? [...r.cssRules] : [r])).map((r) => r.cssText ?? "").filter((t) => /blyg-passage-row(:hover|:focus-visible)/.test(t)); return st.some((t) => /:focus-visible/.test(t) && /interactive-accent/.test(t)) && st.some((t) => /:hover/.test(t) && /interactive-accent/.test(t)); });
  check(hoverCss, "the picker rows use the accent colour on hover and keyboard focus");
  check(JSON.stringify(m1?.chips) === JSON.stringify(["Reading", "Ideas"]), `the folder chips show the scope (${JSON.stringify(m1?.chips)})`);
  check(m1?.text.includes("The point of copying a passage out by hand") && !m1.wide, "the picker shows the passage and does not scroll sideways");
  check(state.reads.length === 1 && state.writes === 0, `the quotation was read once, nothing written yet (${state.reads.length} reads, ${state.writes} writes)`);
  check((await noteText("Reading/Commonplace book.md")) === HABIT, "no note has changed before the confirming tap");
  check((await scrollTop()) === top1, "the reader kept its reading position behind the picker");

  // ---- narrowing, then the note, then the heading
  await tap(".blyg-passage-chip", "Ideas");
  const m2 = await modal();
  check(m2?.rows.length === 1 && m2.rows[0] === "Slow reading", `the Ideas chip narrows the list (${JSON.stringify(m2?.rows)})`);
  await tap(".blyg-passage-chip", "Ideas");
  await tap(".blyg-passage-row", "Commonplace book");
  const m3 = await eventually(async () => { const m = await modal(); return m?.confirm ? m : null; });
  check(m3?.rows.join("|") === "On habit|Copying by hand|Open questions|End of note", `step 2 lists the headings in order and “End of note” (${JSON.stringify(m3?.rows)})`);
  check(m3?.confirmDisabled === true, "nothing is chosen yet: the confirm button is off");
  await tap(".blyg-passage-heading", "On habit");
  await shot("headings");
  const m4 = await modal();
  check(m4?.confirm === "Send under “On habit”" && m4.confirmDisabled === false, `a heading is chosen: ${m4?.confirm}`);
  check((await noteText("Reading/Commonplace book.md")) === HABIT, "still nothing written: choosing a heading is not the confirming tap");

  // ---- the confirming tap writes the native quote at the end of the section (sub-sections inside it), before the next heading
  await tap(".blyg-passage-confirm");
  const written = await eventually(async () => { const t = await noteText("Reading/Commonplace book.md"); return t !== HABIT ? t : null; });
  const expected = `# On habit\nShort entries, every day.\n\n## Copying by hand\nA slow way.\n\n${QUOTE}\n\n\n\n# Open questions\nDoes typing count?\n`;
  check(written === expected, `the note holds the quote at the end of “On habit”, directive and quote together, a blank line after (${JSON.stringify(written)})`);
  check((await noteText("Ideas/Slow reading.md")) === "Just a line with no heading.\n" && (await noteText("Private/Diary.md")) === "Not in a chosen folder.\n", "no other note was touched");
  check(state.writes === 0, "nothing was written to the Studio");
  const toast = await eventually(async () => (await noticeText()).find((t) => /Added to/.test(t)));
  check(Boolean(toast) && /Commonplace book/.test(toast) && /On habit/.test(toast) && /Open note/.test(toast), `the toast names the note and the heading and offers Open note (${toast})`);
  check((await scrollTop()) === top1 && (await pg.evaluate(() => !!document.querySelector(".blyg-reader-surface .blyg-reader-body"))), "the reader still shows the post at the same scroll position");
  check(await pg.evaluate(() => (getSelection()?.toString() ?? "") === "" && !document.querySelector(".blyg-passage-dock")), "the selection is cleared and the dock is gone");

  // ---- Open note lands on the empty line under the quote; the reaction typed there is the writer's own words
  await shot("toast");
  await tap(".blyg-passage-toast-open");
  const at = await eventually(() => pg.evaluate(() => { const f = window.app.workspace.getActiveFile(); const ed = window.app.workspace.activeEditor?.editor; return f?.path === "Reading/Commonplace book.md" && ed ? { line: ed.getCursor().line, text: ed.getLine(ed.getCursor().line), above: ed.getLine(ed.getCursor().line - 1), quote: ed.getLine(ed.getCursor().line - 2) } : null; }));
  check(Boolean(at) && at.text === "" && at.above === "" && at.quote.startsWith("> The point of copying"), `Open note puts the cursor on the empty line under the quote (${JSON.stringify(at)})`);
  check((await pg.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").length)) === 1, "the reader is still open underneath");
  await pg.evaluate(() => window.app.workspace.activeEditor.editor.replaceSelection("My reaction, in my own words."));
  const typed = (await eventually(async () => { const t = await noteText("Reading/Commonplace book.md"); return t.includes("My reaction") ? t : null; }, 10000)) ?? (await noteText("Reading/Commonplace book.md"));
  check(typed.includes(`> ${SENT}\n\nMy reaction, in my own words.`), `the reaction stands below the quote after a blank line (${JSON.stringify(typed)})`);

  // ---- closing and reopening the note: the pair is still there (nothing lives in the plugin's memory)
  await pg.evaluate(() => window.app.workspace.detachLeavesOfType("markdown"));
  await wait(500);
  check((await noteText("Reading/Commonplace book.md")).includes(QUOTE), "after the note is closed and read again the quote is in the file");

  // ---- recent destinations first
  await pg.evaluate(async () => { const l = window.app.workspace.getLeavesOfType("blyg-reader")[0]; if (l) { await window.app.workspace.revealLeaf(l); window.app.workspace.setActiveLeaf(l, { focus: true }); } });
  await wait(700);
  await pg.waitForSelector(".blyg-reader-surface .blyg-reader-body", { timeout: 15000 });
  await selectPassage(SENT);
  await eventually(() => pg.evaluate(() => document.querySelector(".blyg-passage-dock-send")));
  await tap(".blyg-passage-dock-send");
  await eventually(() => modal());
  const m5 = await modal();
  check(m5?.groups[0] === "Recent destinations" && m5.rows[0] === "Commonplace book", `the note just used is first, under “Recent destinations” (${JSON.stringify([m5?.groups, m5?.rows])})`);

  // ---- an unpublished fragment cannot hold a quote: asked before writing; converting is offered
  await pg.evaluate(() => { window.app.plugins.plugins.blyg.settings.passages.folders = "Reading\nIdeas\nBlyg"; });
  await pg.keyboard.press("Escape");
  await wait(300);
  await selectPassage(SENT);
  await eventually(() => pg.evaluate(() => document.querySelector(".blyg-passage-dock-send")));
  await tap(".blyg-passage-dock-send");
  await eventually(() => modal());
  await tap(".blyg-passage-row", "Fragment 2026-11-26 0900");
  const m6 = await eventually(async () => { const m = await modal(); return m?.text.includes("is a fragment") ? m : null; });
  check(Boolean(m6) && /cannot hold a quote/.test(m6.text) && /Convert it to a thread/.test(m6.text), "a fragment destination is explained before anything is written, with Convert and Pick another");
  check((await noteText("Blyg/Fragment 2026-11-26 0900.md")) === "A fragment of mine.\n", "the fragment is unchanged so far");
  await tap(".blyg-passage-actions button", "Convert it to a thread");
  await eventually(async () => (await modal())?.confirm);
  await tap(".blyg-passage-confirm");
  const conv = await eventually(async () => { const f = pg.evaluate(() => window.app.vault.getMarkdownFiles().find((x) => x.path.startsWith("Blyg/") && /^Thread/.test(x.basename))?.path); return await f; });
  check(Boolean(conv), `converting renamed the automatic name to Thread … (${conv})`);
  if (conv) {
    const t = await noteText(conv);
    check(/blyg_kind: thread/.test(t) && t.includes(QUOTE), `the note is a thread and holds the quote (${JSON.stringify(t)})`);
  }

  // ---- "Start a new thread with it": a fragment is not touched; a new thread opens with the quote and the cursor on the empty line under it
  await pg.evaluate(async () => { const l = window.app.workspace.getLeavesOfType("blyg-reader")[0]; if (l) { await window.app.workspace.revealLeaf(l); window.app.workspace.setActiveLeaf(l, { focus: true }); } });
  await wait(700);
  await pg.waitForSelector(".blyg-reader-surface .blyg-reader-body", { timeout: 15000 });
  await selectPassage(SENT);
  await eventually(() => pg.evaluate(() => document.querySelector(".blyg-passage-dock-send")));
  const threadsBefore = await pg.evaluate(() => window.app.vault.getMarkdownFiles().filter((x) => /^Blyg\/Thread/.test(x.path)).map((x) => x.path));
  await tap(".blyg-passage-dock-send");
  await eventually(() => modal());
  await tap(".blyg-passage-row", "Fragment 2026-11-26 0901");
  const m7 = await eventually(async () => { const m = await modal(); return m?.text.includes("is a fragment") ? m : null; });
  check(Boolean(m7) && /Start a new thread with it/.test(m7.text), "the fragment screen also offers “Start a new thread with it”");
  await tap(".blyg-passage-actions button", "Start a new thread with it");
  const fresh = await eventually(async () => pg.evaluate((before) => window.app.vault.getMarkdownFiles().map((x) => x.path).find((x) => /^Blyg\/Thread/.test(x) && !before.includes(x)), threadsBefore));
  const ft = fresh ? await noteText(fresh) : "";
  check(Boolean(fresh) && /blyg_kind: thread/.test(ft) && ft.includes(`${QUOTE}\n`), `a new thread is made holding the quote (${JSON.stringify(ft)})`);
  check((await noteText("Blyg/Fragment 2026-11-26 0901.md")) === "Another fragment of mine.\n", "the fragment is unchanged");
  const place = await eventually(() => pg.evaluate((p) => { const ed = window.app.workspace.activeEditor?.editor; return window.app.workspace.getActiveFile()?.path === p && ed ? { line: ed.getCursor().line, last: ed.lastLine(), text: ed.getLine(ed.getCursor().line), above: ed.getLine(ed.getCursor().line - 1) } : null; }, fresh));
  check(Boolean(place) && place.line === place.last && place.text === "" && place.above === "", `it is open for editing with the cursor on the empty line under the quote (${JSON.stringify(place)})`);
  check(Boolean(await eventually(async () => (await noticeText()).find((t) => /New thread “.*” made with the quote\. Not published/.test(t)))), "a notice says it is a new thread with the quote and not published");
  check(state.writes === 0, "nothing was sent to the Studio");

  // ---- no folder chosen: nothing is offered, nothing is written (fail closed)
  await pg.evaluate(async () => { const l = window.app.workspace.getLeavesOfType("blyg-reader")[0]; if (l) { await window.app.workspace.revealLeaf(l); window.app.workspace.setActiveLeaf(l, { focus: true }); } });
  await wait(700);
  await pg.waitForSelector(".blyg-reader-surface .blyg-reader-body", { timeout: 15000 });
  await wait(500);
  await selectPassage(SENT);
  await eventually(() => pg.evaluate(() => document.querySelector(".blyg-passage-dock-send")));
  await pg.evaluate(() => { window.app.plugins.plugins.blyg.settings.passages.folders = ""; }); // set last: the plugin re-reads data.json when it changes
  const before = await pg.evaluate(() => { const b = document.querySelector(".blyg-passage-dock-send"); const r = b?.getBoundingClientRect(); return { disabled: b?.disabled, note: document.querySelector(".blyg-passage-dock-note")?.textContent, rect: r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vh: innerHeight, nav: (() => { const n = document.querySelector(".mobile-navbar"); const r = n?.getBoundingClientRect(); return r && [Math.round(r.top), Math.round(r.height), getComputedStyle(n).display]; })(), pad: getComputedStyle(document.querySelector(".blyg-reader")).paddingBottom }; });
  await s.clearNotices();
  await tap(".blyg-passage-dock-send");
  const none = await eventually(async () => (await s.notices()).find((t) => /Choose folders for passages/.test(t)), 8000);
  check(Boolean(none) && !(await modal()), `with no folder chosen it says "Choose folders for passages first" and opens no picker (${none ?? JSON.stringify({ before, notices: await s.notices(), folders: await pg.evaluate(() => window.app.plugins.plugins.blyg.settings.passages.folders), dock: await pg.evaluate(() => !!document.querySelector(".blyg-passage-dock-send")), sel: await pg.evaluate(() => getSelection()?.toString().length), active: await pg.evaluate(() => window.app.workspace.activeLeaf?.view?.getViewType?.()) })})`);
});
