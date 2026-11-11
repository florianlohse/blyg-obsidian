// Replies (roadmap S10, docs/plans/S10-stubs.md) and finding an item by its address (roadmap S9). Pure.
//
// A stub is a thread that declares itself a response to exactly one target (spec 0.4 §10.6): `stub_of` is `{origin, id, version}` for a blyg
// item (the origin is required even for the publisher's own item) or `{url, cited}` for a plain web page. The note holds it in the property
// `blyg_stub_of`; a `label` there is the plugin's own, for the panel, and is never sent. Checked against a real Studio 0.49.1 (2026-11-02): the
// Studio only accepts a stub on a thread, freezes the citation (source, excerpt, address) itself, accepts a target it does not read and one
// that does not exist, and accepts a changed `stub_of` on a published thread (the next version carries it).
import { sameOrigin } from "./record";
import type { StudioAddress } from "./address";

export const STUB_KEY = "blyg_stub_of";

/** What the Studio's `stub_of` holds, as the plugin reads and sends it. */
export type StubTarget =
  | { origin: string; id: string; version: number; label?: string }
  /** A page of the plain web; `cited` is the Studio's frozen caption, sent back as it came. */
  | { url: string; cited?: Record<string, unknown>; label?: string };

export const isBlygStub = (t: StubTarget): t is Extract<StubTarget, { id: string }> => "id" in t;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const httpUrl = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};
/** An id the Studio can round-trip: no whitespace, no control characters (the Studio's own rule). */
const isItemId = (s: string): boolean => s.length >= 1 && s.length <= 256 && ![...s].some((ch) => ch.trim() === "" || ch.charCodeAt(0) < 32);

/** `stub_of` as the Studio answers it (item JSON): a target, or null when the item is not a reply or the shape is not one the plugin knows. */
export function readWireStub(raw: unknown): StubTarget | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.url === "string" && httpUrl(raw.url)) return { url: raw.url, ...(isRecord(raw.cited) ? { cited: raw.cited } : {}) };
  if (httpUrl(raw.origin) && typeof raw.id === "string" && isItemId(raw.id) && typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version >= 1) {
    return { origin: raw.origin, id: raw.id, version: raw.version };
  }
  return null;
}

/** The note's `blyg_stub_of`: absent is "not a reply"; a property that is not a target is refused with a sentence, never guessed. */
export function readStubProperty(raw: unknown): { ok: true; stub: StubTarget | null } | { ok: false; problem: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, stub: null };
  if (!isRecord(raw)) return { ok: false, problem: "blyg_stub_of must hold origin, id and version (set it with “Reply to an item” or “Make this thread a reply”)" };
  const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label.trim().slice(0, 200) : undefined;
  const wire = readWireStub(raw);
  if (!wire) return { ok: false, problem: "blyg_stub_of needs an origin (an https address), an id and a version of 1 or more" };
  return { ok: true, stub: label ? { ...wire, label } : wire };
}

/** What goes to the Studio: the target without the plugin's label. */
export function stubForWire(t: StubTarget): Record<string, unknown> {
  return isBlygStub(t) ? { origin: t.origin, id: t.id, version: t.version } : { url: t.url, ...(t.cited ? { cited: t.cited } : {}) };
}

/** Two targets are the same reply when they name the same item (origin and id): the version is the Studio's to bake at publish. */
export function sameStubTarget(a: StubTarget | null, b: StubTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (isBlygStub(a) && isBlygStub(b)) return a.id === b.id && sameOrigin(a.origin, b.origin);
  if (!isBlygStub(a) && !isBlygStub(b)) return a.url === b.url;
  return false;
}

/** The property value to write into a note (what `readStubProperty` reads back). */
export function stubProperty(t: StubTarget): Record<string, unknown> {
  return { ...stubForWire(t), ...(t.label ? { label: t.label } : {}) };
}

/** One short line for the window and the panel. */
export function stubLabel(t: StubTarget): string {
  if (t.label) return t.label;
  if (!isBlygStub(t)) return t.url;
  let host = t.origin;
  try {
    host = new URL(t.origin).host;
  } catch {
    // keep the text
  }
  return `${t.id} at ${host}`;
}

// ---- finding an item by the address someone pasted ----------------------------------------------------------------------------

/** What a pasted address means, decided without the network. */
export type ItemAddress =
  /** The Studio's own reader: `{studio}/studio/reading/{subscription}/{id}`; `~own` for one of the owner's items. */
  | { kind: "reading"; sub: string; id: string }
  /** The public page of one of this Studio's own items: `{origin}f/{id}/` or `{origin}t/{id}/`. */
  | { kind: "own"; id: string }
  /** Any other address: the Studio is asked what it is (`POST /api/peek/links`). */
  | { kind: "web"; url: string };

/** The reader's name for the owner's own items. */
export const OWN_SUB = "~own";

/**
 * Is `input` one web address (and nothing else)? Then what is it. Null when it is not an address, so the picker searches for the text.
 * Surrounding `<…>` and quotes are ignored; the query and the fragment are dropped (a link copied from a share sheet carries tracking).
 */
export function parseItemAddress(input: string, studio: StudioAddress | null): ItemAddress | null {
  const text = input.trim().replace(/^[<"'(]+|[>"')]+$/g, "");
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  url.search = "";
  url.hash = "";
  if (studio && url.origin === studio.host) {
    const reading = /\/reading\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    if (reading) return { kind: "reading", sub: safeDecode(reading[1] ?? ""), id: safeDecode(reading[2] ?? "") };
    if (url.href.startsWith(studio.origin)) {
      const own = /^(?:f|t)\/([^/]+)\/?$/.exec(url.href.slice(studio.origin.length));
      if (own) return { kind: "own", id: safeDecode(own[1] ?? "") };
    }
  }
  return { kind: "web", url: url.href };
}

/** Is the text one web address (so the picker will look it up rather than search for words)? Decided before the lookup, to say "Looking up…". */
export const looksLikeAddress = (input: string): boolean => parseItemAddress(input, null) !== null;

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
