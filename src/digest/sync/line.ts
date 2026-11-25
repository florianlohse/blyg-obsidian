// The muted lines under the Daily's masthead (DG16, DG20): how many devices carry the edition (only when more than this one), and whether a file is still arriving. Pure.
import type { DeviceSeen, SyncInfo } from "./store";

const date = (t: number): string => new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
const time = (t: number): string => new Date(t).toLocaleTimeString(undefined, { timeStyle: "short" });

export function syncLines(info: SyncInfo, _editionId: number | null): string[] {
  const out: string[] = [];
  // Nothing extra when this device is alone with the edition (DG20: no device names, no "made on" line).
  if (info.others > 0) out.push(`Synced from ${info.others + 1} devices`);
  if (info.waiting) out.push("Waiting for sync: a file from another device is still arriving.");
  return out;
}

const stamp = (t: number | null): string => (t === null ? "none yet" : `${date(t)} ${time(t)}`);

const via = (v: DeviceSeen["via"]): string => (v.length === 0 ? "nothing seen yet" : v.map((x) => (x === "settings" ? "via settings file" : "via digest folder")).join(" and "));
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/** The "Sync check" lines for Settings: one per device (name, how it was seen, newest edition, when it was written, "this device"), this device's key size, and a plain line when no other device is seen. Pure. */
export function checkLines(devices: readonly DeviceSeen[], ownKeyBytes: number | null = null): string[] {
  const out = devices.map((d) => `${d.mine ? "This device" : `Another device ${d.device.slice(0, 4)}`} · ${via(d.via)} · newest edition ${d.newestEdition === null ? "none yet" : date(d.newestEdition)} · file ${stamp(d.modified)}`);
  out.push(ownKeyBytes === null ? "This device's key in the settings file: not written yet." : `This device's key in the settings file: ${kb(ownKeyBytes)}.`);
  if (!devices.some((d) => !d.mine)) out.push("No other device's files seen yet.");
  return out;
}
