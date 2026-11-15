// S15: the reader pane in real Obsidian, desktop and then phone layout, against a local Studio that holds one imported post (WITH_REMOTE=1).
// Drives like a person: command palette command, tap a post, tap Mark read, tap Reply. POC_SHOTS=<dir> saves a screenshot per step.
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… POC_SHOTS=/some/dir node tests/e2e/obsidian/scenarios/reader-poc.mjs
import { createServer } from "node:http";
import { fixtureData, runScenario, STUDIO, TOKEN, wait } from "../lib.mjs";

// A server on this machine that counts image requests: "nothing is requested until you tap" is measured, not assumed.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let hits = 0;
const referers = [];
const imageServer = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/gone")) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<p>gone</p>");
    return;
  }
  if ((req.url ?? "").startsWith("/slow")) {
    // A valid blyg page that is slow to arrive: the reader must show the post as text meanwhile.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><div class="blyg"><article class="fragment"><div class="item-content"><p>The slow page has arrived.</p></div></article></div></body></html>');
    }, 2500);
    return;
  }
  if ((req.url ?? "").startsWith("/noframe")) {
    res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
    res.end("<p>This page refuses to be shown inside another app.</p>");
    return;
  }
  if ((req.url ?? "").startsWith("/pixel")) { hits++; referers.push(req.headers.referer ?? null); }
  // no-store: a request the browser answers from its cache would not reach this counter, so every load must come here.
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
  res.end(PNG);
});
await new Promise((resolve) => imageServer.listen(18999, "127.0.0.1", resolve));

/** Publish a fragment on the second local Studio ("Blog B", which the first one reads), as its owner would in the web app. Port and password: scripts/local-studio.sh. */
async function publishOnBlogB(text) {
  const B = "http://localhost:8788";
  const login = await fetch(`${B}/studio/login`, { method: "POST", redirect: "manual", headers: { Origin: B, "content-type": "application/x-www-form-urlencoded" }, body: "password=local-test-password-123" });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const json = async (path, init) => (await fetch(`${B}${path}`, { ...init, headers: { Origin: B, "content-type": "application/json", ...(init.headers ?? {}) } })).json();
  const minted = await json("/api/authorizations", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "reader scenario", resource: "api", scope: ["owner:read", "owner:draft", "owner:publish"] }) });
  const auth = { authorization: `Bearer ${minted.accessToken}` };
  const item = await json("/api/items", { method: "POST", headers: auth, body: JSON.stringify({ mode: "blank", kind: "fragment", contentMd: text }) });
  await json(`/api/items/${item.id}/publish`, { method: "POST", headers: auth, body: JSON.stringify({ expectedRevision: item.revision }) });
  return item.id;
}

/** A token on the first Studio with every permission, as the owner would make one (the plugin's own token has no `reading:state`). */
async function mintFullToken() {
  const login = await fetch(`${STUDIO}/studio/login`, { method: "POST", redirect: "manual", headers: { Origin: STUDIO, "content-type": "application/x-www-form-urlencoded" }, body: "password=local-test-password-123" });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const res = await fetch(`${STUDIO}/api/authorizations`, { method: "POST", headers: { Origin: STUDIO, cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "reader scenario (all)", resource: "api", scope: ["owner:read", "owner:draft", "owner:publish", "owner:manage", "reading:state"] }) });
  return (await res.json()).accessToken;
}

