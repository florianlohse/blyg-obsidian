// The muted lines under the Daily's masthead (DG16): who made the edition, how many other devices carry it, and whether a file is still arriving. Pure.
import type { DeviceSeen, SyncInfo } from "./store";

const date = (t: number): string => new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
const time = (t: number): string => new Date(t).toLocaleTimeString(undefined, { timeStyle: "short" });

export function syncLines(info: SyncInfo, editionId: number | null): string[] {
  const out: string[] = [];
  const parts: string[] = [];
  // Always something to see: who made the edition (this device when the creator is not known), and how many other devices carry it (none: said so).
  if (editionId !== null) parts.push(info.made ? `Edition of ${date(editionId)}, made on ${info.made.label} at ${time(info.made.at)}` : `Edition of ${date(editionId)}, made on ${info.me}`);
  else parts.push(`This device: ${info.me}`);
  parts.push(info.others > 0 ? `Synced from ${info.others} ${info.others === 1 ? "device" : "devices"}` : "Not synced from another device yet");
  out.push(parts.join(" · "));
  if (info.waiting) out.push("Waiting for sync: a file from another device is still arriving.");
  return out;
}

const stamp = (t: number | null): string => (t === null ? "none yet" : `${date(t)} ${time(t)}`);

const via = (v: DeviceSeen["via"]): string => (v.length === 0 ? "nothing seen yet" : v.map((x) => (x === "settings" ? "via settings file" : "via digest folder")).join(" and "));
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/** The "Sync check" lines for Settings: one per device (name, how it was seen, newest edition, when it was written, "this device"), this device's key size, and a plain line when no other device is seen. Pure. */
export function checkLines(devices: readonly DeviceSeen[], ownKeyBytes: number | null = null): string[] {
  const out = devices.map((d) => `${d.label}${d.mine ? " (this device)" : ""} · ${via(d.via)} · newest edition ${d.newestEdition === null ? "none yet" : date(d.newestEdition)} · file ${stamp(d.modified)}`);
  out.push(ownKeyBytes === null ? "This device's key in the settings file: not written yet." : `This device's key in the settings file: ${kb(ownKeyBytes)}.`);
  if (!devices.some((d) => !d.mine)) out.push("No other device's files seen yet.");
  return out;
}
