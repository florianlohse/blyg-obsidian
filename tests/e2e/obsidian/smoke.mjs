// Smoke test in REAL Obsidian (M1 A1.4, plan §5 layer 4). Not a unit test: run by `npm run test:obsidian` and by the `obsidian-smoke` job of ci.yml.
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/smoke.mjs        (after `npm run build`; `scripts/local-studio.sh start` prints both)
//
// What it proves, in desktop layout and then in Obsidian's phone layout (Chromium emulation, NOT iOS; the iPad is Florian's):
//   1. the built main.js loads: the plugin is enabled, no uncaught page error, no console error that names the plugin;
//   2. the panel opens on a note in `Blyg/` and shows the plugin's version;
//   3. a draft goes to a local Studio and comes back stamped: the note gets `blyg_id` and the Studio has the item;
//   4. Obsidian's Settings window opens and the plugin's tab draws, with a Studio-only, a Studio and a GitHub-setup configuration: the Advanced
//      switch is there (off for Studio-only, on with a GitHub setup) and expands and collapses the GitHub settings in the same box.
//      NOTE for anyone driving Obsidian over CDP: windows and modals live in `activeDocument`, which is NOT `window.document` in the driven page.
//      `document.querySelector(".modal")` finds nothing even while the Settings window is open.
// The harness is adapted from the demo vault's `.demo/test/obsidian.mjs` (CC0): a copy of the vault in a temp dir, real Obsidian from an AppImage
// under xvfb, driven over the debugging port by playwright-core. Linux only. The Obsidian download is cached in ~/.cache/obsidian-e2e, never in the repo.
// playwright-core is NOT a dependency of this repo: set PLAYWRIGHT_CORE to its folder, or have `playwright-core` / `playwright` resolvable.
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VERSION = process.env.OBSIDIAN_E2E_VERSION ?? "1.14.5";
const CACHE = process.env.OBSIDIAN_E2E_DIR ?? join(homedir(), ".cache", "obsidian-e2e");
const STUDIO = process.env.STUDIO_E2E_URL;
const TOKEN = process.env.STUDIO_E2E_TOKEN;
const BUILD = resolve(process.env.OBSIDIAN_SMOKE_BUILD ?? join(ROOT, "dist", "blyg"));
const NOTE = "Blyg/A pot that would not boil.md";
// The development flavour, enabled beside the real plugin: it must stay idle (one plugin at a time). Without its build the check is skipped.
const DEV_BUILD = resolve(process.env.OBSIDIAN_SMOKE_DEV_BUILD ?? join(ROOT, "dist", "blyg-dev"));
const DEV = ["main.js", "manifest.json", "styles.css"].every((f) => existsSync(join(DEV_BUILD, f)));

if (!STUDIO || !TOKEN) {
  console.error("Set STUDIO_E2E_URL and STUDIO_E2E_TOKEN (scripts/local-studio.sh start prints both).");
  process.exit(2);
}
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  if (!existsSync(join(BUILD, f))) { console.error(`${join(BUILD, f)} is missing: run \`npm run build\` and \`node scripts/flavour.mjs blyg\` first.`); process.exit(2); }
}
process.env.NO_PROXY = "localhost,127.0.0.1";
process.env.no_proxy = "localhost,127.0.0.1";

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, "playwright-core", "playwright", "/opt/node-tools/node_modules/playwright"].filter(Boolean);
  for (const t of tries) { try { return createRequire(import.meta.url)(t); } catch { /* next */ } }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE to its folder");
}

function ensureObsidian() {
  const bin = join(CACHE, VERSION, "squashfs-root", "obsidian");
  if (existsSync(bin)) return bin;
  const dir = join(CACHE, VERSION);
  mkdirSync(dir, { recursive: true });
  const image = join(dir, "Obsidian.AppImage");
  execFileSync("curl", ["-fsSL", "-o", image, `https://github.com/obsidianmd/obsidian-releases/releases/download/v${VERSION}/Obsidian-${VERSION}.AppImage`], { stdio: "inherit" });
  chmodSync(image, 0o755);
  execFileSync(image, ["--appimage-extract"], { cwd: dir, stdio: "ignore" });
  rmSync(image);
  return bin;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(500);
  }
}

