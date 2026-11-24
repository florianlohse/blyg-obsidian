// "Blygs I follow" (HK7): what the person does with the Studio's subscriptions, as steps that answer in words. No drawing here: the modal
// (ui/SubscriptionsModal.ts) and the post's "Follow this blyg" row (ui/readerFollow.ts) use the same steps. Every step answers `ok` or a message the
// person can read; a network failure is a message too, never a throw. Follow asks the Studio first and creates only after a second call (`confirm`).
import type { StudioClient } from "../studio/client";
import type { StudioFailure } from "../studio/types";
import type { StudioFollowed, StudioFollowProposal } from "../studio/subscriptions";
import { relativeTime } from "../ui/readerFeed";

export type Step<T> = { ok: true; value: T } | { ok: false; message: string };

export const followText = {
  title: "Sources",
  empty: "You follow no blygs yet. Enter the address of one above.",
  incomplete: "Only the first blygs are listed.",
  /** The line on a post of a blyg the Studio does not read: what Reply then does, and what following changes. */
  unfollowedNote: "Not followed · Reply sends a link without a quote",
  replyTitleUnfollowed: "Reply with a link to this post, without a quote. Follow this blyg to quote it.",
  selectionNotQuoted: "The selected text is not quoted: this blyg is not followed.",
  followingRow: "Following · quotes work once its posts are fetched",
  followButton: "Follow",
  followButtonLabel: "Follow this blyg",
  following: (name: string) => `Following ${name}. The Studio is fetching its posts.`,
  already: "Already followed · press Refresh if its posts are not here yet",
  notAnAddress: "That is not a web address. Paste the address of a blyg, starting with https://",
  emptyName: "A name cannot be empty. Use “Use the blyg’s own name” to go back to the name it gives itself.",
  unreachable: "The Studio could not be reached.",
  gone: "The Studio no longer has this blyg. The list is shown again.",
  siteMismatch: "This address says it belongs to another site. Check that it is the blyg you mean.",
} as const;

/** What the Studio does when a subscription is deleted, in words that hold for every Studio from 0.51.0 on (see UNFOLLOW_EFFECT). */
export function unfollowQuestion(name: string): { title: string; body: string } {
  return {
    title: `Unfollow ${name}?`,
    body: "Your Studio deletes the posts it imported from this blyg, together with your hopper memberships, thumbs and read marks on them (and, on newer Studios, your shelf entries). Your own posts and the notes in your vault are not touched. If you follow the blyg again, its posts are fetched again, but not those memberships and marks.",
  };
}

/** A failure of the Studio, in words. `needs` is the token permission the call used. */
export function followFailure(f: StudioFailure, needs: "owner:read" | "owner:manage"): string {
  switch (f.kind) {
    case "forbidden":
      return needs === "owner:manage"
        ? "Your token cannot follow or change blygs: the token needs owner:manage. Make a new token with every permission."
        : "Your token cannot list the blygs you follow: the token needs owner:read. Make a new token with every permission.";
    case "unauthorized":
      return "The Studio rejected the token (expired or revoked).";
    case "not-found":
      return followText.gone;
    case "incompatible":
      return f.message;
    case "rejected":
      if (f.status === 409) return followText.already;
      return `The Studio refused this${f.message ? `: ${f.message}` : "."}`;
    case "conflict":
      return "The Studio changed this meanwhile. Try again.";
    case "error":
      return `The Studio answered ${f.status}${f.message ? ` (${f.message})` : ""}.`;
  }
}

/** Run one Studio call: a thrown network failure is the same as any other answer, a message. */
async function attempt<T>(call: () => Promise<{ kind: "ok"; value: T } | StudioFailure>, needs: "owner:read" | "owner:manage"): Promise<Step<T>> {
  try {
    const got = await call();
    return got.kind === "ok" ? { ok: true, value: got.value } : { ok: false, message: followFailure(got, needs) };
  } catch {
    return { ok: false, message: followText.unreachable };
  }
}

