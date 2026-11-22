// HK5 (prototype): from a profile to the few values the reader paints: checks the contrast floors on the surface actually painted, under the reader's contrast level
// (the same mixes as the reader's styles.css), and falls back to the Clean look (no values) with a reason naming the role that failed. Pure: no DOM, no network.
import { contrastRatio, mix } from "./contrast";
import { parseProfile, type StylePalette } from "./profile";
import { READER_FONTS } from "../ui/readerFonts";
import type { ReaderContrast } from "../ui/readerLook";

export interface StyleContext { dark: boolean; level: ReaderContrast }

/** The only custom properties a profile may cause to be written (all on the reading surface element). */
export const STYLE_VARS = ["--blyg-a-surface", "--blyg-a-ink", "--blyg-a-soft", "--blyg-a-link", "--blyg-a-rule", "--blyg-a-font", "--blyg-a-quote-ink", "--blyg-a-quote-bar"] as const;
export type StyleVar = (typeof STYLE_VARS)[number];

export interface ResolvedStyle {
  /** false: the Clean look (nothing is written). */
  authored: boolean;
  vars: Partial<Record<StyleVar, string>>;
  /** Why the Clean look was used, naming the role; undefined when applied or when no profile was asked for. Shown nowhere by default. */
  reason?: string;
}

export const CLEAN: ResolvedStyle = { authored: false, vars: {} };
const clean = (reason?: string): ResolvedStyle => (reason ? { authored: false, vars: {}, reason } : CLEAN);

/** Text contrast floors: 4.5:1, 7:1 for the reader's high level. Non-text (rules, the quote bar): 1.3:1 and 3:1. */
export const floorFor = (level: ReaderContrast): number => (level === "high" ? 7 : 4.5);
export const QUOTE_TEXT_FLOOR = 4.5;
export const QUOTE_BAR_FLOOR = 3;
export const RULE_FLOOR = 1.3;

/** The reader's level applied to a text colour, as styles.css does it: reduced mixes 74% toward the surface, high 82% toward black (light) or white (dark). */
export function leveled(text: string, surface: string, ctx: StyleContext): string {
  if (ctx.level === "reduced") return mix(text, 0.74, surface);
  if (ctx.level === "high") return mix(text, 0.82, ctx.dark ? "#ffffff" : "#000000");
  return text;
}

export function resolvePalette(pal: StylePalette, font: keyof typeof READER_FONTS, ctx: StyleContext): ResolvedStyle {
  const s = pal.surface;
  const need = floorFor(ctx.level);
  const ink = leveled(pal.text, s, ctx);
  const soft = pal.softText; // the reader's levels change the main ink only
  const checks: Array<[string, number, number]> = [
    ["text", contrastRatio(ink, s), need],
    ["softText", contrastRatio(soft, s), 4.5],
    ["accent", contrastRatio(pal.accent, s), 4.5],
    ["rule", contrastRatio(pal.rule, s), RULE_FLOOR],
  ];
  // The plugin's own quote cue (label and bar) is derived from the profile text colour (not level-dimmed, so it stays readable), never taken from it as is.
  const quoteInk = mix(pal.text, 0.8, s);
  const quoteBar = mix(pal.text, 0.6, s);
  checks.push(["quote cue", contrastRatio(quoteInk, s), QUOTE_TEXT_FLOOR], ["quote bar", contrastRatio(quoteBar, s), QUOTE_BAR_FLOOR]);
  for (const [role, got, floor] of checks) {
    if (!(got >= floor)) return clean(`${role} contrast ${got.toFixed(2)} is under ${floor}:1 (${ctx.dark ? "dark" : "light"}, ${ctx.level})`);
  }
  return {
    authored: true,
    vars: { "--blyg-a-surface": s, "--blyg-a-ink": ink, "--blyg-a-soft": soft, "--blyg-a-link": pal.accent, "--blyg-a-rule": pal.rule, "--blyg-a-font": READER_FONTS[font], "--blyg-a-quote-ink": quoteInk, "--blyg-a-quote-bar": quoteBar },
  };
}

/** Anything (a profile, or garbage) to what the reader paints. Never throws; a profile that is not valid or not readable gives the Clean look. */
export function resolveStyle(raw: unknown, ctx: StyleContext): ResolvedStyle {
  if (raw === null || raw === undefined) return CLEAN;
  const p = parseProfile(raw);
  if (!p.ok) return clean(`invalid profile: ${p.reason}`);
  return resolvePalette(ctx.dark ? p.profile.dark : p.profile.light, p.profile.font, ctx);
}
