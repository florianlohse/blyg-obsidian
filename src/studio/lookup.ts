// Finding an item by the address someone pasted (roadmap S9), for "Insert quote", "Insert link" and "Reply to an item": the picker takes a
// web address instead of words. The reading happens at the Studio (`/api/peek/links`, `/api/peek`, the held copy of a blyg you read), so
// the plugin makes no request to any other site. Quoting follows reading (spec §10.2): an item of a blyg this Studio does not read can be
// replied to but not quoted, and the row says so.
import { selectionText } from "../core/textContent";
import { M } from "../publish/messages";
import type { StudioAddress } from "./address";
import type { StudioClient } from "./client";
import { sameOrigin } from "./record";
import type { StudioPick } from "./picker";
import { cleanLabel } from "./text";
import { OWN_SUB, parseItemAddress, type StubTarget } from "./stub";
import type { StudioFailure, StudioItemKind } from "./types";

export type Lookup =
  /** The input is not an address: search for the words. */
  | { kind: "not-an-address" }
  | { kind: "found"; pick: StudioPick }
  | { kind: "problem"; message: string };

/** The first line of the item's text, as a label (an excerpt is already what the Studio shows). */
function labelOf(html: string, fallback: string): string {
  const text = selectionText(html).trim().split(/\n+/)[0] ?? "";
  return cleanLabel(text === "" ? fallback : text);
}

function failureText(what: string, f: StudioFailure): string {
  switch (f.kind) {
    case "unauthorized":
      return `${what}: the Studio rejected the token (expired or revoked).`;
    case "forbidden":
      return `${what}: the token is not allowed to read (it needs owner:read).`;
    case "not-found":
      return `${what}: the Studio has nothing at that address.`;
    default:
      return `${what}: the Studio answered ${f.kind === "rejected" || f.kind === "error" ? f.status : "an error"}${"message" in f && f.message ? ` (${f.message})` : ""}.`;
  }
}

/** One of this Studio's own, published items. */
async function ownItem(client: StudioClient, id: string): Promise<Lookup> {
  const got = await client.getItem(id);
  if (got.kind === "not-found") return { kind: "problem", message: M.lookupNotHere };
  if (got.kind !== "ok") return { kind: "problem", message: failureText("Looking up the item", got) };
  const item = got.value;
  if (item.status === "draft" || item.version === 0) return { kind: "problem", message: M.lookupOwnDraft };
  if (item.status === "withdrawn") return { kind: "problem", message: M.lookupWithdrawn };
  const kind: StudioItemKind = item.kind;
  const html = item.published?.contentHtml ?? "";
  const text = labelOf(html, item.contentMd.split("\n")[0] ?? "");
  return {
    kind: "found",
    pick: { source: "studio", id: item.id, kind, title: text, detail: `In your Studio · ${kind}`, subscriptionId: null, label: text, origin: null, version: item.published?.version ?? item.version },
  };
}

/** An item the Studio holds from a blyg it reads. */
async function heldItem(client: StudioClient, sub: string, id: string): Promise<Lookup> {
  const [imported, subscription] = await Promise.all([client.getImported(sub, id), client.getSubscription(sub)]);
  if (imported.kind === "not-found") return { kind: "problem", message: M.lookupNotHeld };
  if (imported.kind !== "ok") return { kind: "problem", message: failureText("Looking up the item", imported) };
  if (subscription.kind !== "ok") return { kind: "problem", message: failureText("Looking up the blyg", subscription) };
  const i = imported.value;
  const blyg = subscription.value.title || subscription.value.origin;
  const text = labelOf(i.contentHtml, id);
  return {
    kind: "found",
    pick: {
      source: "studio",
      id,
      kind: i.kind,
      title: text,
      detail: `${blyg} · ${i.kind}${i.state === "tombstone" ? " · withdrawn" : ""}`,
      subscriptionId: sub,
      label: cleanLabel(`${blyg}: ${text}`),
      origin: subscription.value.origin,
      version: i.version,
      quotable: i.state !== "tombstone",
    },
  };
}

