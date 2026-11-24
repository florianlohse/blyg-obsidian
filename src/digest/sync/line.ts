// The muted lines under the Daily's masthead (DG16): who made the edition, how many other devices carry it, and whether a file is still arriving. Pure.
import type { DeviceSeen, SyncInfo } from "./store";

const date = (t: number): string => new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
const time = (t: number): string => new Date(t).toLocaleTimeString(undefined, { timeStyle: "short" });

export function syncLines(info: SyncInfo, editionId: number | null): string[] {
  const out: string[] = [];
  const parts: string[] = [];
  if (info.made && editionId !== null) parts.push(`Edition of ${date(editionId)}, made on ${info.made.label} at ${time(info.made.at)}`);
  if (info.others > 0) parts.push(`Synced from ${info.others} ${info.others === 1 ? "device" : "devices"}`);
  if (parts.length > 0) out.push(parts.join(" · "));
  if (info.waiting) out.push("Waiting for sync: a file from another device is still arriving.");
  return out;
}

const stamp = (t: number | null): string => (t === null ? "none yet" : `${date(t)} ${time(t)}`);

/** The "Sync check" lines for Settings: one per device (name, newest edition, file time, "this device"), and a plain line when only this device's files are there. Pure. */
export function checkLines(devices: readonly DeviceSeen[]): string[] {
  const out = devices.map((d) => `${d.label}${d.mine ? " (this device)" : ""} · newest edition ${d.newestEdition === null ? "none yet" : date(d.newestEdition)} · file ${stamp(d.modified)}`);
  if (!devices.some((d) => !d.mine)) out.push("No other device's files seen yet.");
  return out;
}
