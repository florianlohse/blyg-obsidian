// P12 / P2, "Draft selection as fragment / thread" (feature `passages`), in real Obsidian in the phone layout (Chromium emulation of Obsidian's mobile UI with touch events,
// NOT iOS): the editor menu offers the entries (a selection that holds a captured quote only gets the thread), the selection is COPIED into a new independent draft that opens for
// editing (the note it came from is unchanged, nothing is sent to the Studio), "Back to note" lands on the original words, a quote kept whole in a thread and never in a fragment,
// a selection that cuts a quote is asked about before anything is made, and no private line next to the selection reaches the draft.
// Not covered: iOS selection handles, the system edit menu, a real long press (the menu event is fired by the page), the Studio's preview (see the PR's device steps).
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/passage-draft.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const ID = "7c9wk2mhq0v3xj8tn5rzfd41bg";
const state = { writes: 0 };
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const stub = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    if (req.method !== "GET") state.writes++;
    if (path === "/blyg.json") return reply(res, 200, { blyg: "0.4", level: 2, generator: "blygger-studio/0.69.0", site: `http://127.0.0.1:${stub.address().port}/`, title: "Stand-in", items: "items/index.json" });
    if (path === "/api/capabilities") return reply(res, 200, { contractVersion: "6.2.0", endpoints: {}, extensions: [], operations: ["getCapabilities", "listItems", "listSubscriptions", "listReading", "listImportedReading"] });
    if (req.method === "GET" && path.startsWith("/api/")) return reply(res, 200, { items: [], page: { limit: 50, nextCursor: null } });
    return reply(res, 404, { code: "not-found", message: "not found" });
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const data = fixtureData();
data.studio.baseUrl = `http://127.0.0.1:${stub.address().port}`;
data.features = { passages: true };

const PAIR = `![[${ID} | Example blyg]]\n> The point of copying a passage out by hand was never the copy.`;
const REACTION = "My reaction, in my own words.";
const NOTE = `Private line above.\n\n${PAIR}\n\n${REACTION}\n\nPrivate line below.\n`;
const SOURCE = "Reading/Commonplace book.md";

