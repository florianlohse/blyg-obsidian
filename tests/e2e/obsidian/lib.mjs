// Shared plumbing for the real-Obsidian checks (M2 P6, docs/plans/P6-ui-regression.md). Not a test by itself: `smoke.mjs` and `scenarios/*.mjs` use it.
//
// What it does: a copy of the fixture vault in a temp dir, the built plugin and its settings in it, real Obsidian from an AppImage under xvfb, driven over
// the debugging port by playwright-core (adapted from the demo vault's `.demo/test/obsidian.mjs`, CC0). Linux only. The Obsidian download is cached in
// ~/.cache/obsidian-e2e, never in the repo. playwright-core is NOT a dependency of this repo: set PLAYWRIGHT_CORE to its folder, or have
// `playwright-core` / `playwright` resolvable.
//
// Drive like a person, assert like the Studio: open windows with commands or by clicking the panel's buttons, never by calling plugin methods;
// assert on what windows and notices say and on what the local Studio holds (read through its REST API).
//
// Traps for anyone driving Obsidian over CDP:
//   - in the driven page `document !== activeDocument`: modals and notices live in `activeDocument`, the panel in `document`;
//   - closing the Settings window saves the settings a moment later (wait 1.5 s before writing data.json);
//   - a Notice is gone after its timeout (4 to 14 s): the page keeps a log of every notice it has seen (`notices()` reads it).
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VERSION = process.env.OBSIDIAN_E2E_VERSION ?? "1.14.5";
const CACHE = process.env.OBSIDIAN_E2E_DIR ?? join(homedir(), ".cache", "obsidian-e2e");
export const STUDIO = (process.env.STUDIO_E2E_URL ?? "").replace(/\/$/, "");
export const TOKEN = process.env.STUDIO_E2E_TOKEN;
export const BUILD = resolve(process.env.OBSIDIAN_SMOKE_BUILD ?? join(ROOT, "dist", "blyg"));
export const DEV_BUILD = resolve(process.env.OBSIDIAN_SMOKE_DEV_BUILD ?? join(ROOT, "dist", "blyg-dev"));
const FILES = ["main.js", "manifest.json", "styles.css"];
export const DEV = FILES.every((f) => existsSync(join(DEV_BUILD, f)));

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exit with code 2 (not a failure of the plugin) when the environment for a real-Obsidian run is not there. */
export function requireEnvironment() {
  if (!STUDIO || !TOKEN) {
    console.error("Set STUDIO_E2E_URL and STUDIO_E2E_TOKEN (scripts/local-studio.sh start prints both).");
    process.exit(2);
  }
  for (const f of FILES) {
    if (!existsSync(join(BUILD, f))) { console.error(`${join(BUILD, f)} is missing: run \`npm run build\` and \`node scripts/flavour.mjs blyg dist/blyg\` first.`); process.exit(2); }
  }
  process.env.NO_PROXY = "localhost,127.0.0.1";
  process.env.no_proxy = "localhost,127.0.0.1";
}

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

/** The fixture's settings with the local Studio's address filled in. `patch` is merged over them (shallow). */
export function fixtureData(patch = {}) {
  const template = readFileSync(join(ROOT, "tests", "fixtures", "vault", "plugin-data.template.json"), "utf8");
  return { ...JSON.parse(template.replace("__STUDIO_URL__", STUDIO)), ...patch };
}

/**
 * Start Obsidian on a copy of the fixture vault.
 *   data      the plugin's data.json (default: the fixture's Studio-only settings)
 *   withDev   also install the development build beside the real plugin (it must stay idle)
 * Returns a session; call `session.finish()` last (it prints the verdict and exits).
 */
