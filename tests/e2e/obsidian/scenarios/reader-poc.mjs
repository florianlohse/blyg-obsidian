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
  /** The open post's read mark is one pill in the thumb row ("3 of 24" with a ring or a check); its state is in its label and class. */
  const pillClick = () => page.evaluate(() => { const b = document.querySelector(".blyg-reader-header .blyg-reader-readpill"); if (!b || b.disabled) return false; b.click(); return true; });
  const pillState = () => page.evaluate(() => { const b = document.querySelector(".blyg-reader-header .blyg-reader-readpill"); return b ? { read: b.classList.contains("is-read"), label: b.getAttribute("aria-label") ?? "", disabled: b.disabled } : null; });
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
    check(options.length === 3 && options[0].includes("Newest") && options[0].includes("Longest read") && options[1].some((o) => /^Blog B \(\d+\)$/.test(o ?? "")) && options[2].includes("< 2 min"), `${layout}: order, blyg and length choices are there, and no font or contrast choice (those live in the settings) (${JSON.stringify(options.map((o) => o.length))} entries)`);
    check((await text(".blyg-reader-chip")).some((t) => t.includes("Unread only")), `${layout}: the "Unread only" switch is there`);
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

    // A post opens as text, with its buttons in the header.
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(800);
    const body = (await text(".blyg-reader-body"))[0] ?? "";
    check(body.length > 0 && (await page.$(".blyg-reader-frame")) === null, `${layout}: tapping a post shows it as text, never in a frame (${body.length} characters)`);
    const buttons = await text(".blyg-reader-header button");
    check(["Reader", "Reply", "Next"].every((b) => buttons.includes(b)) && (await pillState())?.label === "Mark read" && !buttons.includes("Browser") && !buttons.includes("As text") && !buttons.includes("As web page"), `${layout}: the post's buttons are in the header (way out, read mark, Reply, Previous / Next), with no switch to a web page: ${buttons.join(", ")}`);
    const links = await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-postmeta a.blyg-reader-link")].map((a) => a.getAttribute("href")));
    check(links.length >= 1 && links[0].startsWith("http://localhost:8788"), `${layout}: the post's blyg is a link to its page (${links.join(", ")})`);
    check((await text(".blyg-reader-postmeta")).some((t) => /^.+·\s*\d+ min read/.test(t)) && !(await text(".blyg-reader-postmeta")).some((t) => /unread|✓ read/.test(t)) && await page.evaluate(() => { const r = document.querySelector(".blyg-reader-postmeta .blyg-reader-readtime"); return !!r && Number(getComputedStyle(r).fontWeight) >= 600; }), `${layout}: the post's one line of small print puts the reading time first and in bold, and does not repeat the read state`);
    await shot(`${layout}-2-text`);
    check(await page.evaluate(() => getComputedStyle(document.querySelector(".blyg-reader-body")).userSelect === "text"), `${layout}: the text of a post can be selected`);

    // A selection in the post: the line under the action bar says how many characters Reply will quote (increment 6; what the reply then writes is covered by the unit tests of passageFromSelection and by the demo vault's shot script).
    const picked = await page.evaluate(() => {
      // The visible post (earlier steps can leave another reader view open, whose post is hidden).
      const shown = [...document.querySelectorAll(".blyg-reader-surface .blyg-reader-body")].find((el) => el.offsetParent !== null) ?? document.querySelector(".blyg-reader-surface .blyg-reader-body");
      const w = document.createTreeWalker(shown, NodeFilter.SHOW_TEXT);
      let n; let node = null;
      while ((n = w.nextNode())) if (n.textContent.trim().length > 20) { node = n; break; }
      if (!node) return "";
      const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 20);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r); return sel.toString();
    });
    await page.waitForFunction(() => /^Reply quotes the \d+ selected characters\.$/.test(document.querySelector(".blyg-reader-replyhint")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
    const replyState = await page.evaluate(() => ({ hint: document.querySelector(".blyg-reader-replyhint")?.textContent ?? "", labels: [...document.querySelectorAll(".blyg-reader-replybtn")].map((b) => b.textContent) }));
    check(picked !== "" && /^Reply quotes the \d+ selected characters\.$/.test(replyState.hint) && replyState.labels.every((l) => l === "Reply"), `${layout}: selecting text in a post shows what Reply will quote, and the button keeps its word (selected ${JSON.stringify(picked)}; ${JSON.stringify(replyState)})`);
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await wait(1800); // the hint goes away once the selection has been gone for a moment

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
    check(await pillClick(), "refusal: the read mark can be tapped with the app's own token");
    await wait(1500);
    const status = (await text(".blyg-reader-status"))[0] ?? "";
    check(/reading:state/.test(status) && (await pillState())?.read === false, `refusal: it is explained in words and the mark is put back: "${status.slice(0, 80)}"`);
    await closeReader();
  }

  /** Read marks with a token that has the permission: shown at once (card and header), kept after a refresh, undone at a tap, and a stale list does not undo them. */
  async function readMarks() {
    check(await resetReadMarks(), "read marks: every post starts unread (housekeeping)");
    await openReader();
    await wait(1500);
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(800);
    const barWidth = () => page.evaluate(() => Math.round(document.querySelector(".blyg-reader-header .blyg-reader-replybtn")?.getBoundingClientRect().left ?? 0));
    const widthBefore = await barWidth();
    await page.evaluate(() => { window.__t0 = performance.now(); document.querySelector(".blyg-reader-header .blyg-reader-readpill")?.click(); });
    const instant = await page.evaluate(() => ({ read: document.querySelector(".blyg-reader-header .blyg-reader-readpill")?.classList.contains("is-read") ?? false, label: document.querySelector(".blyg-reader-header .blyg-reader-readpill")?.getAttribute("aria-label") ?? "", meta: document.querySelector(".blyg-reader-postmeta")?.textContent ?? "", ms: performance.now() - window.__t0 }));
    check(instant.read && /^Read/.test(instant.label) && instant.ms < 100, `read marks: marking read shows at once in the post's header (${Math.round(instant.ms)} ms, "${instant.label}")`);
    check(widthBefore > 0 && (await barWidth()) === widthBefore, `read marks: Reply stays where it is when the read mark changes (${widthBefore} px from the left, then ${await barWidth()} px)`);
    await wait(1500);
    check(await click("Reader"), "read marks: Reader goes back to the feed");
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
    const opened = await click("Sort & filter");
    if (!opened) console.error("  (no “Sort & filter” button; the reader has:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".blyg-reader button")].map((b) => b.textContent?.trim()))), ")");
    check(opened, "reading time: the choices open");
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

  /** The font of a post; the interface keeps Obsidian's. */
  async function font() {
    await openReader();
    await wait(1000);
    // The font is a setting only (the header has no font choice); the pane follows the setting when the reader redraws.
    await page.evaluate(() => {
      window.app.plugins.plugins.blyg.settings.readerPane.font = "serif";
      window.app.workspace.getLeavesOfType("blyg-reader")[0].view.applyFont();
    });
    await wait(500);
    check(await page.evaluate(() => window.app.plugins.plugins.blyg.settings.readerPane.font === "serif" && document.querySelector(".blyg-reader")?.classList.contains("is-font-serif")), "font: the setting reaches the pane");
    // text view
    await page.evaluate(() => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.shown = view.data.posts[0];
        view.draw();
    });
    await wait(500);
    const textFont = await page.evaluate(() => ({ body: getComputedStyle(document.querySelector(".blyg-reader-body")).fontFamily, ui: getComputedStyle(document.querySelector(".blyg-reader-btn")).fontFamily }));
    check(/Iowan|Palatino|Georgia/.test(textFont.body) && !/Iowan/.test(textFont.ui), `font: the text view's content is serif and the buttons keep Obsidian's font (${textFont.body.slice(0, 30)} / ${textFont.ui.slice(0, 20)})`);
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
    // Refresh waits a minute between asks of the blygs; the test resets the pause, as a person waiting would.
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
    const checkedWords = await page.evaluate(() => document.querySelector(".blyg-reader-status")?.textContent ?? "");
    check(/checked (just now|\d+ min ago)$/.test(checkedWords), `freshness: it says how long ago it checked, not a clock time ("${checkedWords}")`);
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
    // What a post may not carry is left out and its text stays: the post is drawn, a small line says formatting was left out, and nothing is requested or run.
    for (const [html, name] of [['<p>x</p><iframe src="http://127.0.0.1:18999/pixel-m4.png">fb</iframe><p>y</p>', "iframe"], ["<p>x</p><script>window.__pwned=1</script><p>y</p>", "script"], ["<p>x</p><svg onload=\"window.__pwned=2\"></svg><p>y</p>", "svg"], ["<p>x</p><!-- c --><p>y</p>", null]]) {
      await showText(html);
      const got = await page.evaluate(() => ({ body: document.querySelector(".blyg-reader-body")?.textContent ?? "", note: document.querySelector(".blyg-reader-formatnote")?.textContent ?? "", blocked: !!document.querySelector(".blyg-reader-blocked"), pwned: window.__pwned ?? null }));
      check(!got.blocked && got.body.includes("x") && got.body.includes("y") && got.pwned === null && hits === 0 && (name === null ? got.note === "" : got.note.includes(`<${name}>`)), `a post with ${name ? `<${name}>` : "a comment"} is drawn without it; ${name ? `a line says formatting was left out ("${got.note.slice(0, 60)}")` : "nothing is said"}; nothing is requested or run`);
    }
    // The spec's own markup: generated text is marked, and a quote carries its origin and label.
    await showText('<div class="blyg-tk-gen"><p>Generated block.</p></div><p>a <span class="blyg-tk-gen">generated</span> word</p><blockquote class="blyg-transclusion" data-blyg-id="zz9" data-blyg-version="1" data-blyg-origin="https://remote.example/" data-blyg-label="the original"><p>Quoted.</p></blockquote>');
    const spec = await page.evaluate(() => ({ tk: document.querySelectorAll(".blyg-reader-body .blyg-tk-gen").length, title: document.querySelector(".blyg-reader-body .blyg-tk-gen")?.getAttribute("title") ?? "", bq: document.querySelector(".blyg-reader-body blockquote")?.getAttribute("data-blyg-origin"), note: !!document.querySelector(".blyg-reader-formatnote"), blocked: !!document.querySelector(".blyg-reader-blocked") }));
    check(spec.tk === 2 && /generated text/.test(spec.title) && spec.bq === "https://remote.example/" && !spec.note && !spec.blocked, `the spec's own markup is drawn, not refused (generated text marked, quote origin kept; ${JSON.stringify(spec)})`);
    await closeReader();
  }

  /** The entries of the menu: two plainly named ribbon entries (the mobile menu lists them). */
  async function ribbon() {
    const labels = await page.evaluate(() => [...document.querySelectorAll(".side-dock-ribbon-action")].map((e) => e.getAttribute("aria-label")));
    check(labels.includes("Open Blyg reader") && labels.includes("Open Blyg panel") && !labels.includes("Open panel"), `the ribbon (the mobile menu) has "Open Blyg reader" and "Open Blyg panel" (${labels.filter((l) => /Open/.test(l ?? "")).join(", ")})`);
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

  /** Previous / Next at the foot of an open post (a tap steps, holding Next marks read and steps), and the measured clearance for Obsidian's bottom bar. */
  async function nextPost(layout) {
    await openReader();
    await wait(1000);
    check(await resetReadMarks(), `${layout}: next: every post starts unread`);
    check((await page.$(".blyg-reader-steps")) === null, `${layout}: next: no previous / next in the feed`);
    await page.evaluate(() => document.querySelector(".blyg-reader-card")?.click());
    await wait(500);
    check((await page.$(".blyg-reader-header .blyg-reader-steps .blyg-reader-step-next")) !== null && (await page.$(".blyg-reader-stepbar")) === null && (await page.$(".blyg-reader-nextbtn")) === null, `${layout}: next: previous / next are in the header's thumb row, there is no bar of their own, and there is no "Read & next" button`);
    check((await page.$(".blyg-reader-postfoot")) === null, `${layout}: next: no bar below the post's text`);
    // Previous / Next through the feed (a tap steps, a long press on Next marks the post read and steps).
    const steps = () => page.evaluate(() => { const c = document.querySelector(".blyg-reader-stepcount")?.textContent ?? ""; const m = /^(\d+) of (\d+)$/.exec(c); const nx = document.querySelector(".blyg-reader-step-next"); return { i: m ? Number(m[1]) : 0, n: m ? Number(m[2]) : 0, prevOff: document.querySelector(".blyg-reader-step-prev")?.disabled, nextOff: nx?.disabled, h: nx?.getBoundingClientRect().height ?? 0, inHeader: !!nx && !!nx.closest(".blyg-reader-header") }; });
    const shownId = () => page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId);
    const s0 = await steps();
    check(s0.n >= 3 && s0.i >= 1 && s0.inHeader && s0.h >= 28 && s0.nextOff === false, `${layout}: steps: the read mark shows the place in the feed (${s0.i} of ${s0.n}), the buttons are in the header, tall enough to tap (${Math.round(s0.h)} px)`);
    const here = await shownId();
    await page.evaluate(() => document.querySelector(".blyg-reader-step-next")?.click());
    await wait(500);
    const s1 = await steps();
    check((await shownId()) !== here && s1.i === s0.i + 1, `${layout}: steps: Next opens the following post (${s1.i} of ${s1.n})`);
    const readBefore = await page.evaluate((id) => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.data.posts.find((p) => p.remoteId === id)?.readVersion, here);
    await page.evaluate(() => document.querySelector(".blyg-reader-step-prev")?.click());
    await wait(500);
    check((await shownId()) === here && (await steps()).i === s0.i, `${layout}: steps: Previous comes back to the post`);
    const readAfter = await page.evaluate((id) => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.data.posts.find((p) => p.remoteId === id)?.readVersion, here);
    check(readAfter === readBefore, `${layout}: steps: stepping alone does not change a read mark`);
    // Hold Next: this post is marked read, and the next one opens.
    await page.evaluate(() => document.querySelector(".blyg-reader-step-next")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await wait(800);
    await page.evaluate(() => document.querySelector(".blyg-reader-step-next")?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    await wait(1500);
    const held = await page.evaluate((id) => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; return { now: v.shown?.remoteId, was: v.data.posts.find((p) => p.remoteId === id)?.readVersion }; }, here);
    check(held.now !== here && held.now !== undefined && held.was !== null && held.was !== undefined, `${layout}: steps: holding Next marks the post read and goes on`);
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
    check(back.h >= 32 && back.firstIsBack && back.text === "Reader", `${layout}: reader button: tall enough to tap (${Math.round(back.w)} x ${Math.round(back.h)}) and the first button`);
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
    await showText(`<p>Words.</p><blockquote class="blyg-transclusion" data-blyg-id="${ids.b}" data-blyg-version="1"><p>Quoted.</p></blockquote><blockquote class="blyg-transclusion" data-blyg-id="nosuchitem1" data-blyg-version="1" data-blyg-origin="https://remote.example/" data-blyg-label="my label"><p>Unknown source.</p></blockquote>`);
    await wait(500);
    const lines = await text(".blyg-quote-source");
    check(lines.length === 2 && !/[↗↩]/.test(lines[0]) && lines[0].includes(ids.title), `${layout}: quote source: a quote of a post you read names where it comes from (${JSON.stringify(lines)})`);
    check(lines[1] === "my label · remote.example", `${layout}: quote source: a quote of another blyg's item shows the author's label and the blyg's host (${JSON.stringify(lines[1])})`);
    await page.evaluate(() => document.querySelector(".blyg-quote-source.is-link")?.click());
    await wait(600);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId)) === ids.b, `${layout}: quote source: a tap opens that post here`);
    check((await page.evaluate(() => document.querySelector(".blyg-reader-back")?.getAttribute("title"))) === "Back to the post you came from", `${layout}: quote source: Back says it returns to the post you came from`);
    await click("Back");
    await wait(400);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId)) === ids.a, `${layout}: quote source: Back returns to the post with the quote`);
    check((await text(".blyg-reader-back"))[0] === "Reader", `${layout}: quote source: with no trail left the button says Reader`);
    await click("Reader");
    await wait(400);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown)) === null && (await page.$(".blyg-reader-card")) !== null, `${layout}: quote source: and one more Back is the list`);
    await closeReader();
  }

  /** Buttons take the theme's own shape (no radius of ours) and scale from the theme's input height, so a pill has room for its text. */
  async function buttons(layout) {
    await openReader();
    await wait(800);
    const look = await page.evaluate(() => {
      const root = document.querySelector(".blyg-reader");
      const plain = document.createElement("button");
      root.appendChild(plain);
      const ref = getComputedStyle(plain).borderTopLeftRadius;
      plain.remove();
      const rows = [...document.querySelectorAll(".blyg-reader-btn")].map((b) => { const c = getComputedStyle(b); const r = b.getBoundingClientRect(); return { radius: c.borderTopLeftRadius, h: r.height, pad: parseFloat(c.paddingLeft) }; });
      return { ref, rows };
    });
    check(look.rows.length > 0 && look.rows.every((r) => r.radius === look.ref), `${layout}: buttons: the shape is the theme's own (${look.ref}) on all ${look.rows.length} buttons`);
    check(look.rows.every((r) => r.pad >= r.h * 0.35), `${layout}: buttons: the side padding scales with the height, so a round shape has room (${look.rows.map((r) => Math.round(r.pad) + "/" + Math.round(r.h)).join(" ")})`);
    await closeReader();
  }

  /**
   * Starting Obsidian with a reader tab open: Obsidian waits for a view to finish opening before it finishes restoring the layout, so opening must not wait
   * for the Studio. With a Studio that answers after 6 seconds, the view is open at once, shows its saved list or "Loading", and the answer arrives behind it.
   */
  async function opensQuickly() {
    await page.evaluate(() => {
      const b = window.app.plugins.plugins.blyg;
      if (!b.__origHost) b.__origHost = b.readerHost.bind(b);
      b.readerHost = () => {
        const h = b.__origHost();
        const load = h.load.bind(h);
        h.load = async (...a) => { await new Promise((r) => setTimeout(r, 6000)); return load(...a); };
        return h;
      };
    });
    const ms = await page.evaluate(async () => {
      const t0 = performance.now();
      const leaf = window.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: "blyg-reader", active: true });
      return Math.round(performance.now() - t0);
    });
    check(ms < 2500, `opening: the reader view is open in ${ms} ms although the Studio answers only after 6 s (Obsidian waits for this when it restores the layout)`);
    check(await page.evaluate(() => !!document.querySelector(".blyg-reader-header")), "opening: the header is there at once");
    await page.waitForSelector(".blyg-reader-card", { timeout: 20000 });
    check(true, "opening: and the list arrives behind it");
    await page.evaluate(() => { const b = window.app.plugins.plugins.blyg; if (b.__origHost) { b.readerHost = b.__origHost; delete b.__origHost; } });
    await closeReader();
  }

  /** Reading less: opening asks nothing of the blygs, Refresh reads the list once, the list is saved for the next session and shows at once, and a failing Studio is left alone. */
  async function economy(layout) {
    await page.evaluate(() => {
      const b = window.app.plugins.plugins.blyg;
      window.__calls = { load: 0, checkForNew: 0, changeMarks: 0, readCache: 0 };
      if (!b.__origHost) b.__origHost = b.readerHost.bind(b);
      b.readerHost = () => {
        const h = b.__origHost();
        for (const k of Object.keys(window.__calls)) { const f = h[k].bind(h); h[k] = (...a) => { window.__calls[k]++; return f(...a); }; }
        return h;
      };
    });
    await openReader();
    await page.waitForFunction(() => !/^Loading|updating/.test(document.querySelector(".blyg-reader-status")?.textContent ?? ""), null, { timeout: 20000 }).catch(() => {});
    const opened = await page.evaluate(() => ({ ...window.__calls }));
    check(opened.checkForNew === 0 && opened.load >= 1 && opened.readCache === 1, `${layout}: economy: opening the reader asks no blyg to be checked, only reads the list (${JSON.stringify(opened)})`);
    // Refresh: one read of the list at the end, however often the counters moved
    await publishOnBlogB(`${Date.now().toString(36)} economy. A new post.`);
    await page.evaluate(() => { window.app.plugins.plugins.blyg.readerCheckedAt = 0; window.__calls = { load: 0, checkForNew: 0, changeMarks: 0, readCache: 0 }; });
    check(await click("Refresh"), `${layout}: economy: Refresh can be tapped`);
    await page.waitForFunction(() => /checked (just now|\d+ min ago)$/.test(document.querySelector(".blyg-reader-status")?.textContent ?? ""), null, { timeout: 45000 }).catch(() => {});
    const refreshed = await page.evaluate(() => ({ ...window.__calls }));
    check(refreshed.checkForNew === 1 && refreshed.load === 1 && refreshed.changeMarks >= 2, `${layout}: economy: Refresh asks the blygs once and reads the list once (${JSON.stringify(refreshed)})`);
    // the saved list
    await wait(3600);
    const saved = await page.evaluate(async () => {
      const b = window.app.plugins.plugins.blyg;
      const path = `${b.manifest.dir}/reader-cache.json`;
      if (!(await window.app.vault.adapter.exists(path))) return null;
      const f = JSON.parse(await window.app.vault.adapter.read(path));
      return { posts: f.posts.length, mdLeft: f.posts.filter((p) => p.contentMd !== "").length, origin: f.origin, inVaultNotes: window.app.vault.getMarkdownFiles().filter((x) => /reader-cache/.test(x.path)).length };
    });
    check(saved !== null && saved.posts > 0 && saved.mdLeft === 0 && saved.inVaultNotes === 0, `${layout}: economy: the list is saved for the next session in the plugin's own folder, without the posts' Markdown (${JSON.stringify(saved)})`);
    await closeReader();
    // the saved list shows at once, even while the Studio is not answering; and it says so in words
    await page.evaluate(() => { window.app.plugins.plugins.blyg.readerTrouble = { failures: 2, until: Date.now() + 120000 }; });
    await openReader();
    const cached = await page.evaluate(() => ({ cards: document.querySelectorAll(".blyg-reader-card").length, status: document.querySelector(".blyg-reader-status")?.textContent ?? "" }));
    check(cached.cards > 0, `${layout}: economy: the saved list shows at once (${cached.cards} cards)`);
    await wait(1500);
    const backed = await page.evaluate(() => document.querySelector(".blyg-reader-status")?.textContent ?? "");
    check(/not answering; the reader tries again in about \d+ min/.test(backed), `${layout}: economy: a failing Studio is left alone and the status says when the reader tries again ("${backed.slice(0, 90)}")`);
    await page.evaluate(() => { window.app.plugins.plugins.blyg.readerTrouble = { failures: 0, until: 0 }; });
    await closeReader();
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:clear-reader-cache"));
    await wait(500);
    check(await page.evaluate(async () => !(await window.app.vault.adapter.exists(`${window.app.plugins.plugins.blyg.manifest.dir}/reader-cache.json`))), `${layout}: economy: "Clear the reader's saved list" removes it`);
    await page.evaluate(() => { const b = window.app.plugins.plugins.blyg; if (b.__origHost) { b.readerHost = b.__origHost; delete b.__origHost; } });
  }

  /** The replies chip of an open post: your own reply (green), replies in blygs you read, the list they open, and what a tap does. */
  async function responses(layout) {
    await openReader();
    // The list arrives in pages: wait for the whole of it, or the objects put in below would be replaced when it lands.
    await page.waitForFunction(() => !/^Loading/.test(document.querySelector(".blyg-reader-status")?.textContent ?? ""), null, { timeout: 20000 }).catch(() => {});
    await wait(1000);
    await page.evaluate(async () => {
      const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      // Put the stub into whatever list the reader holds, and into every list that arrives later (a check for new posts reloads quietly).
      const realLoad = v.host.load;
      const inject = (posts) => { const [a, b] = posts; a.origin = a.origin ?? "https://blog-b.example"; b.stubTarget = { origin: a.origin, id: a.remoteId }; };
      v.host.load = async (cb) => { const r = await realLoad(cb); if (r.ok) inject(r.data.posts); return r; };
      await v.reload(true);
      const [a] = v.data.posts;
      window.__opened = [];
      v.host.myItems = async () => [{ id: "myreply1", revision: 1, kind: "thread", status: "public", version: 1, contentMd: "My own reply words.", dirty: false, stubOf: { origin: a.origin, id: a.remoteId, version: 1 }, published: null, created: new Date().toISOString() }];
      v.host.openOwnItem = async (id) => { window.__opened.push(id); return true; };
      v.mine = null; v.mineAsked = false;
      v.openPost(a);
    });
    await wait(800);
    const chip = await page.evaluate(() => { const c = document.querySelector(".blyg-reader-resp"); return c ? { text: c.textContent, mine: c.classList.contains("is-mine"), color: getComputedStyle(c).color } : null; });
    check(await page.evaluate(() => !!document.querySelector(".blyg-reader-resp .blyg-reader-icon svg")) && !/[\u21a9\u2197]/.test(chip?.text ?? ""), `${layout}: replies: the chip carries an icon of Obsidian's set, not an emoji character`);
    check(chip?.text === "You + 1" && chip.mine, `${layout}: replies: the chip says you replied, and one more reply in a blyg you read (${JSON.stringify(chip)})`);
    await page.evaluate(() => document.querySelector(".blyg-reader-resp")?.click());
    await wait(300);
    const cards = await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-response")].map((c) => ({ mine: c.classList.contains("is-mine"), badge: c.querySelector(".blyg-reader-badge")?.textContent ?? "", text: c.textContent })));
    check(cards.length === 2 && cards.some((c) => c.mine && c.badge === "You" && c.text.includes("My own reply words")) && cards.some((c) => !c.mine), `${layout}: replies: the list shows both as cards, yours marked (${JSON.stringify(cards.map((c) => [c.mine, c.badge]))})`);
    check(await page.evaluate(() => { const r = document.querySelector(".blyg-reader-responses"); return !!r && r.previousElementSibling?.classList.contains("blyg-reader-body") === true && r.parentElement?.classList.contains("blyg-reader-column") === true; }), `${layout}: replies: the list sits at the end of the post, under its text`);
    const green = await page.evaluate(() => getComputedStyle(document.querySelector(".blyg-reader-response.is-mine")).borderLeftColor);
    check(green !== "rgba(0, 0, 0, 0)" && green !== "rgb(0, 0, 0)", `${layout}: replies: your own are highlighted (${green})`);
    await page.evaluate(() => document.querySelector(".blyg-reader-response.is-mine")?.click());
    await wait(300);
    check((await page.evaluate(() => window.__opened)).join() === "myreply1", `${layout}: replies: a tap on yours opens its note`);
    await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-response")].find((c) => !c.classList.contains("is-mine"))?.click());
    await wait(600);
    const now = await page.evaluate(() => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; return { shown: v.shown?.remoteId, sheet: !!document.querySelector(".blyg-reader-responses"), second: v.data.posts[1].remoteId }; });
    check(now.shown === now.second && !now.sheet, `${layout}: replies: a tap on a post of a blyg you read opens it here (and that post has no replies of its own to list)`);
    await click("Back");
    await wait(400);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown?.remoteId)) === (await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.data.posts[0].remoteId)), `${layout}: replies: Back returns to the post you came from`);
    // The feed's cards carry the same badge: green when one of the replies is yours.
    await click("Reader");
    await wait(500);
    const badges = await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-resp-badge")].map((b) => [b.textContent, b.classList.contains("is-mine")]));
    check(badges.length === 1 && badges[0][0] === "You + 1" && badges[0][1] === true, `${layout}: replies: the post's card in the feed has the green badge too (${JSON.stringify(badges)})`);
    await page.evaluate(() => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; v.openPost(v.data.posts[0]); });
    await wait(400);
    // Without your own reply: a plain count.
    await page.evaluate(() => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; v.host.myItems = async () => []; v.mine = []; v.drawHeader(); });
    const plain = await page.evaluate(() => { const c = document.querySelector(".blyg-reader-resp"); return c ? { text: c.textContent, mine: c.classList.contains("is-mine") } : null; });
    check(plain?.text === "1 reply" && !plain.mine, `${layout}: replies: with none of yours it is a plain count (${JSON.stringify(plain)})`);
    await page.evaluate(() => { const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view; const [a, b] = v.data.posts; v.host.load = async () => ({ ok: true, data: { ...v.data, posts: v.data.posts.map((p) => (p === b ? { ...p, stubTarget: null } : p)) } }); b.stubTarget = null; v.respMemo = null; v.drawHeader(); });
    check((await page.$(".blyg-reader-resp")) === null, `${layout}: replies: and with nothing to see there is no chip`);
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
    check(rows.length === 1 && rows[0].includes("Far Author") && rows[0].includes("replied to you") && rows[0].includes("Reply words here") && rows[0].includes("On: my own words") && (await page.$(".blyg-reader-mention.blyg-reader-card .blyg-reader-badges")) !== null, `${layout}: mentions: drawn as a card like the feed's: who, what they did, what they wrote and what it was about (${JSON.stringify(rows).slice(0, 150)})`);
    await page.evaluate(() => document.querySelector(".blyg-reader-mention")?.click());
    await wait(600);
    const open = await page.evaluate(() => ({ body: document.querySelector(".blyg-reader-body")?.textContent ?? "", btns: [...document.querySelectorAll(".blyg-reader-header button")].map((b) => [b.textContent?.trim(), b.disabled]), next: document.querySelectorAll(".blyg-reader-steps").length }));
    check(open.body.includes("Reply words here"), `${layout}: mentions: tapping one opens the post in the reader`);
    check(open.btns.some(([t, d]) => t === "Reply" && d === true) && open.btns.some(([t, d]) => /Mark read/.test(t ?? "") && d === true), `${layout}: mentions: a post of a blyg the Studio does not read has no read mark and no reply here`);
    check(open.next === 0, `${layout}: mentions: no previous / next for a post that is not in the feed`);
    await click("Reader");
    await wait(400);
    check((await page.$(".blyg-reader-mention")) !== null, `${layout}: mentions: back to the list of mentions`);
    // Dismiss: the card goes at once and the Studio is asked (stubbed here, so the shared test data stays as it is); a refusal brings it back and says why.
    check((await text(".blyg-reader-mention .blyg-reader-dismiss"))[0] === "Dismiss", `${layout}: mentions: a card has a Dismiss button, with just that word`);
    await page.evaluate(() => {
      const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      window.__hid = [];
      v.host.hideMention = async (m) => { window.__hid.push(m.id); return { ok: false, message: "Your token cannot dismiss mentions. It needs the permission “owner:manage”." }; };
      document.querySelector(".blyg-reader-dismiss")?.click();
    });
    await wait(500);
    check((await page.evaluate(() => window.__hid.length)) === 1 && (await page.$(".blyg-reader-mention")) !== null && (await text(".blyg-reader-status")).some((t) => /owner:manage/.test(t)), `${layout}: mentions: a refused dismiss brings the card back and says why`);
    check((await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.shown)) === null, `${layout}: mentions: a tap on Dismiss does not open the post`);
    await page.evaluate(() => {
      const v = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      v.host.hideMention = async (m) => { window.__hid.push(m.id); return { ok: true }; };
      document.querySelector(".blyg-reader-dismiss")?.click();
    });
    await wait(500);
    check((await page.$(".blyg-reader-mention")) === null && (await text(".blyg-reader-header button")).some((t) => t === "Mentions (0)"), `${layout}: mentions: a dismissed mention is gone from the list and the count`);
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.reload(true)); // the Studio never hid it: it is back
    await wait(1500);
    await closeReader();
  }

  await refusal();
  FULL = await mintFullToken();
  await useToken(FULL); // set once: the rest of the scenario uses a token with every permission
  await ribbon();
  await freshness();
  await economy("desktop");
  await opensQuickly();
  await markup();
  await bypasses();
  await images();
  await readMarks();
  await staleReload();
  await readingTime();
  await font();
  await sidebar();
  await buttons("desktop");
  await responses("desktop");
  await quoteSource("desktop");
  await surface("desktop");
  await nextPost("desktop");
  await mentions("desktop");
  await pass("desktop");
  await s.phone();
  await buttons("phone");
  await responses("phone");
  await quoteSource("phone");
  await surface("phone");
  await nextPost("phone");
  await mentions("phone");
  await pass("phone");
  imageServer.close();
});
