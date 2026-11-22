// HK5 (prototype): colour arithmetic for the author-style profile: WCAG contrast of sRGB hex colours, and the same linear mix CSS `color-mix(in srgb, ...)` does.
// Pure functions; no DOM, no network.
export const HEX = /^#[0-9a-fA-F]{6}$/;

export type Rgb = [number, number, number];

export function rgbOf(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function hexOf(rgb: Rgb): string {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `share` of `a` (0..1) mixed with the rest of `b`, like CSS `color-mix(in srgb, a share%, b)`. Returns a hex. */
export function mix(a: string, share: number, b: string): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf([0, 1, 2].map((i) => x[i]! * share + y[i]! * (1 - share)) as Rgb);
}
