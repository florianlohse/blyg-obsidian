// Smoke test in REAL Obsidian (M1 A1.4, plan §5 layer 4; shared plumbing in lib.mjs since M2 P6). Run by `npm run test:obsidian` and by the
// `obsidian-smoke` job of ci.yml. The scenarios of docs/plans/P6-ui-regression.md are in scenarios/*.mjs (`npm run test:obsidian:ui`).
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/smoke.mjs        (after `npm run build`; `scripts/local-studio.sh start` prints both)
//
// What it proves, in desktop layout and then in Obsidian's phone layout (Chromium emulation, NOT iOS; the iPad is Florian's):
//   1. the built main.js loads: the plugin is enabled, no uncaught page error, no console error that names the plugin;
//   2. the panel opens on a note in `Blyg/` and shows the plugin's version;
//   3. a draft goes to a local Studio and comes back stamped: the note gets `blyg_id` and the Studio has the item;
//   4. Obsidian's Settings window opens and the plugin's tab draws, with a Studio-only, a Studio and a GitHub-setup configuration: the Advanced
//      switch is there (off for Studio-only, on with a GitHub setup) and expands and collapses the GitHub settings in the same box;
//   5. the development build, enabled beside the real plugin, stays idle.
import { DEV, DEV_BUILD, STUDIO, TOKEN, launch, requireEnvironment, wait } from "./lib.mjs";

requireEnvironment();
const NOTE = "Blyg/A pot that would not boil.md";
let s;
try {
  s = await launch({ withDev: true });
  const { page, check, until } = s;
  check(Boolean(s.loaded), "the built main.js loads and the plugin `blyg` is enabled");
  if (!s.loaded) throw new Error("plugin did not load");

  async function round(layout) {
    await page.evaluate(async (p) => { await window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(p)); }, NOTE);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-panel"));
    const pane = await until(() => page.evaluate(() => document.querySelector(".blyg-pane .blyg-pane-version")?.textContent ?? ""), 30000, `the panel (${layout})`).catch(() => "");
    check(/^Blyg \d+\.\d+\.\d+/.test(pane), `${layout}: the panel opens on a note in Blyg/ and shows its version (${pane || "nothing"})`);
  }

  await round("desktop");

  // 4. the Settings window and the plugin's tab, with three configurations (the plugin is reloaded with each; the original data is put back at the end)
  async function settingsRound(layout, label, wantOn) {
    const inDom = (sel) => page.evaluate((q) => Boolean(activeDocument.querySelector(q)), sel);
    const text = () => page.evaluate(() => activeDocument.querySelector(".modal.mod-settings")?.textContent ?? "");
    await page.evaluate(() => { window.app.setting.open(); });
    const open = await until(() => inDom(".modal.mod-settings"), 15000, "the Settings window").catch(() => false);
    check(open, `${layout}, ${label}: the Settings window opens`);
    if (!open) return;
    await page.evaluate(() => { window.app.setting.openTabById("blyg"); });
    const drawn = await until(async () => /Also publish to a GitHub-hosted site/.test(await text()), 15000, "the plugin's settings tab").catch(() => false);
    check(drawn, `${layout}, ${label}: the plugin's tab shows the Advanced switch`);
    if (drawn) {
      const githubShown = async () => /GitHub owner/.test(await text());
      const toggle = () => page.evaluate(() => {
        const row = [...activeDocument.querySelectorAll(".modal.mod-settings .setting-item")].find((r) => /Also publish to a GitHub-hosted site/.test(r.textContent ?? ""));
        row?.querySelector(".checkbox-container")?.click();
      });
      check((await githubShown()) === wantOn, `${layout}, ${label}: the switch starts ${wantOn ? "on, with the GitHub settings under it" : "off, with no GitHub settings"}`);
      await toggle();
      await until(async () => (await githubShown()) === !wantOn, 10000, "the switch to flip").catch(() => {});
      check((await githubShown()) === !wantOn, `${layout}, ${label}: toggling ${wantOn ? "collapses" : "expands"} the GitHub settings`);
      await toggle();
      await until(async () => (await githubShown()) === wantOn, 10000, "the switch to flip back").catch(() => {});
      check((await githubShown()) === wantOn, `${layout}, ${label}: toggling again restores them`);
    }
    await page.evaluate(() => { window.app.setting.close(); });
    await until(async () => !(await inDom(".modal.mod-settings")), 10000, "the Settings window to close").catch(() => {});
    await wait(1500);
  }
  async function settingsRounds(layout) {
    const originalData = await page.evaluate(() => window.app.vault.adapter.read(".obsidian/plugins/blyg/data.json"));
    const base = JSON.parse(originalData);
    await settingsRound(layout, "Studio configured, no GitHub", false);
    await s.withData({ ...base, github: { owner: "someone", repo: "site", branch: "main", previewBranch: "preview", useBranch: "production", tokenSecretName: "smoke-github", watchDeploy: true }, blyg: { origin: "https://example.com/blyg/" }, routes: [...base.routes, { vaultPrefix: "Old/", mode: "blyg", label: "Blyg item" }] });
    await settingsRound(layout, "with a GitHub setup", true);
    await s.withData(originalData);
  }

  // 3. a draft goes to the local Studio and comes back stamped
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:publish-active-note"));
  // Obsidian puts windows and notices into `activeDocument`, which is not `window.document` in the driven page: look there.
  const offered = await until(
    () => page.evaluate(() => activeDocument.querySelector(".blyg-footer button.mod-cta")?.textContent?.trim() ?? ""),
    40000, "the publish window",
  ).catch(async () => {
    await s.dumpSeen("no publish window");
    return "";
  });
  check(offered === "Send draft", `the window offers “Send draft” (the route is drafts-only): ${offered || "no window"}`);
  if (offered) await page.evaluate(() => activeDocument.querySelector(".blyg-footer button.mod-cta").click());
  const id = await s.stamped(NOTE, "blyg_id", 60000);
  check(Boolean(id), `the note is stamped with blyg_id after the draft was sent (${id || "none"})`);
  if (id) {
    const res = await fetch(`${STUDIO}/api/items/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    check(res.ok, `the local Studio has the item (HTTP ${res.status})`);
  }

  await settingsRounds("desktop");

  // 5. the development build enabled beside the real plugin stays idle: it registers nothing, and the real plugin is not disturbed
  if (!DEV) console.log("skip the idle-development-build check: no build at " + DEV_BUILD + " (run `node scripts/flavour.mjs blyg-dev dist/blyg-dev`)");
  if (DEV) {
    const devCommands = await page.evaluate(() => Object.keys(window.app.commands.commands).filter((id) => id.startsWith("blyg-dev:")));
    check(devCommands.length === 0, `the development build is enabled beside the real plugin and registers no command (${devCommands.length})`);
    const devPanel = await page.evaluate(() => window.app.workspace.getLeavesOfType("blyg-dev-panel").length + document.querySelectorAll(".blyg-pane-dev").length);
    check(devPanel === 0, "the development build opens no panel");
    const realCommands = await page.evaluate(() => Object.keys(window.app.commands.commands).filter((id) => id.startsWith("blyg:")).length);
    check(realCommands > 5, `the real plugin's commands are all there (${realCommands})`);
  }

  // phone layout
  await s.phone();
  await round("phone layout");
  await settingsRounds("phone layout");

  s.checkQuiet();
} catch (e) {
  if (s) { s.crash(e); await s.dumpSeen("crash").catch(() => {}); } else { console.error(e); process.exit(1); }
}
await s.finish();
