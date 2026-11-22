// HK5 (prototype): the author-style profile. DATA only: sRGB hex colours for a light and a dark reading surface and a font ROLE the reader maps to its own stacks.
// No CSS strings, no font names, nothing fetched. Anything that is not exactly this shape is rejected (the reader then shows the Clean look); nothing here throws.
import { HEX } from "./contrast";

export const PROFILE_VERSION = 1;
export const FONT_ROLES = ["serif", "sans", "mono"] as const;
export type FontRole = (typeof FONT_ROLES)[number];
export const COLOR_KEYS = ["surface", "text", "softText", "accent", "rule"] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

export type StylePalette = Record<ColorKey, string>;
export interface StyleProfile {
  version: typeof PROFILE_VERSION;
  font: FontRole;
  light: StylePalette;
  dark: StylePalette;
}

export type ParseResult = { ok: true; profile: StyleProfile } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) return `unknown key "${k.slice(0, 20)}"`;
  for (const k of keys) if (!(k in o)) return `missing "${k}"`;
  return null;
};

function palette(raw: unknown, where: string): StylePalette | string {
  if (!isObj(raw)) return `${where}: not an object`;
  const bad = exactKeys(raw, COLOR_KEYS);
  if (bad) return `${where}: ${bad}`;
  const out = {} as StylePalette;
  for (const k of COLOR_KEYS) {
    const v = raw[k];
    if (typeof v !== "string" || !HEX.test(v)) return `${where}.${k}: not a #rrggbb colour`;
    out[k] = v.toLowerCase();
  }
  return out;
}

/** Validate a received or loaded profile. Never throws. */
export function parseProfile(raw: unknown): ParseResult {
  try {
    if (!isObj(raw)) return { ok: false, reason: "not an object" };
    if (raw.version !== PROFILE_VERSION) return { ok: false, reason: "unknown version" };
    const bad = exactKeys(raw, ["version", "font", "light", "dark"]);
    if (bad) return { ok: false, reason: bad };
    if (typeof raw.font !== "string" || !(FONT_ROLES as readonly string[]).includes(raw.font)) return { ok: false, reason: "unknown font role" };
    const light = palette(raw.light, "light");
    if (typeof light === "string") return { ok: false, reason: light };
    const dark = palette(raw.dark, "dark");
    if (typeof dark === "string") return { ok: false, reason: dark };
    return { ok: true, profile: { version: PROFILE_VERSION, font: raw.font as FontRole, light, dark } };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** Parse a stored profile (JSON text). Never throws. */
export function parseProfileJson(text: string): ParseResult {
  try {
    return parseProfile(JSON.parse(text));
  } catch {
    return { ok: false, reason: "not JSON" };
  }
}
