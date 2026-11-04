// Studio-only mode (M1, lane A2.4): someone who publishes only through a Blygger Studio needs no GitHub settings, no GitHub token and
// none of the GitHub-site features (Blyg items committed to a site repository, plain files, the preview channel, deploy status).
// Nothing is removed: the code stays, and the settings of anyone who uses it (Florian's) keep every field visible. The legacy path is only
// hidden for a user who has no GitHub setup at all (removal is roadmap S4, after M1).
import type { BlygSettings } from "./schema";

/** Does this setup use GitHub? Yes when any route commits to a repository, or any GitHub setting has been filled in. */
export function githubInUse(s: BlygSettings): boolean {
  return s.routes.some((r) => r.mode !== "studio") || s.github.owner !== "" || s.github.repo !== "" || s.github.tokenSecretName !== "";
}

/** No GitHub anywhere: every route is a Studio route and no GitHub setting is filled in. */
export const isStudioOnly = (s: BlygSettings): boolean => !githubInUse(s);
