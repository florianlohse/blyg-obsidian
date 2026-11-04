import type { StudioFailure } from "../studio/types";
import { M } from "./messages";
import { failed, type Outcome } from "./types";

/** A Studio failure as the outcome the user reads. `what` names the step ("Publishing", "Preview"). */
export function studioFailureOutcome(what: string, f: StudioFailure): Outcome {
  switch (f.kind) {
    case "unauthorized":
      return failed(M.studioUnauthorized);
    case "forbidden":
      return failed(M.studioForbidden(f.message));
    case "not-found":
      return failed(M.studioError(what, 404, "not found"));
    case "conflict":
      return failed(M.studioConflict(what));
    case "incompatible":
      return failed(f.message);
    case "rejected":
      return failed(M.studioRefused(what, f.message, f.problems.map((p) => (p.directive ? `${p.directive}: ${p.reason}` : p.reason))));
    case "error":
      return failed(M.studioError(what, f.status, f.message));
  }
}
