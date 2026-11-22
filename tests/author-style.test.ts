import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ FuzzySuggestModal: class { setPlaceholder() {} }, Modal: class {}, Notice: class {}, setIcon: () => {} }));

import { contrastRatio } from "../src/style/contrast";
import { parseProfile, parseProfileJson } from "../src/style/profile";
import { applyStyle, clearStyle, AUTHORED_CLASS } from "../src/style/apply";
import { resolveStyle, STYLE_VARS, QUOTE_TEXT_FLOOR, floorFor, leveled } from "../src/style/resolve";
import { PROTOTYPE_PROFILES } from "../src/dev/authorStyle";
import { registerDevCommands } from "../src/dev/drawBench";
import { READER_FONTS } from "../src/ui/readerFonts";
import { CONTRASTS } from "../src/ui/readerLook";

const good = PROTOTYPE_PROFILES[0]!.profile;
const bad = { ...good, light: { ...good.light, text: "#9a9a9a", softText: "#a0a0a0", accent: "#b0b0b0" }, dark: { ...good.dark, text: "#555555" } };
const combos = CONTRASTS.flatMap((level) => [false, true].map((dark) => ({ level, dark })));

function fakeEl() {
  const props = new Map<string, string>();
  const classes = new Set<string>();
  return { props, classes, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }, style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) } };
}

describe("profile validation (receipt and load)", () => {
  it("accepts the prototypes", () => {
    for (const p of PROTOTYPE_PROFILES) expect(parseProfile(p.profile).ok).toBe(true);
  });
  it("rejects unknown version, bad hex, missing and extra keys, bad role; never throws", () => {
    type Loose = { light: Record<string, unknown> | null; dark: Record<string, unknown> };
    const clone = (): Loose => JSON.parse(JSON.stringify(good)) as Loose;
    const cases: unknown[] = [null, 5, "x", [], {}, { ...clone(), version: 2 }, { ...clone(), font: "Comic Sans" }, { ...clone(), extra: 1 }];
    const c1 = clone(); c1.light!.text = "red"; cases.push(c1);
    const c2 = clone(); c2.light!.text = "#fff"; cases.push(c2);
    const c3 = clone(); c3.dark.text = "url(http://x)"; cases.push(c3);
    const c4 = clone(); delete c4.dark.rule; cases.push(c4);
    const c5 = clone(); c5.light!.css = "x"; cases.push(c5);
    const c6 = clone(); c6.light = null; cases.push(c6);
    for (const c of cases) {
      expect(() => parseProfile(c)).not.toThrow();
      expect(parseProfile(c).ok).toBe(false);
      expect(resolveStyle(c, { dark: false, level: "normal" }).authored).toBe(false);
    }
    expect(parseProfileJson("{nope").ok).toBe(false);
    expect(parseProfileJson(JSON.stringify(good)).ok).toBe(true);
  });
});

