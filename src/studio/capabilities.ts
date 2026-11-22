// What a Studio can do, as it says so itself: the `operations` its `GET /capabilities` lists (operation ids, filtered to what the token may call),
// not the release number. The plugin supports contract 5 and 6 side by side (E1); this is where the two are told apart.
import type { ContractVerdict } from "./version";

/** Operation ids the plugin branches on. */
export const OPERATION = {
  /** `GET /changes`, the change counters: contract 5 has it, contract 6.0.0 removed it (Studio 0.67.0). */
  changes: "getChanges",
} as const;

/**
 * Does this Studio list the operation? False when the verdict is not "ok", or the Studio listed no operations at all: a feature that cannot be shown
 * to exist is treated as absent, and the caller then takes its path for a Studio without it.
 */
export function offers(verdict: ContractVerdict | undefined, operation: string): boolean {
  return verdict !== undefined && verdict.kind === "ok" && verdict.operations !== null && verdict.operations.has(operation);
}
