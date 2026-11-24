// What a failed scenario leaves behind for a person who was not there (CI uploads the folder when the job fails; locally it is E2E_FAIL_DIR).
// Text only is redacted here: a token, a key or an authorization header never reaches a file. Pure helpers are exported for tests/scripts/e2e-artifacts.test.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|cookie|credential|private[-_]?key/i;
const JWT = /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g;

/** Text with every secret-shaped part replaced: the run's own token (`secrets`), a JWT, "Bearer x", "authorization: x", `key=value` pairs of secret-named keys. */
export function redactText(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && String(s).length >= 8) out = out.split(String(s)).join("[redacted]");
  return out
    .replace(JWT, "[redacted]")
    .replace(/\bBearer\s+[\w.~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/(authorization|cookie|set-cookie)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1$2[redacted]")
    .replace(/((?:api[-_]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}&]{6,}/gi, "$1[redacted]");
}

/** A copy of a JSON value in which the value of every secret-named key is replaced (and the rest passes through redactText). */
export function redactJson(value, secrets = []) {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === "string" && v ? "[redacted]" : redactJson(v, secrets)]));
  }
  return typeof value === "string" ? redactText(value, secrets) : value;
}

/** Runs IN the page: the open leaves, the reader mode, counts and the first 20 visible `.blyg-*` texts. */
export function domSnapshot() {
  const app = window.app;
  const leaves = [];
  app?.workspace?.iterateAllLeaves?.((l) => leaves.push({ type: l.view?.getViewType?.() ?? "?", title: String(l.getDisplayText?.() ?? "").slice(0, 60) }));
  const rp = app?.plugins?.plugins?.blyg?.settings?.readerPane;
  const count = (sel) => document.querySelectorAll(sel).length;
  const visible = (e) => e.getClientRects().length > 0 && (e.textContent ?? "").trim() !== "";
  const texts = [...document.querySelectorAll("[class*='blyg-']")].filter(visible).slice(0, 20)
    .map((e) => ({ cls: String(e.className).split(/\s+/).filter((c) => c.startsWith("blyg-")).join(" "), text: (e.textContent ?? "").trim().slice(0, 120) }));
  return {
    leaves,
    readerMode: rp?.mode ?? "feed",
    readerPane: rp ?? null,
    counts: { cards: count(".blyg-reader-card"), stories: count(".blyg-story"), mixedStories: count(".blyg-story-mixed"), modals: activeDocument.querySelectorAll(".modal-container .modal").length, notices: activeDocument.querySelectorAll(".notice").length },
    modalTitle: [...activeDocument.querySelectorAll(".modal-container .modal")].at(-1)?.querySelector(".modal-title")?.textContent?.trim() ?? null,
    notices: [...(window.__notices ?? [])].slice(-6),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    texts,
  };
}

const guarded = async (fn, ms = 10000) => { let t; try { return await Promise.race([fn(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timed out")), ms); })]); } finally { clearTimeout(t); } };

/**
 * Write the artifacts of one moment to `dir`: a screenshot of every open window, dom.json, settings.json (from the page, else from the vault's data.json), console.log.
 * Never throws: a capture that fails says so in `capture-errors.txt` and the rest is still written.
 */
export async function writeArtifacts({ dir, browser, page, failures, consoleLog, pageErrors, secrets, dataFile, read }) {
  mkdirSync(dir, { recursive: true });
  const errors = [];
  const put = (name, text) => { try { writeFileSync(join(dir, name), redactText(text, secrets)); } catch (e) { errors.push(`${name}: ${e}`); } };
  put("failed-checks.txt", failures.join("\n") + "\n");
  try {
    const pages = (browser?.contexts() ?? []).flatMap((c) => c.pages().map((p) => ({ c, p })));
    let i = 0;
    for (const { c, p } of pages) {
      const n = i++;
      try {
        const cdp = await guarded(() => c.newCDPSession(p));
        const shot = await guarded(() => cdp.send("Page.captureScreenshot", { format: "png" }));
        writeFileSync(join(dir, `window-${n}.png`), Buffer.from(shot.data, "base64"));
        await cdp.detach().catch(() => {});
      } catch (e) { errors.push(`screenshot ${n}: ${e}`); }
    }
  } catch (e) { errors.push(`windows: ${e}`); }
  try { put("dom.json", JSON.stringify(redactJson(await guarded(() => page.evaluate(domSnapshot)), secrets), null, 2)); } catch (e) { errors.push(`dom: ${e}`); }
  let settings = null;
  try { settings = await guarded(() => page.evaluate(() => JSON.parse(JSON.stringify(window.app.plugins.plugins.blyg?.settings ?? null)))); } catch (e) { errors.push(`settings (page): ${e}`); }
  if (!settings) { try { settings = JSON.parse(read(dataFile)); } catch (e) { errors.push(`settings (file): ${e}`); } }
  put("settings.json", JSON.stringify(redactJson(settings, secrets), null, 2));
  put("console.log", [...consoleLog, ...pageErrors.map((e) => `[pageerror] ${e}`)].join("\n") + "\n");
  if (errors.length) put("capture-errors.txt", errors.join("\n") + "\n");
}
