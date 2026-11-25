// A one-slot bridge so the settings tab can run the Daily's "Sync check" without main.ts growing: src/digest/register.ts sets it, the tab calls it. Local reads only.
import type { DeviceSeen } from "./sync/store";

export interface SyncCheckResult {
  devices: DeviceSeen[];
  /** The size of this device's own key in data.json (bytes); null: none yet. */
  ownKeyBytes: number | null;
}
export type SyncCheck = () => Promise<SyncCheckResult>;
let check: SyncCheck | null = null;
export const setSyncCheck = (c: SyncCheck | null): void => {
  check = c;
};
/** The devices whose digest files this device sees; null when the Daily is not wired. */
export const runSyncCheck = (): Promise<SyncCheckResult | null> => (check ? check() : Promise.resolve(null));