// ---- set up a copy of the fixture vault with the built plugin and its settings
const root = mkdtempSync(join(tmpdir(), "blyg-smoke-"));
const vault = join(root, "vault");
cpSync(join(ROOT, "tests", "fixtures", "vault"), vault, { recursive: true });
const pluginDir = join(vault, ".obsidian", "plugins", "blyg");
mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(BUILD, f), join(pluginDir, f));
// A Studio-only configuration, as a stranger has it: no GitHub settings, no GitHub token (A2.4 made that possible).
const data = JSON.parse(readFileSync(join(vault, "plugin-data.template.json"), "utf8").replace("__STUDIO_URL__", STUDIO.replace(/\/$/, "")));
writeFileSync(join(pluginDir, "data.json"), JSON.stringify(data, null, 2));
if (DEV) {
  const devDir = join(vault, ".obsidian", "plugins", "blyg-dev");
  mkdirSync(devDir, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(DEV_BUILD, f), join(devDir, f));
  writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["blyg", "blyg-dev"]));
}
const cfg = join(root, "cfg");
mkdirSync(join(cfg, "obsidian"), { recursive: true });
writeFileSync(join(cfg, "obsidian", "obsidian.json"), JSON.stringify({ vaults: { smoke: { path: vault, ts: Date.now(), open: true } } }));

const { chromium } = loadPlaywright();
const bin = ensureObsidian();
const port = 9300 + Math.floor(Math.random() * 600);
const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1440x900x24", bin, "--no-sandbox", `--remote-debugging-port=${port}`], {
  env: { ...process.env, XDG_CONFIG_HOME: cfg }, stdio: "ignore", detached: true,
});
let browser;
const close = async () => { await browser?.close().catch(() => {}); try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); };