/** The address as pasted (`<…>` and quotes around it ignored), or null when it is not a web address. */
export function followAddress(input: string): string | null {
  const text = input.trim().replace(/^[<"'(]+|[>"')]+$/g, "");
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  try {
    return new URL(text).href;
  } catch {
    return null;
  }
}

export const loadFollowed = (client: StudioClient): Promise<Step<{ subscriptions: StudioFollowed[]; complete: boolean }>> => attempt(() => client.listSubscriptions(), "owner:read");

/** Ask what following this address would make. Nothing is created. */
export async function proposeFollow(client: StudioClient, input: string): Promise<Step<{ url: string; proposal: StudioFollowProposal }>> {
  const url = followAddress(input);
  if (url === null) return { ok: false, message: followText.notAnAddress };
  const got = await attempt(() => client.createSubscription(url), "owner:manage");
  if (!got.ok) return got;
  if (got.value.state !== "proposal") return { ok: false, message: followText.unreachable }; // a Studio that creates without being asked to confirm: not what the plugin sent
  return { ok: true, value: { url, proposal: got.value.proposal } };
}

/** Create the subscription the person confirmed. `wholeBlyg`: for the address of one public hopper, follow the whole blyg instead. */
export async function confirmFollow(client: StudioClient, url: string, opts: { wholeBlyg?: boolean } = {}): Promise<Step<StudioFollowed>> {
  const got = await attempt(() => client.createSubscription(url, { confirm: true, ...(opts.wholeBlyg ? { wholeBlyg: true } : {}) }), "owner:manage");
  if (!got.ok) return got;
  return got.value.state === "created" ? { ok: true, value: got.value.subscription } : { ok: false, message: followText.unreachable };
}

/** A name of your own for the subscription; `null` gives the name back to the blyg. */
export async function renameFollowed(client: StudioClient, id: string, title: string | null): Promise<Step<StudioFollowed>> {
  const name = title === null ? null : title.trim();
  if (name === "") return { ok: false, message: followText.emptyName };
  return attempt(() => client.updateSubscription(id, { title: name }), "owner:manage");
}

export async function unfollow(client: StudioClient, id: string): Promise<Step<null>> {
  const got = await attempt(() => client.deleteSubscription(id), "owner:manage");
  return got.ok ? { ok: true, value: null } : got;
}

/** What the person sees for a followed blyg: its own name, else its address. */
export const followedName = (s: StudioFollowed): string => s.title.trim() !== "" ? s.title : hostOf(s.origin);

export function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** The Studio's status of a subscription, in a line. */
export function statusLine(s: StudioFollowed, now: number): string {
  const kind = s.hopperFeedUrl !== null ? " · one hopper only" : s.kind === "rss" ? " · feed" : "";
  if (s.status === "paused") return `Paused: the Studio fetches nothing${kind}`;
  if (s.status === "degraded") return `Trouble: ${s.failCount > 0 ? `the last ${s.failCount} fetch${s.failCount === 1 ? "" : "es"} failed` : "fetching is failing"}${kind}`;
  const fetched = relativeTime(s.lastPollAt, now);
  return `Active · ${fetched !== "" ? `fetched ${fetched}` : "not fetched yet"}${kind}`;
}

export type FollowOutcome =
  | { kind: "followed"; title: string }
  | { kind: "already" }
  /** Not a plain blyg (a feed, one hopper, an address that claims another site): the person confirms in "Blygs I follow". */
  | { kind: "modal"; url: string }
  | { kind: "problem"; message: string };

/** "Follow this blyg" on a post: a plain blyg is followed at once (the tap is the consent); anything else is left to the full screen, where it is shown first. */
export async function followBlyg(client: StudioClient, origin: string): Promise<FollowOutcome> {
  const url = followAddress(origin);
  if (url === null) return { kind: "problem", message: followText.notAnAddress };
  const asked = await proposeFollow(client, url);
  if (!asked.ok) return asked.message === followText.already ? { kind: "already" } : { kind: "problem", message: asked.message };
  const { proposal } = asked.value;
  if (proposal.kind !== "blyg" || proposal.siteMismatch) return { kind: "modal", url };
  const made = await confirmFollow(client, url);
  if (!made.ok) return made.message === followText.already ? { kind: "already" } : { kind: "problem", message: made.message };
  return { kind: "followed", title: followedName(made.value) };
}