await runScenario({ data }, async (s) => {
  const { check } = s;
  const pg = s.page;
  await s.phone();
  const eventually = async (fn, ms = 15000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await wait(250); v = await fn(); } return v; };
  const noteText = (path) => pg.evaluate((p) => window.app.vault.adapter.read(p), path);
  const draftFiles = () => pg.evaluate(() => window.app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => p.startsWith("Blyg/")).sort());
  const modal = () => pg.evaluate(() => { const m = activeDocument.querySelector(".blyg-passage-modal"); return m ? { text: m.textContent ?? "", buttons: [...m.querySelectorAll("button")].map((b) => b.textContent) } : null; });
  const select = (a, b) => pg.evaluate(([from, to]) => { const ed = window.app.workspace.activeEditor.editor; ed.setSelection(from, to); }, [a, b]);
  const lineEnd = (n) => NOTE.split("\n")[n].length;
  // the editor-menu event, as Obsidian fires it on a long press in a note: the handler adds its items to the menu it is given
  const menuItems = () => pg.evaluate(() => {
    const items = [];
    const base = { addItem(cb) { const raw = { t: "", setTitle(t) { raw.t = t; return it; }, onClick(f) { raw.f = f; return it; } }; const it = new Proxy(raw, { get: (t, k) => (k in t ? t[k] : () => it) }); cb(it); items.push(raw); return menu; } };
    const menu = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => menu) }); // Obsidian's own handlers call more Menu methods (setSection, addSeparator, ...)
    const view = window.app.workspace.activeLeaf.view;
    window.app.workspace.trigger("editor-menu", menu, window.app.workspace.activeEditor.editor, view);
    window.__menuItems = items;
    return items.map((i) => i.t);
  });
  const clickMenu = (title) => pg.evaluate((t) => { window.__menuItems.find((i) => i.t === t)?.f(); }, title);
  const tapButton = async (text) => { await pg.evaluate((t) => [...activeDocument.querySelectorAll(".blyg-passage-modal button, .notice button")].find((b) => (b.textContent ?? "").includes(t))?.click(), text); await wait(500); };
  const activePath = () => pg.evaluate(() => window.app.workspace.getActiveFile()?.path ?? null);

  await s.createNote(SOURCE, NOTE);
  await pg.evaluate(async (p) => { await window.app.workspace.getLeaf("tab").openFile(window.app.vault.getAbstractFileByPath(p)); }, SOURCE);
  await eventually(() => pg.evaluate(() => Boolean(window.app.workspace.activeEditor?.editor)));
  check((await s.commandIds("blyg:draft-selection")).length === 2 && (await s.commandIds("blyg:back-to")).length === 1, "the feature is on: both draft commands and the way back exist (they can be added to the mobile toolbar)");

  // ---- only my reaction: the menu offers both; a fragment is made as a copy; the note is unchanged; nothing is sent
  await select({ line: 4, ch: 0 }, { line: 4, ch: lineEnd(4) });
  const m1 = await menuItems();
  check(m1.join("|") === "Draft as Blyg fragment|Draft as Blyg thread", `the editor menu offers fragment and thread for plain words (${JSON.stringify(m1)})`);
  await clickMenu("Draft as Blyg fragment");
  const frag = await eventually(async () => (await draftFiles()).find((p) => /Fragment/.test(p)));
  check(Boolean(frag), `a fragment draft is made (${frag})`);
  const ft = frag ? await noteText(frag) : "";
  check(ft === `${REACTION}\n`, `it holds exactly the selected words and nothing from the lines around them (${JSON.stringify(ft)})`);
  check((await noteText(SOURCE)) === NOTE, "the note it came from is unchanged (a copy, not a move)");
  check((await eventually(() => activePath())) === frag, "the draft is open for editing");
  const toast = await eventually(async () => pg.evaluate(() => [...activeDocument.querySelectorAll(".notice")].map((n) => n.textContent).find((t) => /Draft “/.test(t ?? ""))));
  check(/Not published/.test(toast ?? "") && /Back to note/.test(toast ?? ""), `the toast says it is not published and offers Back to note (${toast})`);
  check(state.writes === 0, "nothing was sent to the Studio");
  const tags = await pg.evaluate(() => JSON.stringify(window.app.metadataCache.getFileCache(window.app.vault.getAbstractFileByPath(window.app.workspace.getActiveFile().path))?.frontmatter ?? {}));
  check(!/Commonplace|Reading/.test(await noteText(frag)) && !/Commonplace|Reading/.test(tags), "no path or name of the original note is in the draft or its properties");

  // ---- back to the note: one tap, the original words selected again
  await tapButton("Back to note");
  const back = await eventually(() => pg.evaluate(() => { const f = window.app.workspace.getActiveFile(); const ed = window.app.workspace.activeEditor?.editor; return f?.path === "Reading/Commonplace book.md" && ed ? ed.getSelection() : null; }));
  check(back === REACTION, `Back to note lands on the original words, selected (${JSON.stringify(back)})`);

  // ---- the pair and the reaction: only a thread, quote kept intact, no private line; a fragment is never made from it
  await select({ line: 2, ch: 0 }, { line: 4, ch: lineEnd(4) });
  const m2 = await menuItems();
  check(m2.join("|") === "Draft as Blyg thread", `a selection that holds a captured quote is offered as a thread only (${JSON.stringify(m2)})`);
  const before = (await draftFiles()).length;
  await pg.evaluate(() => window.app.commands.executeCommandById("blyg:draft-selection-as-fragment"));
  const ask = await eventually(() => modal());
  check(Boolean(ask) && /This selection quotes another post/.test(ask.text) && ask.buttons.includes("Draft as Blyg thread quote kept intact"), `the fragment command asks first, the only offer is the thread (${JSON.stringify(ask?.buttons)})`);
  check((await draftFiles()).length === before, "nothing is made before the answer");
  await tapButton("Draft as Blyg thread");
  const thread = await eventually(async () => (await draftFiles()).find((p) => /Thread/.test(p)));
  const tt = thread ? await noteText(thread) : "";
  check(Boolean(thread) && /blyg_kind: thread/.test(tt) && tt.includes(`${PAIR}\n\n${REACTION}\n`) && !/Private/.test(tt), `the thread holds the native quote and the reaction, together as written, and no private line (${JSON.stringify(tt)})`);
  check((await noteText(SOURCE)) === NOTE, "the note is still unchanged");
  await pg.evaluate(() => window.app.commands.executeCommandById("blyg:back-to-drafted-from-note"));
  check((await eventually(async () => ((await activePath()) === SOURCE ? true : null))) === true, "the command “Back to the note this draft came from” also goes back");

  // ---- a selection that cuts through the quote: asked before anything is made; both ways out
  await select({ line: 3, ch: 6 }, { line: 4, ch: lineEnd(4) });
  const m3 = await menuItems();
  check(m3.join("|") === "Draft as Blyg thread", `a cut selection is offered as a thread (${JSON.stringify(m3)})`);
  const n3 = (await draftFiles()).length;
  await clickMenu("Draft as Blyg thread");
  const cut = await eventually(() => modal());
  check(Boolean(cut) && /cuts through a quote/.test(cut.text) && cut.buttons.some((b) => /Include the whole quote/.test(b)) && cut.buttons.some((b) => /Only my words, as thread/.test(b)), `it asks, offering the whole quote or only the words (${JSON.stringify(cut?.buttons)})`);
  check((await draftFiles()).length === n3, "nothing is made before the answer");
  await tapButton("Include the whole quote");
  const t2 = await eventually(async () => { const all = (await draftFiles()).filter((p) => /Thread/.test(p)); return all.length === 2 ? all.find((p) => p !== thread) : null; });
  const t2t = t2 ? await noteText(t2) : "";
  check(Boolean(t2) && t2t.includes(PAIR) && t2t.includes(REACTION), `including the whole quote takes the directive and the full quote, not the half (${JSON.stringify(t2t)})`);

  // ---- nothing selected: a notice, nothing made
  await pg.evaluate((p) => window.app.workspace.getLeaf("tab").openFile(window.app.vault.getAbstractFileByPath(p)), SOURCE);
  await eventually(() => pg.evaluate(() => Boolean(window.app.workspace.activeEditor?.editor)));
  await select({ line: 1, ch: 0 }, { line: 1, ch: 0 });
  const n4 = (await draftFiles()).length;
  await s.clearNotices();
  await pg.evaluate(() => window.app.commands.executeCommandById("blyg:draft-selection-as-fragment"));
  check(Boolean(await s.waitNotice(/Select some of your own words/)) && (await draftFiles()).length === n4, "with nothing selected it says so and makes nothing");
  check(state.writes === 0, "still nothing was sent to the Studio");
});
