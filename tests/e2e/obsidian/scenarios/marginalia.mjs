// HK3, Marginalia, in real Obsidian at the phone layout against a stand-in Studio (feature "marginalia" on; experimental features are off in the release flavour this harness loads).
// The stand-in answers like the real Studio 0.51.0 measured on 2026-11-26 (two local Studios, one quoting and answering the other's item):
//   - a post that quotes an item has the mention relation `transclusion`; a REPLY (a thread with `stub_of`) has `stub`, also when its text quotes the item with a directive;
//   - `GET /api/peek` serves the post's rendered HTML and a `subscriptionId` (null for a blyg the owner does not follow); `GET /api/imports/{sub}/{id}` answers 404 for a post that
//     was not imported, which is the usual case for a stranger's post.
// What it checks: the end-of-paragraph marker in Live Preview, its popover, no marker in source mode, the panel's Reception list, and that nothing is ever written
// (the note is byte for byte what it was, and the stand-in saw no request but reads).
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/marginalia.mjs
import http from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

const ITEM = "7c2d9fqk3m8x5r1n6t0vbhwy4z";
const ORIGIN = "https://teo.example.com/";
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
const mention = (id, sourceId, relation, who, days) => ({
  id, source: `${ORIGIN}t/${sourceId}/`, target: `https://me.example.com/f/${ITEM}/`, targetItemId: ITEM, status: "verified", relation, sourceOrigin: ORIGIN, sourceId, sourceKind: "thread", sourceVersion: 1,
  sourcePage: `${ORIGIN}t/${sourceId}/`, firstSeen: ago(days), lastSeen: ago(days), verifiedAt: ago(days), attempts: 0, error: null, hidden: false, sourceAuthor: { name: who, url: ORIGIN },
});
const MENTIONS = [
  mention("m-passage", "src-passage", "transclusion", "Teo", 2), //  a passage that is in the note
  mention("m-whole", "src-whole", "transclusion", "Mira", 3), //     the whole post, the Studio holds no copy (peek only)
  mention("m-reply-quote", "src-reply-quote", "stub", "Jo", 4), //   a reply that quotes a passage
  mention("m-reply-plain", "src-reply-plain", "stub", "Ana", 5), //  a reply with no quote
  mention("m-earlier", "src-earlier", "transclusion", "Ed", 6), //   a passage the note no longer has as written
  mention("m-gone", "src-gone", "transclusion", "Kai", 7), //        a post the Studio cannot serve
  mention("m-html", "src-html", "transclusion", "Lia", 1), //        a passage of a blyg the owner does not follow: only the peek's HTML says what it quotes
  { ...mention("m-other", "src-other", "transclusion", "Zed", 1), targetItemId: "0000000000000000000000000z" }, // another item's mention: never asked for
];
// Markdown the owner's Studio holds (imported); every other source answers 404 on /imports.
const HELD = {
  "src-passage": `![[${ITEM}]]\n> ants leave traces for others\n\nTeo's words on that.`,
  "src-reply-quote": `![[${ITEM}]]\n> First paragraph of the note\n\nJo's reply.`,
  "src-reply-plain": "Ana only answers, with no quote.",
  "src-earlier": `![[${ITEM}@v1]]\n> ants walk in straight lines\n\nEd quoted an older wording.`,
};
const PEEK = {
  "src-html": { html: `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${ITEM}" data-blyg-version="1" data-blyg-origin="https://me.example.com/"><p>Third paragraph ends the note</p></blockquote>\n<p>Lia on the ending.</p>\n`, sub: null },
  "src-whole": { html: `<blockquote class="blyg-transclusion" data-blyg-id="${ITEM}" data-blyg-version="1" data-blyg-origin="https://me.example.com/"><p>the whole note</p></blockquote>\n<p>Mira quotes it all.</p>\n`, sub: null },
  ...Object.fromEntries(Object.keys(HELD).map((id) => [id, { html: "<p>held</p>", sub: "sub1" }])), // a post of a blyg the owner follows: the Studio names the subscription and holds the post
};
const seen = { writes: [], reads: [] };
const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  req.on("data", () => {});
  req.on("end", () => {
    const path = url.pathname;
    if (req.method !== "GET" && path !== "/api/subscriptions/poll") seen.writes.push(`${req.method} ${path}`);
    else seen.reads.push(`${req.method} ${path}${url.search}`);
    if (path === "/blyg.json") return reply(res, 200, { blyg: "0.4", level: 2, generator: "blygger-studio/0.51.0", site: `http://127.0.0.1:${stub.address().port}/`, title: "Stand-in", items: "items/index.json" });
    if (path === "/api/capabilities") return reply(res, 200, { contractVersion: "5.2.0", endpoints: {}, extensions: [], operations: ["getCapabilities", "listItems", "listMentions", "peekItem", "getImportedItem"] });
    if (path === "/api/mentions") return reply(res, 200, { items: MENTIONS.filter((x) => !url.searchParams.get("targetItemId") || x.targetItemId === url.searchParams.get("targetItemId")), page: { limit: 100, nextCursor: null }, direction: "inbound" });
    if (path === "/api/peek") {
      const id = url.searchParams.get("id") ?? "";
      const p = PEEK[id];
      if (!p) return reply(res, 404, { code: "not-found", message: "not found" });
      return reply(res, 200, { origin: ORIGIN, id, kind: "thread", version: 1, contentHtml: p.html, page: `t/${id}/`, url: `${ORIGIN}t/${id}/`, stubOf: null, forkedFrom: null, subscriptionId: p.sub });
    }
    const imp = /^\/api\/imports\/sub1\/([^/]+)$/.exec(path);
    if (imp && HELD[imp[1]] !== undefined) return reply(res, 200, { kind: "thread", version: 1, state: "current", contentHtml: "<p>held</p>", contentMd: HELD[imp[1]] });
    if (path === "/api/subscriptions/poll") return reply(res, 200, { polling: 0 });
    if (req.method === "GET" && path.startsWith("/api/")) return reply(res, 200, { items: [], page: { limit: 50, nextCursor: null } });
    return reply(res, 404, { code: "not-found", message: "not found" });
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const data = fixtureData();
data.studio.baseUrl = `http://127.0.0.1:${stub.address().port}`;
data.features = { marginalia: true };

const NOTE = `---\nblyg_id: ${ITEM}\nblyg_version: 1\nblyg_kind: fragment\n---\nFirst paragraph of the note about stigmergy.\n\nSecond paragraph says that ants leave traces for others.\n\nThird paragraph ends the note.\n`;
const PATH = "Blyg/Marginalia target.md";

await runScenario({ data }, async (s) => {
  const { check, page } = s;
  await s.phone();
  await s.createNote(PATH, NOTE);
  const openIn = (mode) => page.evaluate(async ([p, m]) => {
    const leaf = window.app.workspace.getLeaf(false);
    await leaf.openFile(window.app.vault.getAbstractFileByPath(p));
    await leaf.setViewState({ type: "markdown", state: { file: p, mode: m === "preview" ? "preview" : "source", source: m === "source" } });
    await new Promise((r) => setTimeout(r, 600));
    leaf.view.editor?.setCursor({ line: 0, ch: 0 });
  }, [PATH, mode]);
  const markers = () => page.evaluate(() => [...document.querySelectorAll(".workspace-leaf.mod-active .blyg-marginalia-marker")].map((m) => ({ text: m.textContent, label: m.getAttribute("aria-label") ?? "", line: m.closest(".cm-line")?.textContent?.slice(0, 40) ?? "" })));
  const popover = () => page.evaluate(() => [...activeDocument.querySelectorAll(".blyg-reception-popover .blyg-reception-row")].map((r) => r.textContent ?? ""));

  // ---- Live Preview: the marker at the end of the paragraph the passage is in (Teo's), one for Jo's reply, none for the others
  await openIn("live");
  await wait(2500);
  const got = await s.becomes(async () => { const m = await markers(); return m.length > 0 ? m : false; }, 15000, "a marker in Live Preview");
  const live = await markers();
  console.log("OBSERVED live preview markers:", JSON.stringify(live));
  console.log("OBSERVED requests:", JSON.stringify(seen.reads.filter((r) => /mentions|peek|imports/.test(r))));
  check(Boolean(got), "Live Preview shows at least one marker");
  check(live.some((m) => /Teo quoted this/.test(m.label) && /Second paragraph/.test(m.line)), `Teo's passage has its marker at the end of its paragraph ("Second paragraph …") (${JSON.stringify(live)})`);
  check(live.some((m) => /Jo replied to this/.test(m.label) && /First paragraph/.test(m.line)), `Jo's reply, which quotes the first paragraph, has its marker there: a reply is a \`stub\`, not a \`transclusion\` (${JSON.stringify(live)})`);
  check(live.some((m) => /Lia quoted this/.test(m.label) && /Third paragraph/.test(m.line)), `Lia's passage, of a blyg the owner does not follow (read from the peek's HTML), has its marker at the end of the third paragraph (${JSON.stringify(live)})`);
  check(live.length === 3, `exactly three paragraphs carry a marker (${live.length})`);
  const mentionAsks = seen.reads.filter((r) => r.startsWith("GET /api/mentions"));
  check(mentionAsks.length >= 1 && mentionAsks.every((r) => r.includes(`targetItemId=${ITEM}`)), `the Studio is asked for this item's mentions only (${JSON.stringify(mentionAsks)})`);

  // ---- the tap: a card with who, what and when
  await page.evaluate(() => document.querySelector(".workspace-leaf.mod-active .blyg-marginalia-marker")?.click());
  await wait(500);
  const card = await popover();
  check(card.length >= 1 && /quoted this|replied to this/.test(card.join(" ")), `a tap on a marker opens a card saying who, how and when (${JSON.stringify(card)})`);
  await page.keyboard.press("Escape");

  // ---- the Reception section at the end of the note (a block widget after the last line), grouped, in words, inside the screen
  const section = () => page.evaluate(() => {
    const el = document.querySelector(".workspace-leaf.mod-active .blyg-reception-section");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { title: el.querySelector(".blyg-reception-title")?.textContent ?? "", groups: [...el.querySelectorAll(".blyg-reception-group")].map((g) => g.textContent), rows: el.querySelectorAll(".blyg-reception-row").length, inside: r.left >= 0 && r.right <= innerWidth + 0.5, text: el.textContent ?? "", afterText: !!el.closest(".cm-content") && (document.querySelector(".workspace-leaf.mod-active .cm-content")?.lastElementChild?.contains(el) ?? false) };
  });
  const sec = await s.becomes(async () => { const v = await section(); return v && v.rows >= 7 ? v : false; }, 15000, "the Reception section");
  const live2 = await section();
  console.log("OBSERVED section:", JSON.stringify(live2)?.slice(0, 900));
  check(Boolean(sec) && live2.title === "Reception · 7", `Live Preview ends with a Reception section titled with the count (${live2?.title})`);
  check(JSON.stringify(live2?.groups) === JSON.stringify(["Quoted a paragraph", "Quoted the whole note", "Replies", "From an earlier version", "Could not be read"]), `its groups are in the fixed order (${JSON.stringify(live2?.groups)})`);
  check(Boolean(live2?.inside), "the section stays inside the 393 px screen");
  check(/paragraph 2/.test(live2?.text ?? "") && /Ana replied to this/.test(live2?.text ?? "") && /earlier version/.test(live2?.text ?? ""), "it says which paragraph, lists the reply with no quote and the older wording");

  // ---- source mode and the note itself
  await openIn("source");
  await wait(800);
  check((await markers()).length === 0, "source mode draws no marker");
  const srcSec = await s.becomes(async () => { const v = await section(); return v && v.rows >= 7 ? v : false; }, 10000, "the section in source mode");
  check(Boolean(srcSec), "source mode shows the Reception section at the end");
  check((await s.readNote(PATH)) === NOTE, "the note's text is byte for byte what it was (nothing of a stranger is written into it)");

  // ---- the panel's Reception list: every mention, none lost as "nobody"; a post the Studio cannot serve says so
  await s.openNote(PATH);
  await page.evaluate(() => { for (const d of document.querySelectorAll(".blyg-pane-section")) if (/^Reception/.test(d.querySelector("summary")?.textContent ?? "")) d.open = true; });
  const rows = await s.becomes(async () => { const r = await page.evaluate(() => [...document.querySelectorAll(".blyg-reception-row")].map((e) => e.textContent ?? "")); return r.length >= 7 ? r : false; }, 20000, "the Reception rows");
  const list = await page.evaluate(() => [...document.querySelectorAll(".blyg-reception-row")].map((e) => e.textContent ?? ""));
  console.log("OBSERVED reception rows:", JSON.stringify(list));
  check(Boolean(rows), `the Reception list has a row for each of the seven mentions (${list.length})`);
  check(list.some((t) => /Ana replied to this/.test(t) && /a reply, with no quote/.test(t)), "Ana's reply without a quote is listed as a reply, not as unreadable");
  check(list.some((t) => /Mira quoted this/.test(t) && /the whole post/.test(t)), "Mira's whole-post quote, of a blyg the owner does not follow (peek has HTML only, no subscription), is listed as a whole-post quote");
  check(!list.some((t) => /Zed/.test(t)), "a mention of another item is not listed");
  check(list.some((t) => /Ed quoted this/.test(t) && /earlier version/.test(t)), "Ed's quote of wording the note no longer has says 'from an earlier version'");
  check(list.some((t) => /Kai quoted this/.test(t) && /cannot be read|could not be read/.test(t)), "a post the Studio cannot serve says that it could not be read (never an empty list)");
  check(!list.some((t) => /Nobody has quoted this yet/.test(t)) && !(await page.evaluate(() => /Nobody has quoted this yet/.test(document.body.textContent ?? ""))), "the list never says 'Nobody has quoted this yet' while mentions exist");

  // ---- the two switches: each hides its own display and nothing else
  const setSwitch = (key, v) => page.evaluate(([k, val]) => { window.app.plugins.plugins.blyg.settings.marginalia[k] = val; window.app.workspace.updateOptions(); }, [key, v]);
  await openIn("live");
  await setSwitch("bottom", false);
  await wait(800);
  check((await section()) === null && (await markers()).length === 3, `"Reception at the end of the note" off: no section, the three marks stay (${(await markers()).length})`);
  await setSwitch("bottom", true);
  await setSwitch("markers", false);
  await wait(800);
  check((await section()) !== null && (await markers()).length === 0, "\"Marks in the text\" off: no marks, the section stays");
  await setSwitch("markers", true);
  check((await s.readNote(PATH)) === NOTE, "the note is still byte for byte what it was after all of it");

  check(seen.writes.length === 0, `the stand-in Studio saw no write (${JSON.stringify(seen.writes)})`);
});
