import { routeFor } from "../core/routes";
import type { NoteRef } from "../platform/ports";
import { publishBlyg } from "./blyg";
import { M } from "./messages";
import { publishPlain } from "./plain";
import { publishStudio } from "./studio";
import { refused, type Outcome, type PublishDeps } from "./types";
import { deleteDraftStudio } from "./studioDelete";
import { pullStudio } from "./studioPull";
import { withdrawStudio } from "./studioWithdraw";
import { withdrawBlyg } from "./withdraw";

/** Publish a note by its vault folder: the route decides how. A path that matches no route is refused (fail closed). */
export async function publishNote(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const { routes } = deps.settings;
  const route = routeFor(routes, note.path);
  if (!route) return refused(M.notInRoute(note.path, routes.map((r) => r.vaultPrefix)));
  if (route.mode === "studio") return publishStudio(deps, note);
  if (!deps.github) return refused(deps.githubProblem ?? M.githubNotSetUp);
  return route.mode === "plain" ? publishPlain(deps, note, route) : publishBlyg(deps, note);
}

/** Withdraw a published Blyg note. Only notes in a Blyg route can be withdrawn. */
export async function withdrawNote(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const route = routeFor(deps.settings.routes, note.path);
  if (route?.mode === "studio") return withdrawStudio(deps, note);
  if (!route || route.mode !== "blyg") return refused(M.withdrawNotBlyg(note.path));
  if (!deps.github) return refused(deps.githubProblem ?? M.githubNotSetUp);
  return withdrawBlyg(deps, note);
}

/** Publish a note that carries another blyg's record to the Studio as a new item (docs/plans/S2-studio-client.md §4.6). */
export async function repostNote(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const route = routeFor(deps.settings.routes, note.path);
  if (route?.mode !== "studio") return refused(M.studioRepostNotStudio(note.path));
  return publishStudio(deps, note, { repost: true });
}

/** Take the Studio's working copy of a note's item into the note (roadmap S2.7). Studio routes only. */
export async function pullNote(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const route = routeFor(deps.settings.routes, note.path);
  if (route?.mode !== "studio") return refused(M.studioPullNotStudio(note.path));
  return pullStudio(deps, note);
}

/** Delete a draft (an item never published) in the Studio and take its record off the note. Studio routes only. */
export async function deleteDraftNote(deps: PublishDeps, note: NoteRef): Promise<Outcome> {
  const route = routeFor(deps.settings.routes, note.path);
  if (route?.mode !== "studio") return refused(M.studioDraftNotStudio(note.path));
  return deleteDraftStudio(deps, note);
}
