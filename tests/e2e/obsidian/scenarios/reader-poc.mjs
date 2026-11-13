// PROOF OF CONCEPT (roadmap S15): the reader pane in real Obsidian, desktop and then phone layout, against a local Studio that holds one imported post
// (WITH_REMOTE=1). Drives like a person: command palette command, tap a post, tap Mark read, tap Reply. POC_SHOTS=<dir> saves a screenshot per step.
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… POC_SHOTS=/some/dir node tests/e2e/obsidian/scenarios/reader-poc.mjs
import { createServer } from "node:http";
import { fixtureData, runScenario, wait } from "../lib.mjs";

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

await runScenario({ data: fixtureData() }, async (s) => {
  const { check } = s;
  const page = s.page;
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

  async function pass(layout) {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-poc"));
    await page.waitForSelector(".blyg-reader-card", { timeout: 20000 }).catch(() => {});
    const cards = await text(".blyg-reader-card");
    check(cards.length > 0 && cards.some((c) => c.includes("Blog B")), `${layout}: the feed shows cards naming the blyg (${cards.length} cards)`);
    check((await text(".blyg-reader-card.is-unread .blyg-reader-badge.is-new")).length > 0, `${layout}: an unread post carries an "unread" badge`);
    const options = await page.evaluate(() => [...document.querySelectorAll(".blyg-reader-controls select")].map((s) => [...s.options].map((o) => o.textContent)));
    check(options.length === 2 && options[0].includes("Newest first") && options[1].some((o) => /^Blog B \(\d+\)$/.test(o ?? "")), `${layout}: order and blyg pickers are there (${JSON.stringify(options)})`);
    check((await text(".blyg-reader-toggle")).some((t) => t.includes("Unread only")), `${layout}: the "Unread only" switch is there`);
    await shot(`${layout}-1-feed`);

    // A post opens as its web page, sandboxed, inside Obsidian.
    const url = await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.data.posts.find((p) => p.sourceUrl)?.sourceUrl ?? null);
    await page.evaluate((u) => [...document.querySelectorAll(".blyg-reader-card")].find((c, i) => window.app.workspace.getLeavesOfType("blyg-reader")[0].view.data.posts.length > i)?.click(), url);
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
    check(Boolean(inside) && inside.styles[0] > 1000 && inside.font.trim() !== '"Times New Roman"' /* the browser's default when no stylesheet applies */, `${layout}: the blyg's own stylesheet is applied, inline (${inside?.styles[0]} characters; font ${inside?.font?.slice(0, 40)})`);
    check((await text(".blyg-reader-meta")).some((t) => t.startsWith("On the web:")), `${layout}: the header says the post is shown from the web`);
    const buttons = await text(".blyg-reader-actions button");
    check(["Reply in Obsidian", "Mark read", "Open in browser", "Show as text"].every((b) => buttons.includes(b)), `${layout}: the actions are there: ${buttons.join(", ")}`);
    await shot(`${layout}-2-web`);

    check(await click("Show as text"), `${layout}: "Show as text" can be tapped`);
    await wait(500);
    const body = (await text(".blyg-reader-body"))[0] ?? "";
    check(body.length > 0 && (await page.$(".blyg-reader-frame")) === null, `${layout}: the same post as text, the frame gone (${body.length} characters)`);

    check(await click("Mark read"), `${layout}: Mark read can be tapped`);
    await wait(1500);
    const status = (await text(".blyg-reader-status"))[0] ?? "";
    check(/reading:state/.test(status), `${layout}: with the plugin's scopes the refusal is explained in words: "${status.slice(0, 90)}"`);

    const before = await page.evaluate(() => window.app.vault.getMarkdownFiles().length);
    check(await click("Reply in Obsidian"), `${layout}: Reply can be tapped`);
    await wait(3000);
    const after = await page.evaluate(() => window.app.vault.getMarkdownFiles().length);
    const reply = await page.evaluate(async () => {
      const f = window.app.workspace.getActiveFile();
      return f ? { path: f.path, text: await window.app.vault.read(f) } : null;
    });
    check(after === before + 1 && !!reply, `${layout}: Reply made one new note (${before} to ${after}): ${reply?.path ?? "none"}`);
    check(/blyg_stub_of/.test(reply?.text ?? ""), `${layout}: the new note names the post it answers (blyg_stub_of)`);
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  }

  /** A page that cannot be shown: the post falls back to text, with a line that says why. And what desktop Obsidian does with a page that refuses framing. */
  async function noFrame() {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-poc"));
    await page.waitForSelector(".blyg-reader-card", { timeout: 20000 });
    const open = (url) => page.evaluate((u) => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].sourceUrl = u;
      view.shown = view.data.posts[0];
      view.shownAs = "web";
      view.page = { s: "unknown" };
      view.draw();
    }, url);
    await open("http://127.0.0.1:18999/gone");
    await wait(2500);
    const meta = (await text(".blyg-reader-meta")).join(" ");
    check((await page.$(".blyg-reader-frame")) === null && /could not be reached/.test(meta) && ((await text(".blyg-reader-body"))[0] ?? "").length > 0, `a page that does not answer falls back to text, and says why ("${meta.slice(0, 70)}")`);
    // Desktop Obsidian removes X-Frame-Options and CSP frame-ancestors from every response (its own session hook), so a refusing page is framed anyway
    // here; on mobile the header arrives and the post falls back to text (unit-tested in framePolicy, not checkable in this desktop harness).
    await open("http://127.0.0.1:18999/noframe");
    await wait(2500);
    const whole = await page.evaluate(() => document.querySelector(".blyg-reader-frame")?.getAttribute("src") ?? null);
    check(whole === "http://127.0.0.1:18999/noframe", `a page without the contract's article is shown whole; and desktop Obsidian strips X-Frame-Options, so even this refusing page is framed (documented, not the plugin's choice) (${whole})`);
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  }

  /** New posts: the reader asks the Studio to fetch the blygs it reads, so a post published a moment ago appears after Refresh, without the web app. */
  async function freshness() {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-poc"));
    await page.waitForSelector(".blyg-reader-card", { timeout: 20000 });
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
    check(await click("Refresh"), "freshness: Refresh can be tapped");
    let saw = "";
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await wait(1000);
      const st = (await text(".blyg-reader-status"))[0] ?? "";
      if (/Checking/.test(st)) saw = st;
      found = (await text(".blyg-reader-card")).some((c) => c.includes(stamp));
    }
    check(saw !== "", `freshness: the status says the Studio is checking ("${saw}")`);
    check(found, "freshness: a post published on the other blyg a moment ago appears after Refresh");
    await shot("freshness");
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  }

  /** Foreign markup through the reader's own drawing code: nothing runs, nothing is loaded from a stranger's server, and anything not understood is refused, not guessed. */
  async function hostile() {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-poc"));
    await page.waitForSelector(".blyg-reader-row", { timeout: 20000 });
    const render = (html) => page.evaluate(async (h) => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].contentHtml = h;
      view.shown = view.data.posts[0];
      view.shownAs = "text";
      view.draw();
      await new Promise((r) => setTimeout(r, 800));
      const body = document.querySelector(".blyg-reader-body");
      return { imgs: body?.querySelectorAll("img").length, frames: body?.querySelectorAll("iframe, object, embed").length, text: body?.textContent ?? "", pwned: window.__pwned ?? null, link: body?.querySelector('a[href="https://example.com/p"]') !== null };
    }, html);
    // The shape the Studio writes, with an active link next to it: the image waits behind a button, the active link is neutralised, the ordinary link stays.
    const a = await render('<p>hi</p><img src="https://tracker.example/pixel.png" alt="a door"><a href="javascript:window.__pwned=3">l</a><a href="https://example.com/p">ok</a>');
    check(a.pwned === null && a.imgs === 0, "foreign markup: a foreign image waits and the javascript: link does nothing");
    check(/Load image: a door \(tracker\.example\)/.test(a.text), "foreign markup: the button names the description and the server");
    check(a.link, "foreign markup: an ordinary link survives");
    // Anything else that could load or run is refused as a whole, never guessed at.
    for (const [name, bad] of [["an image in another form", '<p>x</p><img src="x" onerror="window.__pwned=1">'], ["a frame", '<p>x</p><iframe src="https://tracker.example/f"></iframe>'], ["a script", '<p>x</p><script>window.__pwned=2</script>'], ["svg", '<svg onload="window.__pwned=4"></svg>'], ["a hidden image form", '<IMG  SRC="https://tracker.example/p.png">']]) {
      const out = await render(bad);
      check(out.pwned === null && out.imgs === 0 && out.frames === 0 && /does not draw/.test(out.text), `foreign markup: ${name} is refused with a pointer to the web`);
    }
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  }

  /** Images, measured by a server that counts requests: none until a tap, one per tap, all with "Load images", and drawn with the post under "Always load". The images are written the way the Studio writes them. */
  async function images() {
    const post = (...names) => names.map((n) => `<img src="http://127.0.0.1:18999/${n}.png" alt="${n}">`).join("");
    const show = (html, asPost) => page.evaluate(async ([h, one]) => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].contentHtml = h;
      view.shown = one ? view.data.posts[0] : null;
      view.shownAs = "text";
      view.draw();
      await new Promise((r) => setTimeout(r, 1200));
    }, [html, asPost]);
    const count = (sel) => page.evaluate((q) => document.querySelectorAll(`.blyg-reader-body ${q}`).length, sel);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-poc"));
    await page.waitForSelector(".blyg-reader-row", { timeout: 20000 });

    hits = 0;
    await show(`<p>list</p>${post("pixel9")}`, false);
    check(hits === 0, `images: the stream list requests no image, however many posts it shows (${hits} requests)`);

    hits = 0;
    await show(`<p>pictures</p>${post("pixel1", "pixel2")}`, true);
    check(hits === 0, `images, load on click: nothing was requested while the post was drawn (${hits} requests)`);
    check((await count(".blyg-reader-image")) === 2 && (await count("img")) === 0, "images, load on click: two buttons, no image yet");
    check((await text(".blyg-reader-image"))[0]?.includes("127.0.0.1:18999") === true, "images, load on click: the button names the server it would contact");
    await shot("images-1-buttons");

    await page.evaluate(() => document.querySelector(".blyg-reader-body .blyg-reader-image")?.click());
    await wait(1200);
    check(hits === 1 && (await count("img")) === 1, `images, load on click: tapping one button requests exactly that image (${hits} request)`);
    check(await page.evaluate(() => document.querySelector(".blyg-reader-body img")?.getAttribute("referrerpolicy") === "no-referrer"), "images, load on click: a loaded image sends no referrer");

    check(await click("Load images (2)"), "images, load on click: 'Load images (n)' is offered when images wait");
    await wait(1200);
    check(hits === 2 && (await count("img")) === 2 && (await count(".blyg-reader-image")) === 0, `images, load on click: the rest load on request (${hits} requests in all)`);
    await shot("images-2-loaded");

    await page.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.images = "always"; });
    hits = 0;
    referers.length = 0;
    // Fresh addresses: the two above were loaded already, and a browser may answer those from its image cache with no request at all (seen in CI).
    await show(`<p>pictures</p>${post("pixel3", "pixel4")}`, true);
    check(hits === 2 && (await count("img")) === 2 && (await count(".blyg-reader-image")) === 0, `images, always load: both are drawn with the post (${hits} requests)`);
    check(referers.every((r) => r === null), `images, always load: no referrer is sent (${JSON.stringify(referers)})`);
    await page.evaluate(() => { window.app.plugins.plugins.blyg.settings.readerPane.images = "click"; });
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  }

  /** The bypasses found in review (2026-11-13): each fetched without a tap under the old deny-list. Now each post must be refused and nothing requested. */
  async function bypasses() {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-poc"));
    await page.waitForSelector(".blyg-reader-row", { timeout: 20000 });
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
      const out = await page.evaluate(async (h) => {
        const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
        view.data.posts[0].contentHtml = h;
        view.shown = view.data.posts[0];
      view.shownAs = "text";
        view.draw();
        await new Promise((r) => setTimeout(r, 1500));
        return /does not draw/.test(document.querySelector(".blyg-reader-body")?.textContent ?? "");
      }, html);
      check(hits === 0 && out, `bypass closed: ${name} is refused and requests nothing (${hits} requests)`);
    }
    // The own-Studio path with an apostrophe in a well-formed tag: drawn, one image, no attribute smuggled out.
    hits = 0;
    const own = await page.evaluate(async (pixel) => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].contentHtml = `<p><img src="http://localhost:8787/x&#39; style=&#39;background-image:url(${pixel})" alt="y"></p>`;
      view.shown = view.data.posts[0];
      view.shownAs = "text";
      view.draw();
      await new Promise((r) => setTimeout(r, 1500));
      const img = document.querySelector(".blyg-reader-body img");
      return { attrs: img ? img.getAttributeNames().sort() : [], styled: document.querySelector(".blyg-reader-body [style]") !== null };
    }, P("pixel-b8"));
    check(hits === 0 && !own.styled && JSON.stringify(own.attrs) === JSON.stringify(["alt", "src"]), `bypass closed: an apostrophe in an own-Studio address smuggles nothing (${hits} requests, attributes ${own.attrs.join(",")})`);
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  }

  await freshness();
  await noFrame();
  await bypasses();
  await images();
  await hostile();
  await pass("desktop");
  await s.phone();
  await pass("phone");
  imageServer.close();
});