describe("R3 (a): style causes no requests", () => {
  it("makes no call to any transport and the modules import none", () => {
    const f = vi.fn(() => { throw new Error("network"); });
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("XMLHttpRequest", f);
    for (const p of PROTOTYPE_PROFILES) for (const ctx of combos) applyStyle(fakeEl(), resolveStyle(p.profile, ctx));
    resolveStyle(bad, { dark: true, level: "high" });
    parseProfileJson("{}");
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    for (const dir of ["src/style"]) for (const file of readdirSync(dir)) {
      const src = readFileSync(`${dir}/${file}`, "utf8");
      expect(src).not.toMatch(/requestUrl|fetch\(|XMLHttpRequest|WebSocket|\bimport\(|from "obsidian"/);
    }
  });
});

describe("R3 (b): only reader-owned roles change", () => {
  it("writes only the plugin's own --blyg-a-* variables, and only hex values or a reader font stack", () => {
    for (const p of PROTOTYPE_PROFILES) for (const ctx of combos) {
      const el = fakeEl();
      applyStyle(el, resolveStyle(p.profile, ctx));
      expect(el.classes.has(AUTHORED_CLASS)).toBe(true);
      expect([...el.props.keys()].sort()).toEqual([...STYLE_VARS].sort());
      for (const [k, v] of el.props) {
        expect(k.startsWith("--blyg-a-")).toBe(true);
        if (k === "--blyg-a-font") expect(Object.values(READER_FONTS)).toContain(v);
        else expect(v).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
  it("a switch replaces the old look at once and Clean removes everything", () => {
    const el = fakeEl();
    applyStyle(el, resolveStyle(PROTOTYPE_PROFILES[0]!.profile, { dark: false, level: "normal" }));
    const first = el.props.get("--blyg-a-surface");
    applyStyle(el, resolveStyle(PROTOTYPE_PROFILES[1]!.profile, { dark: false, level: "normal" }));
    expect(el.props.get("--blyg-a-surface")).not.toBe(first);
    applyStyle(el, resolveStyle(null, { dark: false, level: "normal" }));
    expect(el.props.size).toBe(0);
    expect(el.classes.size).toBe(0);
    clearStyle(el);
  });
  it("the additive CSS stays inside the reading surface and never touches layout", () => {
    const css = readFileSync("styles.css", "utf8");
    const block = css.slice(css.indexOf("HK5 (prototype)"));
    const rules = block.split("\n").filter((l) => l.includes("{"));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r).toMatch(/^\.blyg-reader-surface\.is-authored/);
      expect(r).not.toMatch(/\b(margin|padding|display|width|height|position|font-size|line-height|content|text-decoration|background)\s*:/);
    }
  });
  it("the variables are read only under .is-authored (no default effect)", () => {
    const css = readFileSync("styles.css", "utf8");
    const outside = css.slice(0, css.indexOf("HK5 (prototype)"));
    expect(outside).not.toMatch(/--blyg-a-/);
  });
});

describe("R3 (c): readable under the reader's settings", () => {
  it("each prototype holds its floors in all contrast levels, light and dark", () => {
    for (const p of PROTOTYPE_PROFILES) for (const ctx of combos) {
      const r = resolveStyle(p.profile, ctx);
      expect(r.reason, `${p.name} ${ctx.level} ${ctx.dark}`).toBeUndefined();
      expect(r.authored).toBe(true);
      const pal = ctx.dark ? p.profile.dark : p.profile.light;
      const s = r.vars["--blyg-a-surface"]!;
      expect(s).toBe(pal.surface);
      expect(contrastRatio(r.vars["--blyg-a-ink"]!, s)).toBeGreaterThanOrEqual(floorFor(ctx.level));
      expect(contrastRatio(r.vars["--blyg-a-soft"]!, s)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.vars["--blyg-a-link"]!, s)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("a bad profile falls back to Clean and names the role", () => {
    const light = resolveStyle(bad, { dark: false, level: "normal" });
    expect(light.authored).toBe(false);
    expect(light.vars).toEqual({});
    expect(light.reason).toMatch(/^text contrast/);
    expect(resolveStyle(bad, { dark: true, level: "normal" }).reason).toMatch(/^text contrast/);
    const softOnly = { ...good, light: { ...good.light, softText: "#d0c0a0" } };
    expect(resolveStyle(softOnly, { dark: false, level: "normal" }).reason).toMatch(/^softText/);
    const accentOnly = { ...good, light: { ...good.light, accent: "#fbf0dc" } };
    expect(resolveStyle(accentOnly, { dark: false, level: "normal" }).reason).toMatch(/^accent/);
  });
  it("the reader's own level is respected: text that is fine at normal can fail at reduced", () => {
    const mid = { ...good, light: { ...good.light, text: "#554534" } };
    expect(resolveStyle(mid, { dark: false, level: "normal" }).authored).toBe(true);
    expect(resolveStyle(mid, { dark: false, level: "high" }).authored).toBe(true); // high mixes toward black, which only helps
    expect(resolveStyle(mid, { dark: false, level: "reduced" }).reason).toMatch(/^text contrast/); // reduced dims it toward the surface
    expect(contrastRatio(leveled("#000000", "#ffffff", { dark: false, level: "reduced" }), "#ffffff")).toBeLessThan(21);
    const low = { ...good, light: { ...good.light, text: "#7a6a58" } }; // too light for the quote cue at normal, and short of the 7:1 high wants
    expect(resolveStyle(low, { dark: false, level: "high" }).reason).toMatch(/^text contrast/);
  });
});

describe("R3 (d): quotes stay recognisable", () => {
  it("the quote cue is plugin-derived, differs from the body text, and keeps its contrast", () => {
    for (const p of PROTOTYPE_PROFILES) for (const ctx of combos) {
      const r = resolveStyle(p.profile, ctx).vars;
      const s = r["--blyg-a-surface"]!;
      const pal = ctx.dark ? p.profile.dark : p.profile.light;
      for (const k of ["--blyg-a-quote-ink", "--blyg-a-quote-bar"] as const) {
        expect(r[k]).not.toBe(r["--blyg-a-ink"]);
        for (const own of [pal.text, pal.softText, pal.accent, pal.rule]) expect(r[k]).not.toBe(own);
      }
      expect(contrastRatio(r["--blyg-a-quote-ink"]!, s)).toBeGreaterThanOrEqual(QUOTE_TEXT_FLOOR);
      expect(contrastRatio(r["--blyg-a-quote-bar"]!, s)).toBeGreaterThanOrEqual(3);
    }
  });
  it("the CSS draws the quote bar and label from the plugin-derived variables, not the profile's link or rule", () => {
    const css = readFileSync("styles.css", "utf8");
    const block = css.slice(css.indexOf("HK5 (prototype)"));
    const quoteRules = block.split("\n").filter((l) => /blockquote/.test(l));
    expect(quoteRules.length).toBeGreaterThan(0);
    for (const r of quoteRules) {
      expect(r).toMatch(/--blyg-a-quote-(bar|ink)/);
      expect(r).not.toMatch(/--blyg-a-(link|rule|soft)/);
    }
  });
});

describe("dev-only switch", () => {
  it("is registered in the development build only", () => {
    const mk = (id: string) => { const ids: string[] = []; return { ids, p: { manifest: { id }, app: {}, addCommand: (c: { id: string }) => ids.push(c.id) } as never }; };
    const dev = mk("blyg-dev"); registerDevCommands(dev.p);
    expect(dev.ids).toContain("dev-author-look");
    const rel = mk("blyg"); registerDevCommands(rel.p);
    expect(rel.ids).toEqual([]);
  });
});
