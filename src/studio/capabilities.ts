// What a Studio can do, as it says so itself: the `operations` its `GET /capabilities` lists (operation ids, filtered to what the token may call),
// not the release number. The plugin supports contract 5 and 6 side by side (E1); this is where the two are told apart.
import type { ContractVerdict } from "./version";

/** Operation ids the plugin branches on. */
export const OPERATION = {
  /** `GET /changes`, the change counters: contract 5 has it, contract 6.0.0 removed it (Studio 0.67.0). */
  changes: "getChanges",
} as const;

/**
 * The first contract the plugin sends `tangle` to: 5.12.0 (Studio 0.63.0, where tangling first shipped; 0.64.0 is 5.13.0, 0.65.0 is 5.14.0, and contract 6.0.0 arrives
 * with 0.67.0, so every contract 6 has it). Checked against a real Studio 0.69.0 (contract 6.2); a contract 5 older than 5.12 has no `tangle`, and the plugin then keeps
 * refusing spans and placeholders, as before. The pinned end-to-end leg (Studio 0.51.0, contract 5.2) therefore only checks that refusal.
 */
export const TANGLE_CONTRACT = { major: 5, minor: 12 } as const;

/**
 * Does this Studio list the operation? False when the verdict is not "ok", or the Studio listed no operations at all: a feature that cannot be shown
 * to exist is treated as absent, and the caller then takes its path for a Studio without it.
 */
export function offers(verdict: ContractVerdict | undefined, operation: string): boolean {
  return verdict !== undefined && verdict.kind === "ok" && verdict.operations !== null && verdict.operations.has(operation);
}

/** Is the Studio's announced contract at least `major.minor`? False when the verdict is not "ok": what cannot be shown is treated as absent. */
export function contractAtLeast(verdict: ContractVerdict | undefined, major: number, minor: number): boolean {
  if (verdict === undefined || verdict.kind !== "ok") return false;
  const announced = Number(verdict.contract.split(".")[1]);
  return verdict.major > major || (verdict.major === major && announced >= minor);
}
