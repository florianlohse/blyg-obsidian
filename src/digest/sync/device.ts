// This device's identity for the Daily's sync: a random id and a short name, kept PER DEVICE (Obsidian's local storage, never in data.json, which may sync).
export const DEVICE_ID_KEY = "blyg-digest-device";
export const DEVICE_LABEL_KEY = "blyg-digest-device-label";

export interface LocalStore {
  load(key: string): unknown;
  save(key: string, value: string | null): void;
}
export interface PlatformLike {
  isIosApp?: boolean;
  isAndroidApp?: boolean;
  isTablet?: boolean;
  isPhone?: boolean;
  isMacOS?: boolean;
  isWin?: boolean;
  isLinux?: boolean;
}

/** A short name from the platform: "iPhone", "iPad", "Mac", "Windows PC", "Linux PC", "Android phone", "Android tablet", else "Device". */
export function defaultLabel(p: PlatformLike): string {
  if (p.isIosApp) return p.isTablet ? "iPad" : "iPhone";
  if (p.isAndroidApp) return p.isTablet ? "Android tablet" : "Android phone";
  if (p.isMacOS) return "Mac";
  if (p.isWin) return "Windows PC";
  if (p.isLinux) return "Linux PC";
  return "Device";
}

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 40) : "");

/** The device's id: made once, then kept in this device's local storage. */
export function deviceId(store: LocalStore, random: (n: number) => Uint8Array): string {
  const have = store.load(DEVICE_ID_KEY);
  if (typeof have === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(have)) return have;
  const id = Array.from(random(6), (b) => b.toString(16).padStart(2, "0")).join("");
  store.save(DEVICE_ID_KEY, id);
  return id;
}

/**
 * The name the person set for this device (kept as it is), else the platform's. Only the platform's name gets a short suffix from the device id, and only when another device
 * of the synced files already carries that very name (`taken`), so "iPhone" stays "iPhone" until a second one appears. The suffix is the same on every call (it comes from the id).
 */
export function deviceLabel(store: LocalStore, p: PlatformLike, id = "", taken: readonly string[] = []): string {
  const own = clean(store.load(DEVICE_LABEL_KEY));
  if (own) return own;
  const base = defaultLabel(p);
  const same = (a: string): boolean => a.trim().toLowerCase() === base.toLowerCase();
  return id && taken.some(same) ? `${base} ${id.slice(0, 4)}` : base;
}
export const setDeviceLabel = (store: LocalStore, name: string): void => store.save(DEVICE_LABEL_KEY, clean(name) || null);