await runScenario({ data: fixtureData() }, async (s) => {
  const { check } = s;
  const page = s.page;
  page.on("pageerror", (e) => process.stdout.write(`PAGEERR ${String(e.stack ?? e).split("\n").slice(0, 6).join(" | ")}\n`));
  let FULL = null; // a token with every permission, made fresh by each test that marks (the Studio rations work per token per minute, 429)
  const shot = async (name) => {
    if (process.env.POC_SHOTS) await page.screenshot({ path: `${process.env.POC_SHOTS}/${name}.png` }).catch(() => {});
  };
  const text = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].map((e) => e.textContent?.trim() ?? ""), sel);
  const click = (label) => page.evaluate((l) => {
    const b = [...document.querySelectorAll(".blyg-reader button")].find((x) => x.textContent?.trim() === l);
    if (!b || b.disabled) return false;
    b.click();
    return true;
  }, label);
  /** Put a token in the app's secret store, and wait until it reads back: the store settles a moment after a write, and a tap in between would find it empty. */
  const useToken = async (t) => {
    await page.evaluate((v) => window.app.secretStorage.setSecret("smoke-studio", v), t);
    for (let i = 0; i < 40; i++) {
      if ((await page.evaluate(() => window.app.secretStorage.getSecret("smoke-studio"))) === t) return;
      await wait(100);
    }
  };
  const openReader = async (keepChoices = false) => {
    // The feed's choices are kept in the settings now: each test starts from the start values unless it is about keeping them.
    if (!keepChoices) await page.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.filter = { sort: "newest", source: null, unreadOnly: false, length: "any" }; });
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await page.waitForSelector(".blyg-reader-card", { timeout: 20000 });
  };
  const closeReader = () => page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  /** Show a post body in the reader's text view (a hostile or odd body put in place of a real one), as the owner would see it. */
  const showText = (html, one = true) => page.evaluate(async ([h, post]) => {
    const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
    view.data.posts[0].contentHtml = h;
    view.shown = post ? view.data.posts[0] : null;
    view.shownAs = "text";
    view.draw();
    await new Promise((r) => setTimeout(r, 1000));
  }, [html, one]);
  /** Every imported post back to unread, through the Studio's API, so each test starts the same. It checks itself and tries again: the Studio may ration it (429). `resetNote` says what it saw. */
  let resetNote = "";
  let ADMIN = null; // the housekeeping token: made once and reused (the Studio throttles logins, so a login per attempt ends in 401), made again only if it is rejected
  async function resetReadMarks() {
    const seen = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      ADMIN ??= await mintFullToken();
      const headers = { authorization: `Bearer ${ADMIN}`, Origin: STUDIO };
      const res = await fetch(`${STUDIO}/api/reading/imported?limit=100`, { headers }).catch(() => null);
      const list = res ? await res.json().catch(() => ({})) : {};
      seen.push(res?.status ?? "no answer");
      if (res?.status === 401) { ADMIN = null; await wait(10_000); continue; }
      if (Array.isArray(list.items)) {
        const read = list.items.filter((r) => r.readVersion !== null);
        if (read.length === 0) { resetNote = ""; return true; }
        for (const r of read) {
          const del = await fetch(`${STUDIO}/api/reading/${encodeURIComponent(r.subscriptionId)}/${encodeURIComponent(r.remoteId)}/read`, { method: "DELETE", headers }).catch(() => null);
          seen.push(`DELETE ${del?.status ?? "no answer"}`);
        }
      }
      await wait(attempt < 2 ? 500 : 6000);
    }
    resetNote = ` (the Studio answered: ${seen.slice(-8).join(", ")})`;
    return false;
  }

  async function pass(layout) {
    check(await resetReadMarks(), `${layout}: every post starts unread (housekeeping)${resetNote}`);
    await openReader();
    await wait(1500);
    const cards = await text(".blyg-reader-card");
    check(cards.length > 0 && cards.some((c) => c.includes("Blog B")), `${layout}: the feed shows cards naming the blyg (${cards.length} cards)`);
    check((await text(".blyg-reader-card.is-unread .blyg-reader-badge.is-new")).length > 0, `${layout}: an unread post carries an "unread" badge`);
    check((await page.$(".blyg-reader-controls")) === null && (await text(".blyg-reader-filterbtn"))[0] === "Sort & filter", `${layout}: the sort and filter choices start closed, so the header stays slim`);
    check(await click("Sort & filter"), `${layout}: "Sort & filter" opens them`);
    await wait(300);
    const options = await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-controls select")].map((x) => [...x.options].map((o) => o.textContent)));
    check(options.length === 5 && options[4].includes("Reduced contrast") && options[0].includes("Newest first") && options[0].includes("Longest read first") && options[1].some((o) => /^Blog B \(\d+\)$/.test(o ?? "")) && options[2].includes("Under 2 min") && options[3].some((o) => /Serif/.test(o ?? "")), `${layout}: order, blyg, length and font choices are there (${JSON.stringify(options.map((o) => o.length))} entries)`);
    check((await text(".blyg-reader-toggle")).some((t) => t.includes("Unread only")), `${layout}: the "Unread only" switch is there`);
    check(JSON.stringify(await text(".blyg-reader-segment button")) === '["Web page","Text"]' && (await text(".blyg-reader-segment .is-active"))[0] === "Web page", `${layout}: how posts open by default can be chosen (Web page is the start)`);
    check(/\d+ min read/.test((await text(".blyg-reader-card"))[0] ?? ""), `${layout}: each card says how long it takes to read (${((await text(".blyg-reader-card"))[0] ?? "").match(/\d+ min read/)?.[0]})`);
    check(await click("Sort & filter"), `${layout}: ...and closes them again`);
    await wait(300);
    check(/^Blyg reader · plugin \d+\.\d+\.\d+/.test((await text(".blyg-reader-foot"))[0] ?? ""), `${layout}: the feed ends with the plugin's version (${(await text(".blyg-reader-foot"))[0]})`);
    const layoutOk = await page.evaluate(() => {
      const header = document.querySelector(".blyg-reader-header"); const scroll = document.querySelector(".blyg-reader-scroll");
      return !!header && !!scroll && !scroll.contains(header) && getComputedStyle(scroll).overflowY === "auto" && getComputedStyle(scroll).userSelect === "text";
    });
    check(layoutOk, `${layout}: the header sits outside the scrolling body (it never scrolls away) and the text in it can be selected`);
    await shot(`${layout}-1-feed`);

    // A post opens as its web page: the text first, at once, then the page.
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await page.waitForSelector(".blyg-reader-frame", { timeout: 15000 }).catch(() => {});
    const frame = await page.evaluate(() => {
      const f = document.querySelector(".blyg-reader-frame");
      return f ? { src: f.getAttribute("src"), sandbox: f.getAttribute("sandbox") ?? "" } : null;
    });
    check(frame !== null && frame.src?.startsWith("blob:"), `${layout}: tapping a post shows its web page, trimmed to the post, inside Obsidian (${frame?.src?.slice(0, 30) ?? "no frame"})`);
    check(frame !== null && !/allow-scripts|allow-same-origin/.test(frame.sandbox), `${layout}: the page runs sandboxed, without scripts and without its origin (${frame?.sandbox})`);
    await wait(1500);
    const framed = page.frames().find((f) => f.url() === frame?.src);
    const inside = framed ? await framed.evaluate(() => ({ text: document.body?.innerText ?? "", styles: [...document.querySelectorAll("style")].map((x) => x.textContent?.length ?? 0), font: getComputedStyle(document.body).fontFamily, article: document.querySelectorAll("article").length })).catch(() => null) : null;
    check(Boolean(inside) && inside.text.length > 0 && inside.article === 1, `${layout}: the post really rendered in the frame (${(inside?.text ?? "").replace(/\s+/g, " ").slice(0, 60)}…)`);
    check(Boolean(inside) && !/Made with Blygger|Find more blygs/.test(inside.text), `${layout}: the blyg's menu, masthead and links are left out`);
    check(Boolean(inside) && inside.styles[0] > 1000 && inside.font.trim() !== '"Times New Roman"', `${layout}: the blyg's own stylesheet is applied, inline (${inside?.styles[0]} characters; font ${inside?.font?.slice(0, 40)})`);
    const buttons = await text(".blyg-reader-header button");
    check(["Back", "Reply", "○ Mark read", "Browser", "As text"].every((b) => buttons.includes(b)), `${layout}: the post's buttons are in the header: ${buttons.join(", ")}`);
    const links = await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-postmeta a.blyg-reader-link")].map((a) => a.getAttribute("href")));
    check(links.length >= 1 && links[0].startsWith("http://localhost:8788"), `${layout}: the post's blyg is a link to its page (${links.join(", ")})`);
    check((await text(".blyg-reader-postmeta")).some((t) => /unread/.test(t) && /\d+ min read/.test(t)), `${layout}: the post's header says it is unread and how long it takes to read`);
    await shot(`${layout}-2-web`);

    check(await click("As text"), `${layout}: "As text" can be tapped`);
    await wait(500);
    const body = (await text(".blyg-reader-body"))[0] ?? "";
    check(body.length > 0 && (await page.$(".blyg-reader-frame")) === null, `${layout}: the same post as text, the frame gone (${body.length} characters)`);
    check(await page.evaluate(() => getComputedStyle(document.querySelector(".blyg-reader-body")).userSelect === "text"), `${layout}: the text of a post can be selected`);

    // Answering.
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(800);
    const before = await page.evaluate(() => window.app.vault.getMarkdownFiles().length);
    check(await click("Reply"), `${layout}: Reply can be tapped`);
    await wait(3000);
    const after = await page.evaluate(() => window.app.vault.getMarkdownFiles().length);
    const reply = await page.evaluate(async () => {
      const f = window.app.workspace.getActiveFile();
      return f ? { path: f.path, text: await window.app.vault.read(f) } : null;
    });
    check(after === before + 1 && !!reply, `${layout}: Reply made one new note (${before} to ${after}): ${reply?.path ?? "none"}`);
    check(/blyg_stub_of/.test(reply?.text ?? ""), `${layout}: the new note names the post it answers (blyg_stub_of)`);
    await closeReader();
  }

  /** The app's own token has no `reading:state`: the refusal is explained in words, and the mark that was shown at once is put back. Runs first, before the token is changed. */
  async function refusal() {
    check(await resetReadMarks(), "refusal: every post starts unread (housekeeping)");
    await openReader();
    await wait(1500);
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(800);
    check(await click("○ Mark read"), "refusal: Mark read can be tapped with the app's own token");
    await wait(1500);
    const status = (await text(".blyg-reader-status"))[0] ?? "";
    check(/reading:state/.test(status) && (await text(".blyg-reader-header button")).includes("○ Mark read"), `refusal: it is explained in words and the mark is put back: "${status.slice(0, 80)}"`);
    await closeReader();
  }

  /** Read marks with a token that has the permission: shown at once (card and header), kept after a refresh, undone at a tap, and a stale list does not undo them. */
  async function readMarks() {
    check(await resetReadMarks(), "read marks: every post starts unread (housekeeping)");
    await openReader();
    await wait(1500);
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(800);
    await page.evaluate(() => { window.__t0 = performance.now(); [...document.querySelectorAll(".blyg-reader-header button")].find((b) => b.textContent?.trim() === "○ Mark read")?.click(); });
    const instant = await page.evaluate(() => ({ label: [...document.querySelectorAll(".blyg-reader-header button")].map((b) => b.textContent?.trim()), meta: document.querySelector(".blyg-reader-postmeta")?.textContent ?? "", ms: performance.now() - window.__t0 }));
    check(instant.label.includes("✓ Read") && /✓ read/.test(instant.meta) && instant.ms < 100, `read marks: marking read shows at once in the post's header (${Math.round(instant.ms)} ms, "${instant.label.find((l) => /Read/.test(l))}")`);
    await wait(1500);
    check(await click("Back"), "read marks: Back to the feed");
    await wait(300);
    check(await page.evaluate(() => { const c = document.querySelector(".blyg-reader-card"); return !!c && c.classList.contains("is-read") && !!c.querySelector(".blyg-reader-badge.is-done"); }), `read marks: the card of the post just read shows "✓ read" without a refresh (status line: "${(await text(".blyg-reader-status"))[0] ?? ""}")`);
    await shot("read-marks");
    check(await page.evaluate(() => { document.querySelector(".blyg-reader-card .blyg-reader-check")?.click(); return document.querySelector(".blyg-reader-card")?.classList.contains("is-unread") ?? false; }), "read marks: the check button on a card marks it unread again, at once");
    await wait(1500);
    await page.evaluate(() => document.querySelector(".blyg-reader-card .blyg-reader-check")?.click());
    await wait(1500);
    check(await click("Refresh"), "read marks: Refresh can be tapped");
    await wait(2500);
    check(await page.evaluate(() => document.querySelector(".blyg-reader-card")?.classList.contains("is-read") ?? false), "read marks: the mark is in the Studio, so it is still there after a refresh");
    await wait(2500); // a mark may still be on its way on a slow runner
    await resetReadMarks();
    await closeReader();
  }

  /** The race behind an intermittent failure: a list fetched just BEFORE a mark reached the Studio arrives just AFTER it was shown. It must not undo the mark. */
  async function staleReload() {
    await resetReadMarks();
    await openReader();
    await wait(1500);
    const result = await page.evaluate(async () => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      const realLoad = view.host.load.bind(view.host);
      const stale = await realLoad(); // the Studio's state before the mark: everything unread
      document.querySelector(".blyg-reader-card .blyg-reader-check")?.click(); // the mark, shown at once
      view.host.load = async () => stale; // ...and now the stale list arrives
      await view.reload(true);
      const card = document.querySelector(".blyg-reader-card");
      return { read: card?.classList.contains("is-read") ?? false, badge: !!card?.querySelector(".blyg-reader-badge.is-done") };
    });
    check(result.read && result.badge, "a stale list that arrives after a read mark does not undo it");
    await wait(2500); // a mark may still be on its way on a slow runner
    check(await resetReadMarks(), "a stale list: housekeeping afterwards");
    await closeReader();
  }

  /** Reading time: sort and filter by it, in the panel that opens from the header. */
  async function readingTime() {
    await openReader();
    await wait(1000);
    // Make the first post a long one (about 6 minutes) and the second a short one, then choose.
    await page.evaluate(() => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].contentHtml = `<p>${"word ".repeat(1380)}</p>`; // 1380 words at 230 a minute: 6 minutes
      view.data.posts[1].contentHtml = "<p>tiny</p>";
      view.draw();
    });
    await wait(300);
    check(await click("Sort & filter"), "reading time: the choices open");
    await wait(300);
    const choose = (label, value) => page.evaluate(([l, v]) => {
      const el = [...document.querySelectorAll(".blyg-reader-controls select")].find((x) => x.getAttribute("aria-label") === l);
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, [label, value]);
    const cards = () => page.evaluate(() => [...document.querySelectorAll(".blyg-reader-card")].map((c) => (c.textContent ?? "").match(/(\d+) min read/)?.[1] ?? "?"));
    check(await choose("Length", "long"), "reading time: the length can be chosen");
    await wait(300);
    check(JSON.stringify(await cards()) === '["6"]', `reading time: "Over 5 min" shows only the long post (${JSON.stringify(await cards())})`);
    check((await text(".blyg-reader-filterbtn"))[0] === "Sort & filter (1)", `reading time: the button says how many choices are made (${(await text(".blyg-reader-filterbtn"))[0]})`);
    await choose("Length", "short");
    await wait(300);
    check((await cards()).every((m) => m === "1") && (await cards()).length >= 1, `reading time: "Under 2 min" shows only short posts (${JSON.stringify(await cards())})`);
    await choose("Length", "any");
    await choose("Order", "longest");
    await wait(300);
    const longest = await cards();
    check(longest[0] === "6" && longest.at(-1) === "1", `reading time: longest first puts the 6 minute post first (${JSON.stringify(longest)})`);
    await choose("Order", "shortest");
    await wait(300);
    const shortest = await cards();
    check(shortest[0] === "1" && shortest.at(-1) === "6", `reading time: shortest first puts it last (${JSON.stringify(shortest)})`);
    await closeReader();
  }

  /** The font of a post in the text view only; the interface keeps Obsidian's, and the web page view is never changed. */
  async function font() {
    await openReader();
    await wait(1000);
    check(await click("Sort & filter"), "font: the choices open");
    await wait(300);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll(".blyg-reader-controls select")].find((x) => x.getAttribute("aria-label") === "Font for posts");
      el.value = "serif";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait(500);
    check(await page.evaluate(() => window.app.plugins.plugins.blyg.settings.readerPane.font === "serif" && document.querySelector(".blyg-reader")?.classList.contains("is-font-serif")), "font: the choice is kept in the setting and on the pane");
    await click("Sort & filter");
    await wait(300);
    // text view
    await page.evaluate(() => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.shown = view.data.posts[0];
      view.shownAs = "text";
      view.draw();
    });
    await wait(500);
    const textFont = await page.evaluate(() => ({ body: getComputedStyle(document.querySelector(".blyg-reader-body")).fontFamily, ui: getComputedStyle(document.querySelector(".blyg-reader-btn")).fontFamily }));
    check(/Iowan|Palatino|Georgia/.test(textFont.body) && !/Iowan/.test(textFont.ui), `font: the text view's content is serif and the buttons keep Obsidian's font (${textFont.body.slice(0, 30)} / ${textFont.ui.slice(0, 20)})`);
    // web page view: a fresh document that the font setting does not touch
    await page.evaluate(() => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.releasePage();
      view.shownAs = "web";
      view.drawHeader();
      view.drawBody();
    });
    await page.waitForSelector(".blyg-reader-frame", { timeout: 15000 }).catch(() => {});
    await wait(1500);
    const src = await page.evaluate(() => document.querySelector(".blyg-reader-frame")?.getAttribute("src") ?? "");
    const framed = page.frames().find((f) => f.url() === src);
    const webFontOf = (f) => (f ? f.evaluate(() => getComputedStyle(document.querySelector(".item-content p") ?? document.body).fontFamily).catch(() => "") : Promise.resolve(""));
    const webFont = await webFontOf(framed);
    // The blyg's own stylesheet may well name a serif of its own, so the proof is the same page with the setting on "default": the same type.
    await page.evaluate(() => {
      window.app.plugins.plugins.blyg.settings.readerPane.font = "default";
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.releasePage();
      view.drawBody();
    });
    await page.waitForSelector(".blyg-reader-frame", { timeout: 15000 }).catch(() => {});
    await wait(1500);
    const src2 = await page.evaluate(() => document.querySelector(".blyg-reader-frame")?.getAttribute("src") ?? "");
    const webFontDefault = await webFontOf(page.frames().find((f) => f.url() === src2));
    check(Boolean(framed) && webFont !== "" && webFont === webFontDefault, `font: the web page view has the blyg's own type whatever the setting says (serif setting: ${webFont.slice(0, 30)}; default: ${webFontDefault.slice(0, 30)})`);
    await page.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.font = "default"; });
    await closeReader();
  }

  /** The reader beside the note you write: in the sidebar as well as in a tab. */
  async function sidebar() {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-sidebar"));
    await page.waitForSelector(".workspace-split.mod-right-split .blyg-reader-card", { timeout: 20000 }).catch(() => {});
    const inRight = await page.evaluate(() => ({ cards: document.querySelectorAll(".workspace-split.mod-right-split .blyg-reader-card").length, header: !!document.querySelector(".workspace-split.mod-right-split .blyg-reader-header") }));
    check(inRight.cards > 0 && inRight.header, `the reader opens in the sidebar (${inRight.cards} cards)`);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await page.waitForSelector(".workspace-split.mod-root .blyg-reader-card", { timeout: 20000 }).catch(() => {});
    const both = await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").length);
    check(both === 2, `...and a reader in a tab is a second one beside it, each with its own place (${both} readers)`);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-sidebar"));
    await wait(500);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").length)) === 2, "...and asking again brings the open one forward instead of opening a third");
    await closeReader();
  }

  /** How posts open by default, chosen in the feed: kept in the setting, and used by the next post you tap. */
  async function defaultView() {
    await resetReadMarks();
    await openReader();
    check(await click("Sort & filter"), "the feed's choices can be opened");
    await wait(300);
    check(await click("Text"), "the feed's \"Text\" choice can be tapped");
    await wait(300);
    check(await page.evaluate(() => window.app.plugins.plugins.blyg.settings.readerPane.view === "text"), "the choice is kept in the setting \"Open posts as\"");
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(800);
    check((await page.$(".blyg-reader-frame")) === null && ((await text(".blyg-reader-body"))[0] ?? "").length > 0, "the next post opens as text");
    check(await click("As web page"), "a post can still be switched to its web page for once");
    await page.waitForSelector(".blyg-reader-frame", { timeout: 15000 }).catch(() => {});
    check((await page.$(".blyg-reader-frame")) !== null, "...and then it is the web page");
    check(await click("Back"), "Back");
    await wait(300);
    check(await click("Web page") || await click("Sort & filter") && (await wait(300), await click("Web page")), "the feed's \"Web page\" choice puts it back");
    await wait(300);
    await closeReader();
  }

  /** The post as text comes first and the page replaces it: a slow page does not leave an empty pane. */
  async function textFirst() {
    await openReader();
    await page.evaluate(() => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].sourceUrl = "http://127.0.0.1:18999/slow";
      view.releasePage();
      view.shown = view.data.posts[0];
      view.shownAs = "web";
      view.drawHeader();
      view.drawBody();
    });
    await wait(700);
    const early = await page.evaluate(() => ({ text: document.querySelector(".blyg-reader-body")?.textContent?.length ?? 0, frame: !!document.querySelector(".blyg-reader-frame"), status: document.querySelector(".blyg-reader-status")?.textContent ?? "", spinner: document.querySelector(".blyg-reader-status")?.classList.contains("is-busy") ?? false }));
    check(early.text > 0 && !early.frame && /Opening the page/.test(early.status) && early.spinner, `a slow page: the text is there at once, with a spinning "${early.status}"`);
    await page.waitForSelector(".blyg-reader-frame", { timeout: 15000 }).catch(() => {});
    await wait(800);
    const late = await page.evaluate(() => ({ frame: !!document.querySelector(".blyg-reader-frame"), body: !!document.querySelector(".blyg-reader-body"), spinner: document.querySelector(".blyg-reader-status")?.classList.contains("is-busy") ?? true }));
    check(late.frame && !late.body && !late.spinner, "...and when the page has arrived it replaces the text and the spinner stops");
    await closeReader();
  }

  /** A page that cannot be shown: the post falls back to text, with a line that says why. And what desktop Obsidian does with a page that refuses framing. */
  async function noFrame() {
    await openReader();
    const open = (url) => page.evaluate((u) => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].sourceUrl = u;
      view.releasePage();
      view.shown = view.data.posts[0];
      view.shownAs = "web";
      view.drawHeader();
      view.drawBody();
    }, url);
    await open("http://127.0.0.1:18999/gone");
    await wait(2500);
    const note = (await text(".blyg-reader-note")).join(" ");
    check((await page.$(".blyg-reader-frame")) === null && /could not be reached/.test(note) && ((await text(".blyg-reader-body"))[0] ?? "").length > 0, `a page that does not answer falls back to text, and says why ("${note.slice(0, 70)}")`);
    // Desktop Obsidian removes X-Frame-Options and CSP frame-ancestors from every response (its own session hook), so a refusing page is framed anyway
    // here; on mobile the header arrives and the post falls back to text (unit-tested in framePolicy, not checkable in this desktop harness).
    await open("http://127.0.0.1:18999/noframe");
    await wait(2500);
    const whole = await page.evaluate(() => document.querySelector(".blyg-reader-frame")?.getAttribute("src") ?? null);
    check(whole === "http://127.0.0.1:18999/noframe", `a page without the contract's article is shown whole; and desktop Obsidian strips X-Frame-Options, so even this refusing page is framed (documented, not the plugin's choice) (${whole})`);
    await closeReader();
  }

  /** New posts: the reader asks the Studio to fetch the blygs it reads, so a post published a moment ago appears after Refresh, without the web app. */
  async function freshness() {
    await openReader();
    const stamp = `Fresh post ${Date.now().toString(36)}`;
    const id = await publishOnBlogB(`${stamp}. Published while the reader was open.`);
    // The other blyg lists a new post in its feed a moment after publishing; a reader only ever sees it from then on. Wait for that, as a person would.
    for (let i = 0; i < 90; i++) {
      const feed = await fetch("http://localhost:8788/feed.xml").then((x) => x.text()).catch(() => "");
      if (feed.includes(id)) break;
      await wait(1000);
    }
    // The reader asked once already when it opened; Refresh waits a minute between asks. A person would wait; the test resets the pause.
    await page.evaluate(() => { window.app.plugins.plugins.blyg.readerCheckedAt = 0; });
    const t0 = Date.now();
    check(await click("Refresh"), "freshness: Refresh can be tapped");
    let saw = "";
    let spinning = false;
    let found = false;
    let doneAt = 0;
    for (let i = 0; i < 40 && !doneAt; i++) {
      await wait(500);
      const st = await page.evaluate(() => ({ t: document.querySelector(".blyg-reader-status")?.textContent ?? "", busy: document.querySelector(".blyg-reader-header")?.classList.contains("is-busy") ?? false, btn: document.querySelector(".blyg-reader-refresh")?.disabled ?? false }));
      if (/Checking/.test(st.t)) { saw = st.t; spinning ||= st.busy && st.btn; }
      found ||= (await text(".blyg-reader-card")).some((c) => c.includes(stamp));
      if (/Up to date|new or changed/.test(st.t)) doneAt = Date.now();
    }
    check(saw !== "", `freshness: the status says the Studio is checking ("${saw}")`);
    check(spinning, "freshness: while it checks, the Refresh button is disabled and the header shows it is busy (a spinning ring)");
    check(found, "freshness: a post published on the other blyg a moment ago appears after Refresh");
    check(doneAt > 0 && doneAt - t0 < 15000, `freshness: the check ends as soon as the blyg has reported, not after the full half minute (${doneAt ? Math.round((doneAt - t0) / 100) / 10 : "never"} s)`);
    await shot("freshness");
    await closeReader();
  }

  /** Markup that used to be refused for being unfamiliar, and what is still refused (with its cause named). */
  async function markup() {
    await openReader();
    const venkatesh = '<p>Lead<sup id="r1"><a href="#fn1" rel="footnote" class="fn">1</a></sup> and <mark>marked</mark> text.</p><figure class="wp-block"><figcaption>cap</figcaption></figure><details open><summary>more</summary><p data-x="1" style="color:red">inside</p></section></details><ol start="3"><li id="fn1">note</li></ol><table width="100%" border="1" background="http://127.0.0.1:18999/pixel-m1.png"><tbody><tr><td align="center" bgcolor="red">cell</td></tr></tbody></table>';
    hits = 0;
    await showText(venkatesh);
    const drawn = await page.evaluate(() => ({ text: document.querySelector(".blyg-reader-body")?.textContent ?? "", figure: !!document.querySelector(".blyg-reader-body figure"), cell: document.querySelector(".blyg-reader-body td")?.hasAttribute("background") ?? true, styled: document.querySelectorAll(".blyg-reader-body [style]").length }));
    check(/Lead.*marked text/.test(drawn.text) && /cell/.test(drawn.text) && !/does not draw/.test(drawn.text) && drawn.figure, "markup of the kind other blygs write (footnotes, figure, mark, details, a table with legacy attributes) is drawn, not refused");
    check(hits === 0 && !drawn.cell && drawn.styled === 0, `...with the harmless extras dropped: no request was made, no background, no inline style (${hits} requests)`);
    await showText('<p>x</p><IMG SRC="http://127.0.0.1:18999/pixel-m2.png" ALT="up"><img src=\'http://127.0.0.1:18999/pixel-m3.png\' alt=a>');
    const forms = await page.evaluate(() => ({ buttons: document.querySelectorAll(".blyg-reader-image").length, imgs: document.querySelectorAll(".blyg-reader-body img").length }));
    check(hits === 0 && forms.buttons === 2 && forms.imgs === 0, `an image written in upper case or with single quotes is still an image that waits for a tap (${hits} requests, ${forms.buttons} buttons)`);
    for (const [html, cause] of [['<p>x</p><iframe src="http://127.0.0.1:18999/pixel-m4.png"></iframe>', "the tag <iframe>"], ["<p>x</p><script>window.__pwned=1</script>", "the tag <script>"], ["<p>x</p><svg onload=\"window.__pwned=2\"></svg>", "the tag <svg>"], ["<p>x</p><!-- c -->", "a comment or declaration"]]) {
      await showText(html);
      const note = (await text(".blyg-reader-blocked")).join(" ");
      check(note.includes(cause) && note.includes("Open it in the browser") && hits === 0, `a post with ${cause} is not drawn, and says why ("${note.slice(0, 80)}")`);
    }
    await closeReader();
  }

  /** The entries of the menu: two plainly named ribbon entries (the mobile menu lists them). */
  async function ribbon() {
    const labels = await page.evaluate(() => [...document.querySelectorAll(".side-dock-ribbon-action")].map((e) => e.getAttribute("aria-label")));
    check(labels.includes("Open blyg reader") && labels.includes("Open blyg publisher") && !labels.includes("Open panel"), `the ribbon (the mobile menu) has "Open blyg reader" and "Open blyg publisher" (${labels.filter((l) => /Open/.test(l ?? "")).join(", ")})`);
  }

  /** The bypasses found in review (2026-11-13): each fetched without a tap under the old deny-list. Now each is refused or dropped, and nothing is requested. */
  async function bypasses() {
    await openReader();
    const P = (n) => `http://127.0.0.1:18999/${n}.png`;
    const cases = {
      "<image> alias": `<p>a</p><image src="${P("pixel-b1")}">`,
      "<input type=image>": `<p>a</p><input type="image" src="${P("pixel-b2")}">`,
      "table background": `<table background="${P("pixel-b3")}"><tbody><tr><td>x</td></tr></tbody></table>`,
      "td background": `<table><tbody><tr><td background="${P("pixel-b4")}">x</td></tr></tbody></table>`,
      "style url()": `<p style="background-image:url(${P("pixel-b5")})">x</p>`,
      "style list-style-image": `<ul style="list-style-image:url(${P("pixel-b6")})"><li>x</li></ul>`,
      "quote breakout via the own-Studio path": `<p><a href="https://example.com/" title='<img src="http://localhost:8787/x&#39; style=&#39;background-image:url(${P("pixel-b7")});x:" alt="y">'>z</a></p>`,
    };
    for (const [name, html] of Object.entries(cases)) {
      hits = 0;
      await showText(html);
      const out = await page.evaluate(() => ({ refused: !!document.querySelector(".blyg-reader-blocked"), bg: document.querySelectorAll(".blyg-reader-body [background]").length, urlStyle: [...document.querySelectorAll(".blyg-reader-body [style]")].filter((e) => /url\(/i.test(e.getAttribute("style") ?? "")).length }));
      check(hits === 0 && out.bg === 0 && out.urlStyle === 0, `bypass closed: ${name} ${out.refused ? "is refused" : "is drawn without the attribute that loaded"} and requests nothing (${hits} requests)`);
    }
    // The own-Studio path with an apostrophe in a well-formed tag: drawn, one image, no attribute smuggled out.
    hits = 0;
    await showText(`<p><img src="http://localhost:8787/x&#39; style=&#39;background-image:url(${P("pixel-b8")})" alt="y"></p>`);
    const own = await page.evaluate(() => {
      const img = document.querySelector(".blyg-reader-body img");
      return { attrs: img ? img.getAttributeNames().sort() : [], styled: document.querySelector(".blyg-reader-body [style]") !== null };
    });
    check(hits === 0 && !own.styled && JSON.stringify(own.attrs) === JSON.stringify(["alt", "src"]), `bypass closed: an apostrophe in an own-Studio address smuggles nothing (${hits} requests, attributes ${own.attrs.join(",")})`);
    await closeReader();
  }

  /** Images, measured by a server that counts requests: none until a tap, one per tap, all with "Load images", and drawn with the post under "Always load". */
  async function images() {
    const post = (...names) => names.map((n) => `<img src="http://127.0.0.1:18999/${n}.png" alt="${n}">`).join("");
    const count = (sel) => page.evaluate((q) => document.querySelectorAll(`.blyg-reader-body ${q}`).length, sel);
    await openReader();

    hits = 0;
    await showText(`<p>list</p>${post("pixel9")}`, false);
    check(hits === 0, `images: the stream list requests no image, however many posts it shows (${hits} requests)`);

    hits = 0;
    await showText(`<p>pictures</p>${post("pixel1", "pixel2")}`);
    check(hits === 0, `images, load on click: nothing was requested while the post was drawn (${hits} requests)`);
    check((await count(".blyg-reader-image")) === 2 && (await count("img")) === 0, "images, load on click: two buttons, no image yet");
    check((await text(".blyg-reader-image"))[0]?.includes("127.0.0.1:18999") === true, "images, load on click: the button names the server it would contact");
    await shot("images-1-buttons");

    await page.evaluate(() => document.querySelector(".blyg-reader-body .blyg-reader-image")?.click());
    await wait(1200);
    check(hits === 1 && (await count("img")) === 1, `images, load on click: tapping one button requests exactly that image (${hits} request)`);
    check(await page.evaluate(() => document.querySelector(".blyg-reader-body img")?.getAttribute("referrerpolicy") === "no-referrer"), "images, load on click: a loaded image sends no referrer");
    check(await page.evaluate(() => { const b = [...document.querySelectorAll(".blyg-reader-loadall")][0]; if (!b) return false; b.click(); return true; }), "images, load on click: 'Load images (n)' is offered when images wait");
    await wait(1200);
    check(hits === 2 && (await count("img")) === 2 && (await count(".blyg-reader-image")) === 0, `images, load on click: the rest load on request (${hits} requests in all)`);
    await shot("images-2-loaded");

    await page.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.images = "always"; });
    hits = 0;
    referers.length = 0;
    // Fresh addresses: the two above were loaded already, and a browser may answer those from its image cache with no request at all (seen in CI).
    await showText(`<p>pictures</p>${post("pixel3", "pixel4")}`);
    check(hits === 2 && (await count("img")) === 2 && (await count(".blyg-reader-image")) === 0, `images, always load: both are drawn with the post (${hits} requests)`);
    check(referers.every((r) => r === null), `images, always load: no referrer is sent (${JSON.stringify(referers)})`);
    await page.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.images = "click"; });
    await closeReader();
  }

  /** "Read & next ›" in the header (both views) through the feed's order to its end, the pull-up at the end of the text view, and the measured clearance for Obsidian's bottom bar. */
  async function nextPost(layout) {
    await openReader();
    await wait(1000);
    check(await resetReadMarks(), `${layout}: next: every post starts unread`);
    await page.evaluate(() => { window.app.workspace.getLeavesOfType("blyg-reader")[0].view.host.viewMode = () => "text"; });
    check((await text(".blyg-reader-nextbtn")).length === 0, `${layout}: next: no such button in the feed`);
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(500);
    const first = await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId);
    check((await text(".blyg-reader-header .blyg-reader-nextbtn"))[0] === "Read & next ›", `${layout}: next: an unread post's header offers "Read & next ›" (${(await text(".blyg-reader-nextbtn"))[0]})`);
    check((await page.$(".blyg-reader-postfoot")) === null, `${layout}: next: no bar below the post any more`);
    const look = await page.evaluate(() => { const b = document.querySelector(".blyg-reader-nextbtn"); return { radius: parseFloat(getComputedStyle(b).borderTopLeftRadius), h: b.getBoundingClientRect().height }; });
    check(look.radius <= 10 && look.h > 0, `${layout}: next: the buttons are square-cornered (radius ${look.radius})`);
    // The pull-up: a short post fits the pane, so it is "at the end" already. Touch events as a finger makes them.
    const touch = (type, y) => page.evaluate(([t, yy]) => {
      const el = document.querySelector(".blyg-reader-scroll");
      const point = new Touch({ identifier: 1, target: el, clientX: 100, clientY: yy });
      el.dispatchEvent(new TouchEvent(t, { bubbles: true, cancelable: true, touches: t === "touchend" ? [] : [point], changedTouches: [point] }));
    }, [type, y]);
    const hint = () => page.evaluate(() => { const h = document.querySelector(".blyg-reader-pull"); return h ? { shown: h.classList.contains("is-shown"), ready: h.classList.contains("is-ready"), text: h.textContent } : null; });
    await touch("touchstart", 600); await touch("touchmove", 580);
    const slight = await hint();
    check(slight?.shown && !slight.ready && /Keep pulling to mark read and open next/.test(slight.text ?? ""), `${layout}: pull-up: a short pull shows what it will do (${JSON.stringify(slight)})`);
    await touch("touchend", 580); await wait(300);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId)) === first, `${layout}: pull-up: letting go early does nothing`);
    await touch("touchstart", 600); await touch("touchmove", 540);
    await wait(300);
    const fading = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".blyg-reader-surface .blyg-reader-column")).opacity));
    check(fading < 0.9 && fading > 0.3, `${layout}: pull-up: the text fades as you pull (opacity ${fading})`);
    await touch("touchmove", 500);
    check((await hint())?.ready === true, `${layout}: pull-up: past the threshold it says "let go"`);
    await touch("touchend", 500);
    await wait(400);
    const moment = await page.evaluate(() => { const d = document.querySelector(".blyg-reader-done"); return d ? { text: d.textContent, shown: d.classList.contains("is-in"), op: parseFloat(getComputedStyle(d).opacity) } : null; });
    check(moment?.text === "✓ Marked read" && moment.shown && moment.op > 0.5, `${layout}: pull-up: a centred "Marked read" appears before the next post (${JSON.stringify(moment)})`);
    await wait(1500);
    check((await page.$(".blyg-reader-done")) === null, `${layout}: pull-up: ...and is gone again`);
    const moved = await page.evaluate((id) => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; return { now: v.shown?.remoteId, was: v.data.posts.find((p) => p.remoteId === id)?.readVersion }; }, first);
    check(moved.now !== first && moved.now !== undefined && moved.was !== null, `${layout}: pull-up: letting go past it marks the post read and opens another`);
    // Obsidian's bottom bar: a fake one over the bottom of the pane; the pane must clear it (measured, not a guessed variable).
    await page.evaluate(() => {
      const bar = document.createElement("div");
      bar.className = "mobile-navbar";
      bar.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;height:60px;z-index:50";
      document.body.appendChild(bar);
      window.app.workspace.trigger("layout-change");
    });
    await wait(300);
    const clear = await page.evaluate(() => { const r = document.querySelector(".blyg-reader"); const bar = document.querySelector(".mobile-navbar"); const sc = document.querySelector(".blyg-reader-bodywrap").getBoundingClientRect(); return { pad: getComputedStyle(r).paddingBottom, bottom: sc.bottom, top: bar.getBoundingClientRect().top }; });
    check(parseFloat(clear.pad) > 0 && clear.bottom <= clear.top + 1, `${layout}: bottom bar: the pane ends above it (padding ${clear.pad}, pane bottom ${Math.round(clear.bottom)}, bar top ${Math.round(clear.top)})`);
    await page.evaluate(() => document.querySelector(".mobile-navbar")?.remove());
    let hops = 0;
    while (hops < 30 && (await page.$(".blyg-reader-header .blyg-reader-nextbtn"))) {
      await page.evaluate(() => document.querySelector(".blyg-reader-header .blyg-reader-nextbtn")?.click());
      await wait(1700);
      hops++;
    }
    check(hops >= 1 && (await page.$(".blyg-reader-card")) !== null && (await text(".blyg-reader-status")).some((t) => t.includes("No more unread")), `${layout}: next: the last post goes back to the feed and says so (${hops} taps)`);
    check(await resetReadMarks(), `${layout}: next: housekeeping afterwards`);
    await closeReader();
  }

  /** The reading surface (contrast, quotes), the large Back, the feed's choices that survive a restart, and the list that shows itself while it arrives. */
  async function surface(layout) {
    await openReader();
    await wait(1000);
    // Quotes in the text view: a plain quote and a blyg's quote look different from the body, and from each other.
    await showText('<p>Body words.</p><blockquote><p>A plain quote.</p></blockquote><blockquote class="blyg-transclusion" data-blyg-id="abc" data-blyg-version="1"><p>A blyg quote.</p></blockquote><blockquote class="blyg-transclusion blyg-partial" data-blyg-id="abc" data-blyg-version="1"><p>A passage.</p></blockquote>');
    const look = await page.evaluate(() => {
      const cs = (e, pseudo) => getComputedStyle(e, pseudo);
      const body = document.querySelector(".blyg-reader-body p");
      const [plain, whole, part] = [...document.querySelectorAll(".blyg-reader-body blockquote")];
      return {
        surface: cs(document.querySelector(".blyg-reader-surface")).backgroundColor, page: cs(document.querySelector(".blyg-reader-header")).backgroundColor,
        bodyColor: cs(body).color, plainColor: cs(plain.querySelector("p")).color, plainBar: cs(plain).borderLeftColor, wholeBar: cs(whole).borderLeftColor,
        wholeLabel: cs(whole, "::before").content, partLabel: cs(part, "::before").content, plainLabel: cs(plain, "::before").content,
      };
    });
    await shot(`${layout}-surface-quotes`);
    check(look.surface !== look.page, `${layout}: surface: the reading surface has its own ground (${look.surface} against ${look.page})`);
    check(look.plainColor !== look.bodyColor && look.plainBar !== "rgba(0, 0, 0, 0)", `${layout}: quotes: a plain quote has a bar and lighter type (${look.plainColor} against ${look.bodyColor})`);
    check(look.wholeBar !== look.plainBar && /Quote from a blyg/.test(look.wholeLabel) && /Passage from a blyg/.test(look.partLabel) && !/blyg/i.test(look.plainLabel), `${layout}: quotes: a blyg's quote has its own bar and label, a passage says so (${look.wholeLabel} / ${look.partLabel})`);
    // Three contrasts: the text colour differs, and the choice is in the settings.
    const inks = {};
    for (const c of ["reduced", "normal", "high"]) {
      await page.evaluate((v) => { const b = window.app.plugins.plugins.blyg; b.settings.readerPane.contrast = v; window.app.workspace.getLeavesOfType("blyg-reader")[0].view.applyFont(); }, c);
      inks[c] = await page.evaluate(() => getComputedStyle(document.querySelector(".blyg-reader-body p")).color);
    }
    check(new Set(Object.values(inks)).size === 3, `${layout}: contrast: reduced, normal and high give three different text colours (${JSON.stringify(inks)})`);
    await page.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.contrast = "normal"; window.app.workspace.getLeavesOfType("blyg-reader")[0].view.applyFont(); });
    // The way back is large and first.
    await page.evaluate(() => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; v.drawHeader(); });
    const back = await page.evaluate(() => { const b = document.querySelector(".blyg-reader-header .blyg-reader-back"); const r = b.getBoundingClientRect(); const first = document.querySelector(".blyg-reader-header .blyg-reader-btn"); return { h: r.height, w: r.width, firstIsBack: first === b, text: b.textContent }; });
    check(back.h >= 40 && back.firstIsBack && back.text === "Back", `${layout}: back: large (${Math.round(back.w)} x ${Math.round(back.h)}) and the first button`);
    await closeReader();

    // The feed's choices are kept across a restart: set them, drop the view, build a new one from the settings.
    await openReader();
    await wait(1000);
    await page.evaluate(async () => {
      const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      v.filter.sort = "oldest"; v.filter.unreadOnly = true; v.filter.length = "short";
      v.saveFilter();
    });
    await wait(500);
    const kept = await page.evaluate(async () => {
      const b = window.app.plugins.plugins.blyg;
      const onDisk = JSON.parse(await window.app.vault.adapter.read(`${window.app.vault.configDir}/plugins/${b.manifest.id}/data.json`)).readerPane.filter;
      return onDisk;
    });
    check(kept.sort === "oldest" && kept.unreadOnly === true && kept.length === "short", `${layout}: kept: the choices are in the settings file (${JSON.stringify(kept)})`);
    await closeReader();
    await openReader(true);
    await wait(1000);
    const again = await page.evaluate(() => { const f = window.app.workspace.getLeavesOfType("blyg-reader")[0].view.filter; return { ...f }; });
    check(again.sort === "oldest" && again.unreadOnly === true && again.length === "short", `${layout}: kept: a reader opened afterwards starts with them (${JSON.stringify(again)})`);
    await page.evaluate(async () => {
      const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      v.filter.sort = "newest"; v.filter.unreadOnly = false; v.filter.length = "any";
      v.saveFilter();
    });
    await wait(500);
    // A blyg that is no longer read cannot stay chosen.
    await page.evaluate(async () => { const b = window.app.plugins.plugins.blyg; b.settings.readerPane.filter.source = "gone-sub"; });
    await closeReader();
    await openReader(true);
    await wait(1200);
    const src = await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.filter.source);
    check(src === null && (await page.$(".blyg-reader-card")) !== null, `${layout}: kept: a blyg that is no longer read is dropped from the choices, and the feed is not empty`);
    await closeReader();

    // Progress: the list shows itself as pages arrive, and the status counts them.
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader"));
    await page.waitForSelector(".blyg-reader-header", { timeout: 20000 });
    await page.waitForSelector(".blyg-reader-card", { timeout: 20000 });
    const seen = await page.evaluate(async () => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      const real = await view.host.load();
      const log = [];
      view.host.load = async (onProgress) => {
        onProgress(real.data.posts.slice(0, 1));
        await new Promise((r) => setTimeout(r, 400));
        log.push({ status: document.querySelector(".blyg-reader-status")?.textContent, cards: document.querySelectorAll(".blyg-reader-card").length });
        onProgress(real.data.posts);
        await new Promise((r) => setTimeout(r, 400));
        log.push({ status: document.querySelector(".blyg-reader-status")?.textContent, cards: document.querySelectorAll(".blyg-reader-card").length });
        return real;
      };
      view.data = null;
      await view.reload();
      log.push({ status: document.querySelector(".blyg-reader-status")?.textContent, cards: document.querySelectorAll(".blyg-reader-card").length });
      return { log, total: real.data.posts.length };
    });
    check(seen.log[0].status === "Loading… 1 post so far" && seen.log[0].cards === 1 && seen.log[1].cards === seen.total && !/Loading/.test(seen.log[2].status), `${layout}: progress: the first posts show at once and the status counts them (${JSON.stringify(seen.log)})`);
    await closeReader();
  }

  /** Under a blyg's quote: where it comes from (a post of a blyg you read opens here, Back returns), and the quote of an unknown item keeps only its label. */
  async function quoteSource(layout) {
    await openReader();
    await wait(1000);
    const ids = await page.evaluate(() => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; return { a: v.data.posts[0].remoteId, b: v.data.posts[1].remoteId, title: v.data.posts[1].subscriptionTitle }; });
    await showText(`<p>Words.</p><blockquote class="blyg-transclusion" data-blyg-id="${ids.b}" data-blyg-version="1"><p>Quoted.</p></blockquote><blockquote class="blyg-transclusion" data-blyg-id="nosuchitem1" data-blyg-version="1"><p>Unknown source.</p></blockquote>`);
    await wait(500);
    const lines = await text(".blyg-quote-source");
    check(lines.length === 1 && lines[0].startsWith("↗") && lines[0].includes(ids.title), `${layout}: quote source: a quote of a post you read names where it comes from (${JSON.stringify(lines)})`);
    await page.evaluate(() => document.querySelector(".blyg-quote-source.is-link")?.click());
    await wait(600);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId)) === ids.b, `${layout}: quote source: a tap opens that post here`);
    check((await page.evaluate(() => document.querySelector(".blyg-reader-back")?.getAttribute("title"))) === "Back to the post you came from", `${layout}: quote source: Back says it returns to the post you came from`);
    await click("Back");
    await wait(400);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId)) === ids.a, `${layout}: quote source: Back returns to the post with the quote`);
    await click("Back");
    await wait(400);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown)) === null && (await page.$(".blyg-reader-card")) !== null, `${layout}: quote source: and one more Back is the list`);
    await closeReader();
  }

  /** Mentions: what they are about is drawn, a mention opens like a post, and a post the Studio does not read has no read mark or reply. */
  async function mentions(layout) {
    await openReader();
    await wait(1000);
    await page.evaluate(() => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.mentions = [{ id: "m1", targetItemId: "t1", relation: "stub", status: "verified", hidden: false, sourceOrigin: "https://far.example", sourceId: "z1", sourcePage: null, sourceAuthorName: "Far Author", firstSeen: new Date().toISOString() }, { id: "m2", targetItemId: "t1", relation: "stub", status: "gone", hidden: false, sourceOrigin: "https://far.example", sourceId: "z2", sourcePage: null, sourceAuthorName: "Gone", firstSeen: new Date().toISOString() }];
      view.host.mentionPost = async (m) => ({ subscriptionId: "", subscriptionTitle: "Far", origin: m.sourceOrigin, remoteId: m.sourceId, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: m.firstSeen, created: m.firstSeen, isReply: true, contentHtml: "<p>Reply words here</p>", contentMd: "", authorName: m.sourceAuthorName, authorUrl: null, sourceUrl: null });
      view.host.ownExcerpt = async () => "my own words";
      view.tab = "mentions";
      view.draw();
    });
    await wait(800);
    const rows = await text(".blyg-reader-mention");
    check(rows.length === 1 && rows[0].includes("Far Author replied to your item") && rows[0].includes("Reply words here") && rows[0].includes("On: my own words"), `${layout}: mentions: a row says who, what they wrote and what it was about (${JSON.stringify(rows).slice(0, 150)})`);
    await page.evaluate(() => document.querySelector(".blyg-reader-mention")?.click());
    await wait(600);
    const open = await page.evaluate(() => ({ body: document.querySelector(".blyg-reader-body")?.textContent ?? "", btns: [...document.querySelectorAll(".blyg-reader-header button")].map((b) => [b.textContent?.trim(), b.disabled]), next: document.querySelectorAll(".blyg-reader-nextbtn").length }));
    check(open.body.includes("Reply words here"), `${layout}: mentions: tapping one opens the post in the reader`);
    check(open.btns.some(([t, d]) => t === "Reply" && d === true) && open.btns.some(([t, d]) => /Mark read/.test(t ?? "") && d === true), `${layout}: mentions: a post of a blyg the Studio does not read has no read mark and no reply here`);
    check(open.next === 0, `${layout}: mentions: no "next" for a post that is not in the feed`);
    await click("Back");
    await wait(400);
    check((await page.$(".blyg-reader-mention")) !== null, `${layout}: mentions: back to the list of mentions`);
    await closeReader();
  }

  await refusal();
  FULL = await mintFullToken();
  await useToken(FULL); // set once: the rest of the scenario uses a token with every permission
  await ribbon();
  await freshness();
  await textFirst();
  await noFrame();
  await markup();
  await bypasses();
  await images();
  await readMarks();
  await staleReload();
  await readingTime();
  await font();
  await sidebar();
  await defaultView();
  await quoteSource("desktop");
  await surface("desktop");
  await nextPost("desktop");
  await mentions("desktop");
  await pass("desktop");
  await s.phone();
  await quoteSource("phone");
  await surface("phone");
  await nextPost("phone");
  await mentions("phone");
  await pass("phone");
  imageServer.close();
});