try {
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await wait(500);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); page = browser.contexts()[0]?.pages().find((p) => p.url().startsWith("app://")); } catch { /* not yet */ }
  }
  if (!page) throw new Error("Obsidian did not start");
  const pageErrors = [];
  const consoleErrors = [];
  const pluginLog = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
    if (/blyg/i.test(m.text())) pluginLog.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });

  await page.waitForFunction(() => Boolean(window.app?.plugins), undefined, { timeout: 60000 });
  try { await page.getByText("Trust author and enable plugins").click({ timeout: 15000 }); } catch { /* already trusted */ }
  await page.evaluate(async () => { await new Promise((d) => window.app.workspace.onLayoutReady(d)); });

  // 1. the plugin loaded
  const loaded = await until(() => page.evaluate(() => Boolean(window.app.plugins.plugins["blyg"])), 45000, "the plugin to load").catch(() => false);
  check(loaded, "the built main.js loads and the plugin `blyg` is enabled");
  if (!loaded) throw new Error("plugin did not load");
  await page.evaluate((t) => window.app.secretStorage.setSecret("smoke-studio", t), TOKEN);
  async function round(layout) {
    await page.evaluate(async (p) => { await window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(p)); }, NOTE);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-panel"));
    const pane = await until(() => page.evaluate(() => document.querySelector(".blyg-pane .blyg-pane-version")?.textContent ?? ""), 30000, `the panel (${layout})`).catch(() => "");
    check(/^Blyg \d+\.\d+\.\d+/.test(pane), `${layout}: the panel opens on a note in Blyg/ and shows its version (${pane || "nothing"})`);
  }

  await round("desktop");

  // 4. the Settings window and the plugin's tab, with three configurations (the plugin is reloaded with each; the original data is put back at the end)
  async function withData(obj) {
    await page.evaluate(async (json) => {
      await window.app.plugins.disablePlugin("blyg");
      await window.app.vault.adapter.write(".obsidian/plugins/blyg/data.json", json);
      await window.app.plugins.enablePlugin("blyg");
    }, typeof obj === "string" ? obj : JSON.stringify(obj));
    await until(() => page.evaluate(() => Boolean(window.app.plugins.plugins["blyg"])), 30000, "the plugin to reload");
    // closing the Settings window saves the settings (a moment later): let that land before the next file is written, or it would overwrite it
    await wait(1500);
  }
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
    await withData({ ...base, github: { owner: "someone", repo: "site", branch: "main", previewBranch: "preview", useBranch: "production", tokenSecretName: "smoke-github", watchDeploy: true }, blyg: { origin: "https://example.com/blyg/" }, routes: [...base.routes, { vaultPrefix: "Old/", mode: "blyg", label: "Blyg item" }] });
    await settingsRound(layout, "with a GitHub setup", true);
    await withData(originalData);
  }

  // 3. a draft goes to the local Studio and comes back stamped
  await page.evaluate(() => window.app.commands.executeCommandById("blyg:publish-active-note"));
  // Obsidian puts windows and notices into `activeDocument`, which is not `window.document` in the driven page: look there.
  const offered = await until(
    () => page.evaluate(() => activeDocument.querySelector(".blyg-footer button.mod-cta")?.textContent?.trim() ?? ""),
    40000, "the publish window",
  ).catch(async () => {
    // what a person would have seen instead (text only; the token is never part of any of it)
    const seen = await page.evaluate(() => ({
      notices: [...activeDocument.querySelectorAll(".notice")].map((n) => n.textContent),
      modal: activeDocument.querySelector(".modal-container")?.textContent?.slice(0, 400) ?? null,
      writing: window.app.plugins.plugins["blyg"]?.writing,
    }));
    if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT });
    console.error("no publish window; seen:", JSON.stringify(seen), "\nplugin log:\n" + pluginLog.slice(-15).join("\n"), "\npage errors:", pageErrors.slice(0, 3), "\nconsole errors:", consoleErrors.slice(0, 3));
    return "";
  });
  check(offered === "Send draft", `the window offers “Send draft” (the route is drafts-only): ${offered || "no window"}`);
  if (offered) await page.evaluate(() => activeDocument.querySelector(".blyg-footer button.mod-cta").click());
  const id = await until(
    () => page.evaluate((p) => window.app.metadataCache.getFileCache(window.app.vault.getAbstractFileByPath(p))?.frontmatter?.blyg_id ?? null, NOTE),
    60000, "the note to be stamped",
  ).catch(() => null);
  check(Boolean(id), `the note is stamped with blyg_id after the draft was sent (${id ?? "none"})`);
  if (id) {
    const res = await fetch(`${STUDIO.replace(/\/$/, "")}/api/items/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
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

  // phone layout (Chromium emulation of Obsidian's mobile UI)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
  await page.evaluate(() => window.app.emulateMobile(true));
  await wait(3000);
  try { await page.getByText("Trust author and enable plugins").click({ timeout: 3000 }); } catch { /* none */ }
  await page.waitForFunction(() => window.app.plugins.plugins["blyg"], undefined, { timeout: 30000 });
  await round("phone layout");
  await settingsRounds("phone layout");

  // 1b. nothing broke while all that happened
  check(pageErrors.length === 0, `no uncaught page error${pageErrors.length ? `: ${pageErrors[0]}` : ""}`);
  const ours = consoleErrors.filter((t) => /blyg/i.test(t));
  check(ours.length === 0, `no console error that names the plugin${ours.length ? `: ${ours[0]}` : ""}`);
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  await close();
}
console.log(failures.length ? `${failures.length} failure(s)` : "all checks passed");
process.exit(failures.length ? 1 : 0);
