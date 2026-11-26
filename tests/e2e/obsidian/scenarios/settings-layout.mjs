// C: the plugin's settings pane never scrolls sideways. Opened in real Obsidian at desktop width and at phone widths 393 and 360 px with a configuration that fills the long rows
// (GitHub settings, a long Studio address): the pane's scroll width equals its client width, and no row, field or preview reaches past the pane's right edge. A failure names the widest element.
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/settings-layout.mjs
import { fixtureData, runScenario, wait } from "../lib.mjs";

const data = fixtureData();
data.github = { owner: "someone-with-a-long-name", repo: "a-site-repository-with-a-very-long-name-indeed", branch: "main", previewBranch: "preview", useBranch: "production", tokenSecretName: "settings-layout-token-with-a-long-name", watchDeploy: true };
data.blyg = { origin: "https://example.com/" + "a-long-path-segment/".repeat(6) };
data.features = { daily: true, passages: true };

await runScenario({ data }, async (s) => {
  const { check, page } = s;
  const measure = () => page.evaluate(() => {
    const doc = activeDocument;
    const pane = doc.querySelector(".blyg-settings") ?? doc.querySelector(".vertical-tab-content");
    const scroller = doc.querySelector(".modal.mod-settings .vertical-tab-content");
    if (!pane) return null;
    const edge = (scroller ?? pane).getBoundingClientRect().right;
    let widest = null;
    for (const e of pane.querySelectorAll("*")) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.right > edge + 1 && (!widest || r.right > widest.right)) widest = { right: Math.round(r.right), tag: e.tagName, cls: String(e.className).slice(0, 60), text: (e.textContent ?? "").slice(0, 50) };
    }
    return { sw: pane.scrollWidth, cw: pane.clientWidth, ssw: scroller?.scrollWidth ?? 0, scw: scroller?.clientWidth ?? 0, edge: Math.round(edge), widest };
  });
  const open = async (label) => {
    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("blyg"); });
    await page.waitForSelector(".modal.mod-settings .blyg-settings, .modal.mod-settings .setting-item", { timeout: 20000 });
    await wait(1500);
    const m = await measure();
    check(Boolean(m) && m.sw <= m.cw && m.ssw <= m.scw && !m.widest, `${label}: the settings pane does not scroll sideways (${JSON.stringify(m)})`);
    await page.evaluate(() => { window.app.setting.close(); });
    await wait(1200);
  };
  await open("desktop layout");
  await s.phone();
  for (const [w, h] of [[393, 852], [360, 780]]) {
    await s.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(1200);
    await open(`phone layout ${w} px`);
  }
});