export async function launch({ data = fixtureData(), withDev = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blyg-e2e-"));
  const vault = join(root, "vault");
  cpSync(join(ROOT, "tests", "fixtures", "vault"), vault, { recursive: true });
  const pluginDir = join(vault, ".obsidian", "plugins", "blyg");
  mkdirSync(pluginDir, { recursive: true });
  for (const f of FILES) copyFileSync(join(BUILD, f), join(pluginDir, f));
  writeFileSync(join(pluginDir, "data.json"), JSON.stringify(data, null, 2));
  if (withDev && DEV) {
    const devDir = join(vault, ".obsidian", "plugins", "blyg-dev");
    mkdirSync(devDir, { recursive: true });
    for (const f of FILES) copyFileSync(join(DEV_BUILD, f), join(devDir, f));
    writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["blyg", "blyg-dev"]));
  }
  const cfg = join(root, "cfg");
  mkdirSync(join(cfg, "obsidian"), { recursive: true });
  writeFileSync(join(cfg, "obsidian", "obsidian.json"), JSON.stringify({ vaults: { e2e: { path: vault, ts: Date.now(), open: true } } }));

  const { chromium } = loadPlaywright();
  const bin = ensureObsidian();
  const port = 9300 + Math.floor(Math.random() * 600);
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1440x900x24", bin, "--no-sandbox", `--remote-debugging-port=${port}`], {
    env: { ...process.env, XDG_CONFIG_HOME: cfg }, stdio: "ignore", detached: true,
  });
  let browser;
  const failures = [];
  const s = { failures, vault, pageErrors: [], consoleErrors: [], pluginLog: [], layout: "desktop" };

  // E2E_TIMING=1 puts the seconds since the start and since the previous check in front of every line (to find what a scenario spends its time on)
  const started = Date.now();
  let last = started;
  s.check = (ok, what) => {
    const now = Date.now();
    const timing = process.env.E2E_TIMING ? `[${((now - started) / 1000).toFixed(1).padStart(5)}s +${((now - last) / 1000).toFixed(1).padStart(4)}] ` : "";
    last = now;
    console.log(`${ok ? "ok  " : "FAIL"} ${timing}${what}`);
    if (!ok) failures.push(what);
    return ok;
  };
  s.until = async (fn, ms, what) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await wait(250);
    }
  };
  /** Like `until`, but a timeout is a result (false), not an exception. */
  s.becomes = (fn, ms, what) => s.until(fn, ms, what).catch(() => false);

  s.close = async () => { await browser?.close().catch(() => {}); try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); };
  s.finish = async () => {
    await s.close();
    console.log(failures.length ? `${failures.length} failure(s)` : "all checks passed");
    process.exit(failures.length ? 1 : 0);
  };
  s.crash = (e) => { failures.push(String(e)); console.error(e); };

  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await wait(500);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); page = browser.contexts()[0]?.pages().find((p) => p.url().startsWith("app://")); } catch { /* not yet */ }
  }
  if (!page) { await s.close(); throw new Error("Obsidian did not start"); }
  s.page = page;
  page.on("pageerror", (e) => s.pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") s.consoleErrors.push(m.text());
    if (/blyg/i.test(m.text())) s.pluginLog.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  await page.waitForFunction(() => Boolean(window.app?.plugins), undefined, { timeout: 60000 });
  try { await page.getByText("Trust author and enable plugins").click({ timeout: 15000 }); } catch { /* already trusted */ }
  await page.evaluate(async () => { await new Promise((d) => window.app.workspace.onLayoutReady(d)); });
  s.loaded = await s.becomes(() => page.evaluate(() => Boolean(window.app.plugins.plugins["blyg"])), 45000, "the plugin to load");
  if (s.loaded) await page.evaluate((t) => window.app.secretStorage.setSecret("smoke-studio", t), TOKEN);
  // The page keeps a log of every notice it has seen (a Notice disappears after a few seconds). Switching to the phone layout reloads the page: install it again then.
  s.logNotices = () => page.evaluate(() => {
    if (window.__noticeTimer) return;
    window.__notices = [];
    window.__noticeTimer = window.setInterval(() => {
      for (const n of activeDocument.querySelectorAll(".notice")) {
        if (n.dataset.e2eOld) continue; // on screen when the log was cleared: not new
        const t = n.textContent ?? "";
        if (t && !window.__notices.includes(t)) window.__notices.push(t);
      }
    }, 100);
  });
  await s.logNotices();

  // ---- the Obsidian side
  s.evaluate = (fn, arg) => page.evaluate(fn, arg);
  /** Replace the plugin's data.json and reload the plugin. Closing the Settings window saves a moment later: let that land first. */
  s.withData = async (obj) => {
    await page.evaluate(async (json) => {
      await window.app.plugins.disablePlugin("blyg");
      await window.app.vault.adapter.write(".obsidian/plugins/blyg/data.json", json);
      await window.app.plugins.enablePlugin("blyg");
    }, typeof obj === "string" ? obj : JSON.stringify(obj));
    await s.until(() => page.evaluate(() => Boolean(window.app.plugins.plugins["blyg"])), 30000, "the plugin to reload");
    await wait(1500);
  };
  s.createNote = (path, text) => page.evaluate(async ([p, t]) => {
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (dir && !window.app.vault.getAbstractFileByPath(dir)) await window.app.vault.createFolder(dir);
    await window.app.vault.create(p, t);
  }, [path, text]);
  /**
   * Write the note and start a command in the SAME tick, before Obsidian's metadata cache has seen the change: "right after typing" at its tightest
   * (the 0.6.0 hopper bug: the plugin read a property from the cache, which lags behind the file). The note must be the open one.
   */
  s.writeThenCommand = (path, text, commandId) => page.evaluate(async ([p, t, id]) => {
    await window.app.vault.modify(window.app.vault.getAbstractFileByPath(p), t);
    window.app.commands.executeCommandById(id);
  }, [path, text, commandId]);
  /**
   * SIMULATED cache lag: Obsidian's metadata cache keeps answering with the note's properties as they are NOW, whatever the file says, until `freshCache()`.
   * Real typing leaves the cache behind the file for a moment; this makes that moment as long as a scenario needs (and the same on every run).
   */
  s.staleCache = (path) => page.evaluate((p) => {
    const cache = window.app.metadataCache;
    if (window.__realGetFileCache) return;
    window.__realGetFileCache = cache.getFileCache.bind(cache);
    const frozen = window.__realGetFileCache(window.app.vault.getAbstractFileByPath(p));
    cache.getFileCache = (f) => (f?.path === p ? frozen : window.__realGetFileCache(f));
  }, path);
  s.freshCache = () => page.evaluate(() => {
    if (!window.__realGetFileCache) return;
    window.app.metadataCache.getFileCache = window.__realGetFileCache;
    window.__realGetFileCache = undefined;
  });
  s.readNote = (path) => page.evaluate((p) => window.app.vault.adapter.read(p), path);
  s.writeNote = (path, text) => page.evaluate(async ([p, t]) => { await window.app.vault.adapter.write(p, t); }, [path, text]);
  s.activePath = () => page.evaluate(() => window.app.workspace.getLastOpenFiles?.()?.[0] ? (window.app.workspace.getActiveFile()?.path ?? null) : (window.app.workspace.getActiveFile()?.path ?? null));
  s.frontmatter = (path) => page.evaluate((p) => window.app.metadataCache.getFileCache(window.app.vault.getAbstractFileByPath(p))?.frontmatter ?? null, path);
  /** Wait for the metadata cache to hold a value (the cache lags a moment behind the file). */
  /**
   * The value of a property once the cache holds it, or null on timeout. A value that is falsy but present (`blyg_version: 0`, `false`, "") counts:
   * the first version of this helper waited 30 s for a 0 and answered `false`, which a `!== null` check then took for success.
   */
  s.stamped = async (path, key = "blyg_id", ms = 30000) => {
    const got = await s.becomes(async () => { const v = (await s.frontmatter(path))?.[key]; return v === undefined || v === null ? false : { v }; }, ms, `${key} on ${path}`);
    return got ? got.v : null;
  };
  s.command = (id) => page.evaluate((i) => window.app.commands.executeCommandById(i), id);
  s.commandIds = (prefix) => page.evaluate((p) => window.app.commands.listCommands().map((c) => c.id).filter((i) => i.startsWith(p)), prefix);

  s.openNote = async (path) => {
    await page.evaluate(async (p) => { await window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(p)); }, path);
    await page.evaluate(() => window.app.commands.executeCommandById("blyg:open-panel"));
    const name = path.slice(path.lastIndexOf("/") + 1);
    // the panel follows the active note and redraws a moment later
    return s.becomes(async () => (await s.panelFacts()).Note === name, 20000, `the panel on ${name}`);
  };

  /**
   * Make the panel ask the Studio again. The panel caches what the Studio says for 30 s (asked again every 15 s); coming back to the app forgets
   * the cache at once (`visibilitychange` on `document`, src/main.ts): that is what a person does, and what this does.
   */
  s.refreshPanel = async (path) => {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await wait(800);
    return s.openNote(path);
  };

  // ---- the panel (in `document`)
  /** The facts list of the panel as { label: value } (Note, Route, Id, Version, Stub, Hoppers …). */
  s.panelFacts = () => page.evaluate(() => {
    const out = {};
    const dl = document.querySelector(".blyg-pane .blyg-pane-facts");
    if (!dl) return out;
    let key = null;
    for (const el of dl.children) {
      if (el.tagName === "DT") key = el.textContent ?? "";
      else if (el.tagName === "DD" && key !== null) out[key] = el.textContent ?? "";
    }
    return out;
  });
  s.panelHeadline = () => page.evaluate(() => document.querySelector(".blyg-pane .blyg-pane-headline")?.textContent?.trim() ?? "");
  s.panelText = () => page.evaluate(() => document.querySelector(".blyg-pane")?.textContent ?? "");
  s.panelButtons = () => page.evaluate(() => [...document.querySelectorAll(".blyg-pane button")].map((b) => ({ text: b.textContent?.trim() ?? "", disabled: b.disabled })));
  /** Click a panel button by its text, once it exists and is enabled. */
  s.clickPanel = async (text, ms = 12000) => {
    const ok = await s.becomes(() => page.evaluate((t) => {
      const b = [...document.querySelectorAll(".blyg-pane button")].find((x) => x.textContent?.trim() === t);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }, text), ms, `the panel button “${text}”`);
    if (!ok) console.error(`  (no enabled panel button “${text}”; the panel has: ${JSON.stringify(await s.panelButtons())}; headline: ${JSON.stringify(await s.panelHeadline())}; notices: ${JSON.stringify((await s.notices()).slice(-2).map((t) => t.slice(0, 200)))})`);
    return Boolean(ok);
  };

  // ---- windows (in `activeDocument`)
  // A window that was just closed stays in the DOM for a moment (it fades out, longer on a slow runner or in the phone layout): every helper below looks at
  // the LAST window only, the one a person sees on top. (A click on the first match once hit the closing window's button and did nothing.)
  s.modalText = () => page.evaluate(() => [...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.textContent ?? "");
  s.modalTitle = () => page.evaluate(() => [...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelector(".modal-title")?.textContent?.trim() ?? "");
  s.modalOpen = () => page.evaluate(() => Boolean(activeDocument.querySelector(".modal-container .modal")));
  /** Wait for a window whose title is `title` (a string: exactly; a RegExp: matches). */
  s.waitModal = async (title, ms = 15000, quiet = false) => {
    const ok = await s.becomes(async () => {
      const t = await s.modalTitle();
      return typeof title === "string" ? t === title : title.test(t);
    }, ms, `the window “${title}”`);
    if (!ok && !quiet) console.error(`  (no window ${title}; the open window is titled ${JSON.stringify(await s.modalTitle())}: ${JSON.stringify((await s.modalText()).slice(0, 200))})`);
    return Boolean(ok);
  };
  s.clickModal = async (text, ms = 10000) => {
    const ok = await s.becomes(() => page.evaluate((t) => {
      const b = [...([...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelectorAll("button") ?? [])].find((x) => x.textContent?.trim() === t);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }, text), ms, `the window button “${text}”`);
    return Boolean(ok);
  };
  /** Flip the switch of the row named `name` in the open window; returns whether the row was found. */
  s.toggleInModal = (name) => page.evaluate((n) => {
    const row = [...([...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelectorAll(".setting-item") ?? [])].find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() === n);
    const box = row?.querySelector(".checkbox-container");
    if (!box) return false;
    box.click();
    return true;
  }, name);
  /** Whether the switch of the row named `name` is on (null: no such row). */
  s.switchIsOn = (name) => page.evaluate((n) => {
    const row = [...([...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelectorAll(".setting-item") ?? [])].find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() === n);
    const box = row?.querySelector(".checkbox-container");
    return box ? box.classList.contains("is-enabled") : null;
  }, name);
  /** The rows of the import checklist as { title, on }. */
  s.importRows = () => page.evaluate(() => [...([...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelectorAll(".blyg-import-list .setting-item") ?? [])].map((r) => ({
    title: r.querySelector(".setting-item-name")?.textContent?.trim() ?? "",
    meta: r.querySelector(".setting-item-description")?.textContent?.trim() ?? "",
    on: r.querySelector(".checkbox-container")?.classList.contains("is-enabled") ?? false,
  })));
  /** Tick exactly the rows whose title contains one of `titles`, untick every other row. */
  s.tickOnly = (titles) => page.evaluate((wanted) => {
    for (const r of ([...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelectorAll(".blyg-import-list .setting-item") ?? [])) {
      const title = r.querySelector(".setting-item-name")?.textContent?.trim() ?? "";
      const box = r.querySelector(".checkbox-container");
      const want = wanted.some((w) => title.includes(w));
      if (box && box.classList.contains("is-enabled") !== want) box.click();
    }
  }, titles);
  /** The text of the import window's button that starts with “Import” (its label counts the ticked rows). */
  s.importButtonLabel = () => page.evaluate(() => [...([...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "").find((t) => /^Import( \d+| none)$/.test(t)) ?? "");
  s.modalClosed = (ms = 10000) => s.becomes(async () => !(await s.modalOpen()), ms, "the window to close");
  /** Type into the first text input of the open window (the Change note field). */
  s.typeInModal = (text) => page.evaluate((t) => {
    const input = [...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelector("input[type=text]");
    if (!input) return false;
    input.value = t;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, text);

  // ---- pickers (a SuggestModal: `.prompt` in `activeDocument`) and the editor
  s.pickerOpen = () => page.evaluate(() => Boolean(activeDocument.querySelector(".prompt")));
  /** Type into the picker's input as a person does (an `input` event; the plugin answers a moment after typing stops). */
  s.typeInPicker = (text) => page.evaluate((t) => {
    const input = activeDocument.querySelector(".prompt-input");
    if (!input) return false;
    input.value = t;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, text);
  /** The suggestions as text (title and detail run together, as textContent gives them). */
  s.pickerItems = () => page.evaluate(() => [...activeDocument.querySelectorAll(".prompt .suggestion-item")].map((e) => e.textContent ?? ""));
  s.pickerEmpty = () => page.evaluate(() => activeDocument.querySelector(".prompt .suggestion-empty")?.textContent ?? "");
  /** Wait until a suggestion containing `text` is listed. */
  s.pickerHas = (text, ms = 15000) => s.becomes(async () => (await s.pickerItems()).some((t) => t.includes(text)), ms, `a suggestion with “${text}”`);
  /** Choose the first suggestion containing `text` (a click, like a tap). */
  s.pickItem = (text) => page.evaluate((t) => {
    const el = [...activeDocument.querySelectorAll(".prompt .suggestion-item")].find((e) => (e.textContent ?? "").includes(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);
  s.closePicker = () => page.keyboard.press("Escape");
  /** The text of a note in its editor (what a person sees, before Obsidian has saved it). The panel has the focus, so look for the leaf that shows the note. */
  s.editorText = (path) => page.evaluate((p) => window.app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === p)?.view.editor?.getValue() ?? "", path);
  s.cursorToEnd = (path) => page.evaluate((p) => {
    const ed = window.app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === p)?.view.editor;
    if (!ed) return false;
    const last = ed.lastLine();
    ed.setCursor({ line: last, ch: ed.getLine(last).length });
    return true;
  }, path);
  /** The quote window's text box holds the item's text as its value (a textarea: textContent is empty). */
  s.quoteBoxText = () => page.evaluate(() => [...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelector(".blyg-quote-text")?.value ?? "");
  /** In the quote window's text box: select `passage` as a person does with the handles, and tell the box (`select`). */
  s.selectInQuoteBox = (passage) => page.evaluate((p) => {
    const box = [...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelector(".blyg-quote-text");
    if (!box) return false;
    const at = box.value.indexOf(p);
    if (at < 0) return false;
    box.focus();
    box.setSelectionRange(at, at + p.length);
    box.dispatchEvent(new Event("select", { bubbles: true }));
    return true;
  }, passage);

  // ---- notices
  s.notices = () => page.evaluate(() => [...window.__notices]);
  /** Forget the notices seen so far: call it before an action, so that a wait sees only what the action says. */
  s.clearNotices = () => page.evaluate(() => {
    window.__notices.length = 0;
    // A notice still on screen would be logged again at the next look: mark it as old, so a wait sees only notices made after this call.
    for (const n of activeDocument.querySelectorAll(".notice")) n.dataset.e2eOld = "1";
  });
  /** Wait for a notice that matches (a string: contains; a RegExp: test). Returns its text or "". */
  s.waitNotice = async (what, ms = 20000) => {
    const hit = (list) => list.find((t) => (typeof what === "string" ? t.includes(what) : what.test(t)));
    const found = (await s.becomes(async () => hit(await s.notices()) ?? false, ms, `a notice ${what}`)) || "";
    if (!found) console.error(`  (waiting for a notice ${what}; seen: ${JSON.stringify((await s.notices()).slice(-4).map((t) => t.slice(0, 160)))})`);
    return found;
  };

  // ---- the local Studio (REST, the owner token)
  s.studio = async (path, init = {}) => {
    const res = await fetch(`${STUDIO}/api${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  s.studioItem = async (id) => (await s.studio(`/items/${encodeURIComponent(id)}`));
  /** Edit an item's working copy "in the Studio's editor": read the revision, then write with it. */
  s.editInStudio = async (id, contentMd) => {
    const got = await s.studioItem(id);
    const done = await s.studio(`/items/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ contentMd, expectedRevision: got.json?.revision }) });
    return done.status;
  };

  // ---- layout: Chromium emulation of Obsidian's mobile UI (NOT iOS)
  s.phone = async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
    await page.evaluate(() => window.app.emulateMobile(true));
    await wait(3000);
    try { await page.getByText("Trust author and enable plugins").click({ timeout: 3000 }); } catch { /* none */ }
    await page.waitForFunction(() => window.app.plugins.plugins["blyg"], undefined, { timeout: 30000 });
    await s.logNotices();
    s.layout = "phone layout";
  };

  /** What a person would have seen when a step fails: text only (a token is never part of any of it). */
  s.dumpSeen = async (label) => {
    const seen = await page.evaluate(() => ({
      notices: [...(window.__notices ?? [])].slice(-6),
      modal: [...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.textContent?.slice(0, 500) ?? null,
      panel: document.querySelector(".blyg-pane")?.textContent?.slice(0, 500) ?? null,
    }));
    if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT.replace(/(\.\w+)?$/, `-${label.replace(/\W+/g, "-")}$1`) }).catch(() => {});
    console.error(`[${label}] seen:`, JSON.stringify(seen), "\nplugin log:\n" + s.pluginLog.slice(-10).join("\n"), "\npage errors:", s.pageErrors.slice(0, 3));
  };

  /** The last two checks of every run: nothing broke while it happened. */
  s.checkQuiet = () => {
    s.check(s.pageErrors.length === 0, `no uncaught page error${s.pageErrors.length ? `: ${s.pageErrors[0]}` : ""}`);
    const ours = s.consoleErrors.filter((t) => /blyg/i.test(t));
    s.check(ours.length === 0, `no console error that names the plugin${ours.length ? `: ${ours[0]}` : ""}`);
  };
  return s;
}

/** A scenario file's main: run `body(session)` in a fresh Obsidian, report, exit. */
export async function runScenario(options, body) {
  requireEnvironment();
  let s;
  try {
    s = await launch(options);
    s.check(Boolean(s.loaded), "the built main.js loads and the plugin `blyg` is enabled");
    if (!s.loaded) throw new Error("plugin did not load");
    await body(s);
    s.checkQuiet();
  } catch (e) {
    if (s) { s.crash(e); await s.dumpSeen("crash").catch(() => {}); } else { console.error(e); process.exitCode = 1; }
  }
  if (s) await s.finish();
  process.exit(1);
}
