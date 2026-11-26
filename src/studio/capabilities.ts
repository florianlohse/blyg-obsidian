// What a Studio can do, as it says so itself: the `operations` its `GET /capabilities` lists (operation ids, filtered to what the token may call),
// not the release number. The plugin supports contract 5 and 6 side by side (E1); this is where the two are told apart.
import type { ContractVerdict } from "./version";

/** Operation ids the plugin branches on. */
export const OPERATION = {
  /** `GET /changes`, the change counters: contract 5 has it, contract 6.0.0 removed it (Studio 0.67.0). */
  changes: "getChanges",
} as const;

/**
 * The first contract the plugin sends `tangle` to: measured on a real Studio 0.69.0 (contract 6.2). Which 5.x minor first had it (Studio 0.63 to 0.65.0) is not known
 * from the files in this repository, so a contract 5 Studio is treated as without it: the plugin then keeps refusing spans, as before. Widen when it is known.
 */
export const TANGLE_CONTRACT = { major: 6, minor: 0 } as const;

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
