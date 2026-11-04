// What the panel remembers about deploys: one result per repository path, not one for the whole session. With a single slot the second
// of two quick publishes erased the first one's verdict, so the first note's panel showed nothing at all (found in the T0 device test,
// 2026-10-19). Now each note keeps the result of its own newest publish until a newer publish of the same file replaces it.
import type { PanelDeploy } from "./panelState";

/** Most files remembered: a session that publishes more forgets the oldest. */
const MAX_REMEMBERED = 30;

export interface DeployMemory {
  set(path: string | undefined, deploy: PanelDeploy): void;
  forget(path: string | undefined): void;
  /** The result for the note that owns `path` (or a result that names no file, which belongs to every note). */
  get(path: string | undefined): PanelDeploy | null;
}

export function createDeployMemory(): DeployMemory {
  const byPath = new Map<string, PanelDeploy>();
  const key = (path: string | undefined): string => path ?? "";
  return {
    set(path, deploy) {
      byPath.delete(key(path)); // re-insert so the oldest entry is the first to go
      byPath.set(key(path), deploy);
      while (byPath.size > MAX_REMEMBERED) {
        const oldest = byPath.keys().next();
        if (oldest.done) break;
        byPath.delete(oldest.value);
      }
    },
    forget(path) {
      byPath.delete(key(path));
    },
    get(path) {
      return byPath.get(key(path)) ?? byPath.get("") ?? null;
    },
  };
}
