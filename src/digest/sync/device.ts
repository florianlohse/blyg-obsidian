// This device's identity for the Daily's sync: a random id, kept PER DEVICE (Obsidian's local storage, never in data.json, which may sync). No device names (DG20).
export const DEVICE_ID_KEY = "blyg-digest-device";

export interface LocalStore {
  load(key: string): unknown;
  save(key: string, value: string | null): void;
}
/** The device's id: made once, then kept in this device's local storage. */
export function deviceId(store: LocalStore, random: (n: number) => Uint8Array): string {
  const have = store.load(DEVICE_ID_KEY);
  if (typeof have === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(have)) return have;
  const id = Array.from(random(6), (b) => b.toString(16).padStart(2, "0")).join("");
  store.save(DEVICE_ID_KEY, id);
  return id;
}