/** An item of any blyg, read from its own site by the Studio. Quotable only when this Studio also holds a copy. */
async function peeked(client: StudioClient, origin: string, id: string): Promise<Lookup> {
  const got = await client.peekItem(origin, id);
  if (got.kind === "not-found") return { kind: "problem", message: M.lookupNotServed };
  if (got.kind !== "ok") return { kind: "problem", message: failureText("Looking up the item", got) };
  const p = got.value;
  if (p.subscriptionId !== null) {
    const held = await heldItem(client, p.subscriptionId, id);
    // The Studio reads that blyg but has not imported this item (yet): a reply is possible, a quote is not.
    if (held.kind === "found") return held;
    if (held.kind === "problem" && held.message !== M.lookupNotHeld) return held;
  }
  if (p.kind === "withdrawn") return { kind: "problem", message: M.lookupWithdrawn };
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    // keep the text
  }
  const text = labelOf(p.contentHtml, id);
  return {
    kind: "found",
    pick: {
      source: "studio",
      id,
      kind: p.kind,
      title: text,
      detail: `${host} · ${p.kind} · you do not read this blyg`,
      subscriptionId: null,
      label: cleanLabel(`${host}: ${text}`),
      origin: p.origin,
      version: p.version,
      quotable: false,
    },
  };
}

/**
 * What the input is. Not an address → "not-an-address" (the picker searches for the words). An address of this Studio's reader or of an own
 * item is read from the Studio's own data; any other address is first asked of the Studio (`classifyLinks`), then read.
 */
export async function lookupAddress(client: StudioClient, address: StudioAddress, input: string): Promise<Lookup> {
  const parsed = parseItemAddress(input, address);
  if (parsed === null) return { kind: "not-an-address" };
  if (parsed.kind === "reading") return parsed.sub === OWN_SUB ? ownItem(client, parsed.id) : heldItem(client, parsed.sub, parsed.id);
  if (parsed.kind === "own") return ownItem(client, parsed.id);
  const classified = await client.classifyLinks([parsed.url]);
  if (classified.kind !== "ok") return { kind: "problem", message: failureText("Looking up the address", classified) };
  const target = classified.value[0]?.target ?? null;
  if (target === null) return { kind: "problem", message: M.lookupNotAnItem };
  if (sameOrigin(target.origin, address.origin)) return ownItem(client, target.id);
  return peeked(client, target.origin, target.id);
}

/**
 * The reply target for a picked row: the item's blyg (its origin; this Studio's own for the owner's items), its id and the version it is at
 * now. Asks the Studio what it needs and the row does not carry (a search row has no origin; a note of the vault has no current version), and
 * refuses what cannot be answered: an item of yours that is not published.
 */
export async function stubTargetOf(client: StudioClient, address: StudioAddress, pick: StudioPick): Promise<{ ok: true; target: StubTarget } | { ok: false; message: string }> {
  const label = pick.label !== "" ? pick.label : pick.title;
  const own = pick.source === "vault" || (pick.subscriptionId === null && (pick.origin === null || pick.origin === undefined));
  if (own) {
    const got = await client.getItem(pick.id);
    if (got.kind === "not-found") return { ok: false, message: M.lookupNotHere };
    if (got.kind !== "ok") return { ok: false, message: failureText("Looking up the item", got) };
    if (got.value.version === 0 || got.value.status === "draft") return { ok: false, message: M.lookupOwnDraft };
    return { ok: true, target: { origin: address.origin, id: pick.id, version: got.value.published?.version ?? got.value.version, label } };
  }
  if (pick.subscriptionId === null) {
    // Found by its address, from a blyg this Studio does not read: everything is already known.
    if (!pick.origin || !pick.version) return { ok: false, message: M.lookupNotAnItem };
    return { ok: true, target: { origin: pick.origin, id: pick.id, version: pick.version, label } };
  }
  let origin = pick.origin ?? null;
  let version = pick.version ?? null;
  if (origin === null) {
    const sub = await client.getSubscription(pick.subscriptionId);
    if (sub.kind !== "ok") return { ok: false, message: failureText("Looking up the blyg", sub) };
    origin = sub.value.origin;
  }
  if (version === null) {
    const imported = await client.getImported(pick.subscriptionId, pick.id);
    if (imported.kind !== "ok") return { ok: false, message: failureText("Looking up the item", imported) };
    version = imported.value.version;
  }
  return { ok: true, target: { origin, id: pick.id, version, label } };
}
