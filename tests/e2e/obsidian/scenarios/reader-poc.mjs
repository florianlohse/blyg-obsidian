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
  if ((req.url ?? "").startsWith("/pixel")) { hits++; referers.push(req.headers.referer ?? null); }
  res.writeHead(200, { "content-type": "image/png" });
  res.end(PNG);
});
await new Promise((resolve) => imageServer.listen(18999, "127.0.0.1", resolve));

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
    await page.waitForSelector(".blyg-reader-row", { timeout: 20000 }).catch(() => {});
    const rows = await text(".blyg-reader-row");
    check(rows.length > 0, `${layout}: the stream shows the post the Studio holds (${rows.length} row)`);
    check(!(await text(".blyg-reader-row.is-unread")).every((t) => t === ""), `${layout}: an unread post is marked as unread`);
    await shot(`${layout}-1-stream`);

    await page.evaluate(() => document.querySelector(".blyg-reader-row")?.click());
    await wait(500);
    const body = (await text(".blyg-reader-body"))[0] ?? "";
    check(body.length > 0 && !/does not draw/.test(body), `${layout}: tapping a post opens its text, drawn, not refused (${body.length} characters)`);
    const buttons = await text(".blyg-reader-actions button");
    check(["Reply in Obsidian", "Open on the web", "Mark read"].every((b) => buttons.includes(b)), `${layout}: the three hand-offs are there: ${buttons.join(", ")}`);
    await shot(`${layout}-2-post`);

    check(await click("Mark read"), `${layout}: Mark read can be tapped`);
    await wait(1500);
    const status = (await text(".blyg-reader-status"))[0] ?? "";
    check(/reading:state/.test(status), `${layout}: with the plugin's scopes the refusal is explained in words: "${status.slice(0, 90)}"`);
    await shot(`${layout}-3-markread`);

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
    await shot(`${layout}-4-reply`);
  }

  /** Foreign markup through the reader's own drawing code: nothing runs, nothing is loaded from a stranger's server, and anything not understood is refused, not guessed. */
  async function hostile() {
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-reader-poc"));
    await page.waitForSelector(".blyg-reader-row", { timeout: 20000 });
    const render = (html) => page.evaluate(async (h) => {
      const view = window.app.workspace.getLeavesOfType("blyg-reader")[0].view;
      view.data.posts[0].contentHtml = h;
      view.shown = view.data.posts[0];
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
    await show(`<p>pictures</p>${post("pixel1", "pixel2")}`, true);
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
      view.draw();
      await new Promise((r) => setTimeout(r, 1500));
      const img = document.querySelector(".blyg-reader-body img");
      return { attrs: img ? img.getAttributeNames().sort() : [], styled: document.querySelector(".blyg-reader-body [style]") !== null };
    }, P("pixel-b8"));
    check(hits === 0 && !own.styled && JSON.stringify(own.attrs) === JSON.stringify(["alt", "src"]), `bypass closed: an apostrophe in an own-Studio address smuggles nothing (${hits} requests, attributes ${own.attrs.join(",")})`);
    await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-reader").forEach((l) => l.detach()));
  }

  await bypasses();
  await images();
  await hostile();
  await pass("desktop");
  await s.phone();
  await pass("phone");
  imageServer.close();
});
