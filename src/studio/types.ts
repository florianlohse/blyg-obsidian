// The slice of Blygger Studio's owner API this plugin uses (API contract 5), written by hand against `studio-openapi-0.51.0.json` (the release
// asset of blygger/blygger-studio, MIT). The hand-written shapes below are what the plugin reads; `src/studio/api-types.ts` is the generated,
// types-only mirror of the whole file (S16 plan §5, option (a): no runtime dependency, the SDK calls `fetch` and the plugin may not).
// tests/studio/operations.test.ts validates every request the client builds, and every answer the fake Studio gives, against the file's own
// schemas, so a Studio release that renames a field is caught by updating the file, not by a publish that goes wrong.
import type { StubTarget } from "./stub";

export type StudioItemKind = "fragment" | "thread";

/** `GET /api/items/{id}` and the answers of create and update, reduced to what the plugin reads. */
export interface StudioItem {
  id: string;
  /** Changes with every write to the item; every command (edit, publish, withdraw, delete) must say which revision it acts on. */
  revision: number;
  /** The kind it was written as (contract 5: `kind` is only ever `fragment` or `thread`). */
  kind: StudioItemKind;
  status: "draft" | "public" | "withdrawn";
  /** The newest version number; 0 while it has never been published. */
  version: number;
  /** The working copy (what the editor shows): may be ahead of the published version. */
  contentMd: string;
  /** The working copy differs from the published version. */
  dirty: boolean;
  /** What the item is a reply to (`stubOf`), or null when it is not one (or the shape is not known). */
  stubOf: StubTarget | null;
  /** When the item was made and last changed (ISO text from the Studio); null when the answer did not carry them. */
  created?: string | null;
  updated?: string | null;
  /** The newest published version's document, when there is one (present on GET only). */
  published: { version: number; contentMd: string; contentHtml: string; contentHash: string; note: string | null } | null;
}

/** One row of `GET /api/items` (the owner's list, newest change first): the item plus when it was made, for the import (roadmap S7). */
export interface StudioListedItem extends StudioItem {
  created: string;
}

/** One item of another blyg (or of this Studio) read by its address, without subscribing: `GET /api/peek` (roadmap S9). */
export interface StudioPeek {
  origin: string;
  id: string;
  /** `withdrawn`: the blyg withdrew it; there is nothing to quote. */
  kind: StudioItemKind | "withdrawn";
  version: number;
  contentHtml: string;
  /** Where it reads on its own site. */
  url: string;
  /** The subscription of this Studio that holds this blyg, when there is one: the item may be read and quoted from it. */
  subscriptionId: string | null;
}

/** A subscription of the Studio (`GET /api/subscriptions/{id}`), reduced to what a reply needs: whose blyg it is. */
export interface StudioSubscription {
  id: string;
  kind: "blyg" | "rss";
  origin: string;
  title: string;
}

/** A hopper (`GET /api/hoppers`): a collection of items, the owner's own and ones from blygs they read (roadmap S13). */
export interface StudioHopper {
  id: string;
  name: string;
  slug: string | null;
  public: boolean;
}

/** One problem Studio's preview or a rejected publish names: a directive it could not resolve, a link it could not honour. */
export interface StudioProblem {
  directive?: string;
  reason: string;
}

/** One quote the Studio resolved in a thread's preview: which item and version, the passage (null: the whole item), and where it lives. */
export interface StudioResolvedQuote {
  id: string;
  version: number;
  /** The quoted passage (`selector.exact`), or null for a whole quotation. */
  passage: string | null;
  /** The other blyg's address for a remote item; null for one of this Studio's own. */
  origin: string | null;
}

export interface StudioPreview {
  /** Studio's own rendering of the text: foreign HTML as far as display goes (docs/SECURITY.md §2). */
  html: string;
  problems: StudioProblem[];
  /** What a thread quotes, as the Studio resolved it (empty for a fragment). */
  quotes: StudioResolvedQuote[];
}

/** One row of `GET /api/search`: an item of this Studio (`mine`) or one imported from a blyg the owner reads (`imported`). */
export interface StudioHit {
  id: string;
  kind: StudioItemKind;
  version: number;
  /** The text a `[[id]]` link shows, as the Studio proposes it (its opening heading or a short quoted excerpt). */
  label: string;
  excerpt: string;
  source: "mine" | "imported";
  /** Set for imported items: which subscription holds them (the key to read their text). */
  subscriptionId: string | null;
  /** The subscription's title, for imported items. */
  sourceTitle: string | null;
}

/** `GET /api/imports/{sub}/{id}`, reduced to what quoting needs. */
export interface StudioImported {
  id: string;
  kind: StudioItemKind;
  version: number;
  /** `tombstone`: the origin withdrew it. */
  state: "current" | "tombstone";
  contentHtml: string;
}

export interface StudioManifest {
  /** "blygger-studio/0.51.0" for a stock Studio. */
  generator: string;
  /** The protocol version it announces ("0.4"). */
  protocol: string;
  /** The blyg's own address as the Studio states it (`site`). */
  site: string;
  title: string;
}

/** `GET /api/capabilities`: what the Studio says about its own API. */
export interface StudioCapabilities {
  /** "5.2.0": major.minor.patch of the owner API's contract. */
  contractVersion: string;
}

/** What `publish` and `withdraw` answer: the new version, and the item's new revision (the next command acts on it). */
export interface StudioCommandDone {
  version: number;
  revision: number;
  warning?: string;
}

/** What a media upload answers: the address the Studio gave the file (it holds the file's SHA-256), and the item's new revision when it was attached to one. */
export interface StudioMediaDone {
  id: string;
  url: string;
  mime: string;
  /** The Studio already held these bytes for this item: nothing was added, the revision did not move. */
  duplicate: boolean;
  revision: number | null;
}

export type StudioFailure =
  /** 401: the token is wrong, expired or revoked. */
  | { kind: "unauthorized"; message: string }
  /** 403: the token lacks a scope this operation needs. */
  | { kind: "forbidden"; message: string }
  | { kind: "not-found" }
  /** 409 `revision-conflict`: the item changed in the Studio since the plugin read it (`expectedRevision` is the revision the plugin sent). */
  | { kind: "conflict"; itemId: string; expectedRevision: number }
  /** The Studio speaks another API contract than this plugin (refused before any request, S16 plan §3.2). `message` says what to update. */
  | { kind: "incompatible"; which: "studio-older" | "plugin-older"; message: string }
  /** Another 4xx: Studio refused the content or the state (a cap, a grammar error, a kind that is fixed). `message` is Studio's own words; `code` its error code. */
  | { kind: "rejected"; status: number; message: string; problems: StudioProblem[]; code?: string }
  /** 5xx, 429 after waiting, or an answer the plugin cannot read. */
  | { kind: "error"; status: number; message: string };

export type StudioResult<T> = { kind: "ok"; value: T } | StudioFailure;
