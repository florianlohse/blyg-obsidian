// What the side panel says about the active note, as pure functions: no Obsidian, no network. The view only draws this.
//
// Everything here is *this device's* knowledge: the note's own frontmatter (stamped after each successful commit) against
// the text as it is now. It cannot see a commit made from another device; the publish itself always reads the repo first.
import { readStubProperty, STUB_KEY, stubLabel } from "../studio/stub";
import { HOPPERS_KEY, readHopperNames } from "../studio/hoppers";
import type { DeployResult } from "../github/deployStatus";
import { itemPagePath } from "../contract";
import { checkFragmentBody, localKind, type BlygKind } from "../core/blyg";
import { stripObsidianComments } from "../core/comments";
import { stripFrontmatter } from "../core/frontmatter";
import { contentHash } from "../core/hash";
import { isBlygId } from "../core/ids";
import { normalizeContentMd } from "../core/normalize";
import { plainCommitText, plainSyncHash } from "../core/plain";
import { resolvePlainTarget, routeFor } from "../core/routes";
import { leftoverEmbeds, scanThread } from "../core/thread";
import { checkWebAddress, expandWebAddress, siteOrigin } from "../core/webAddress";
import type { BinaryVaultPort, NoteRef, VaultPort } from "../platform/ports";
import { translateNameEmbeds } from "../publish/embeds";
import { problemLinks, shownProblemLinks } from "../publish/shared";
import type { BlygSettings, RouteMode } from "../settings/schema";
import { studioAddress, studioItemUrl } from "../studio/address";
import { sameOrigin, ORIGIN_KEY, SENT_KEY, URL_KEY } from "../studio/record";
import { editedInStudio, type StudioFacts } from "../studio/live";
import { localStudioHash, resolveImages, type DigestCache } from "../studio/media";
import { panelLines, prepareStudioText } from "../studio/text";
import type { PublishedRecord, PublishedStore } from "./publishedStore";
import { githubInUse } from "../settings/studioOnly";
import { activeBranch, activeChannel, toPublishSettings } from "./publishSettings";

/** The note's own `blyg_*` frontmatter as the metadata cache has it. User-editable, so every field is `unknown`. */
export interface LocalBlygFrontmatter {
  id?: unknown;
  version?: unknown;
  created?: unknown;
  updated?: unknown;
  hash?: unknown;
  withdrawn?: unknown;
  channel?: unknown;
  /** `blyg_kind`: "thread", or absent for a fragment. */
  kind?: unknown;
  /** Studio routes: `blyg_origin` (which blyg the id belongs to), `blyg_sent` (hash of the text last sent) and `blyg_url`. */
  origin?: unknown;
  sent?: unknown;
  url?: unknown;
  /** Studio routes: `blyg_hoppers`, the hoppers the note asks for by name (roadmap S13). */
  hoppers?: unknown;
  /** Studio routes: `blyg_stub_of`, what the thread is a reply to (roadmap S10). */
  stubOf?: unknown;
}

/** What a note quotes and links to, counted locally (no network), and whatever already stops it from being published. */
export interface ThreadSummary {
  quotes: number;
  /** How many of the quotes are partial (a passage). */
  passages: number;
  links: number;
  /** Studio threads: how the quotes of other blygs are labelled (`![[id | label]]`), in order. */
  remote?: string[];
  /** Local reasons the publish would be refused (the same checks the service makes first); empty when there are none. */
  problems: string[];
}

/**
 * Count the quotes and item links in a note's text, as the publish service would see them (frontmatter off, comments out). A
 * fragment that quotes is a problem too: only a thread can. An unclosed `%%` comment is reported by its own status instead.
 */
export function summarizeThreadText(rawNote: string, kind: BlygKind): ThreadSummary {
  const stripped = stripObsidianComments(stripFrontmatter(rawNote));
  if (!stripped.ok) return { quotes: 0, passages: 0, links: 0, problems: [] };
  return summarizeContent(normalizeContentMd(stripped.text), kind, []);
}

/** The same for the text a publish would commit (names already turned into ids); `extraProblems` come from that translation. */
export function summarizeContent(contentMd: string, kind: BlygKind, extraProblems: string[], laterProblems: string[] = []): ThreadSummary {
  const scan = scanThread(contentMd);
  if (!scan.ok) return { quotes: 0, passages: 0, links: 0, problems: [...extraProblems, ...scan.problems, ...laterProblems] };
  const first = scan.directives[0];
  return {
    quotes: scan.directives.length,
    passages: scan.directives.filter((d) => d.quoteMd !== null).length,
    links: scan.links.length,
    problems: [
      ...extraProblems,
      ...leftoverEmbeds(contentMd, scan.directives).map((p) => `${p}: an embed the site cannot show (it would break the deploy)`),
      ...(kind === "fragment" && first ? [`line ${first.line} quotes another item, which only a thread can do (add the property blyg_kind: thread before the first publish)`] : []),
      ...laterProblems,
    ],
  };
}

/**
 * The other checks a publish makes before it writes anything, that need no network, said in the panel before the user taps Publish: an
 * empty note, a fragment over its limit, links the site cannot honour (when the setting is "block"). Same functions as the publish, so the
 * two cannot disagree. Each is one readable line.
 */
export function localPublishProblems(
  contentMd: string,
  kind: BlygKind,
  ctx: { settings: BlygSettings; vault: VaultPort; note: NoteRef },
): string[] {
  const out: string[] = [];
  if (contentMd === "") out.push("The note is empty: write something first.");
  else if (kind === "fragment") {
    const check = checkFragmentBody(contentMd, ctx.settings.blyg.fragmentCharCap);
    if (!check.ok && check.reason === "too-long") {
      out.push(`Too long for a fragment: ${check.length} characters, the limit is ${check.cap}. Shorten it, or make it a thread.`);
    }
  }
  if (ctx.settings.safety.outsideLinks === "block") {
    const bad = problemLinks({ vault: ctx.vault, settings: toPublishSettings(ctx.settings) }, ctx.note, contentMd);
    if (bad.length > 0) out.push(`Links the site cannot honour: ${shownProblemLinks(bad).join(", ")}. Fix or remove them.`);
  }
  return out;
}

/**
 * The text a publish of this note would commit as `content_md`: frontmatter off, `%%` comments out, normalised, and note names of
 * published Blyg notes turned into ids (publish/embeds.ts). `ok: false` for an unclosed comment. `embedProblems` are what the
 * translation would refuse (a quoted note that is not published yet, …); the text is then the untranslated one.
 */
export function publishedTextOf(
  rawNote: string,
  ctx: { vault: VaultPort; routes: BlygSettings["routes"]; fromPath: string },
): { ok: true; contentMd: string; embedProblems: string[] } | { ok: false } {
  const stripped = stripObsidianComments(stripFrontmatter(rawNote));
  if (!stripped.ok) return { ok: false };
  const normalized = normalizeContentMd(stripped.text);
  const translated = translateNameEmbeds(normalized, ctx);
  return translated.problems.length > 0
    ? { ok: true, contentMd: normalized, embedProblems: translated.problems }
    : { ok: true, contentMd: translated.text, embedProblems: [] };
}

/**
 * The hash a publish would compute for this text right now (comments stripped, frontmatter off, normalised), or null when
 * the text cannot be published as it is (an unclosed `%%`). Same steps as `publishBlyg` (before the names of quoted notes are
 * turned into ids: see `publishedTextOf`), so equal means "nothing to commit".
 */
export async function localContentHash(rawNote: string): Promise<string | null> {
  const stripped = stripObsidianComments(stripFrontmatter(rawNote));
  if (!stripped.ok) return null;
  return contentHash(normalizeContentMd(stripped.text));
}


/**
 * What a Studio publish of this text would find locally, said in the panel before the user taps Publish: the same function the publish
 * calls (`prepareStudioText`), so the two cannot disagree. `contentMd` is the note's body as a publish takes it (comments out, normalised).
 */
export function studioTextSummary(contentMd: string, kind: BlygKind, ctx: { settings: BlygSettings; vault: VaultPort; note: NoteRef }): ThreadSummary & { contentMd: string } {
  const address = studioAddress(ctx.settings.studio);
  if (!address) return { quotes: 0, passages: 0, links: 0, problems: [], contentMd };
  const draft = prepareStudioText(contentMd, kind, {
    vault: ctx.vault,
    routes: ctx.settings.routes,
    fromPath: ctx.note.path,
    origin: address.origin,
    fragmentCharCap: ctx.settings.blyg.fragmentCharCap,
  });
  return {
    quotes: draft.quotes.length,
    passages: draft.quotes.filter((q) => q.quoteMd !== null).length,
    links: draft.links,
    remote: draft.quotes.flatMap((q) => (q.label === null ? [] : [q.label])),
    problems: panelLines(draft.problems),
    contentMd: draft.contentMd,
  };
}

export type PanelStatus =
  | "no-note"
  | "not-markdown"
  | "no-route"
  | "plain-unknown"
  | "plain-in-sync"
  | "plain-changed"
  | "plain-unusable"
  | "production-note"
  | "invalid-id"
  | "invalid-kind"
  | "thread-unreadable"
  | "not-published"
  /** A Studio item that was never published: a draft only the owner sees (blyg_version 0). */
  | "draft"
  | "in-sync"
  | "local-changes"
  | "withdrawn"
  | "unreadable-text"
  | "preview-note"
  | "studio-missing"
  /** The Studio answered that it has no item with the note's id. */
  | "studio-item-missing"
  /** Published, and the Studio's working copy was changed in the Studio since the note last sent it. */
  | "edited-there"
  | "other-blyg";

export interface PanelState {
  status: PanelStatus;
  /** One short sentence: the state in words. */
  headline: string;
  /** One short line saying what to do next (more only when two things apply at once). */
  notes: string[];
  /** One line about a missing setting that keeps the link away (e.g. no web address); shown under the facts. */
  hint?: string;
  note: { name: string; path: string } | null;
  route: { label: string; mode: RouteMode } | null;
  channel: "production" | "preview";
  branch: string;
  /** Blyg items only. */
  item?: { id: string; version: number | null; created: string | null; updated: string | null };
  /** Blyg notes: what the note declares itself to be. */
  kind?: BlygKind;
  /** Threads: what the note quotes and links to (counted from its text on this device). */
  thread?: { quotes: number; passages: number; links: number; remote?: string[] };
  /** Plain routes: where the file goes in the repo. */
  repoPath?: string;
  /** The repo path a publish of this note writes (Blyg item file or plain file): the deploy box belongs to the note that owns it. */
  deployPath?: string;
  /** Plain routes: when the plugin last saw the branch hold this file's text (its own record, see publishedStore.ts). */
  published?: { at: string };
  /** The item's permalink on the site for the current target, when the settings give an address for it. */
  webUrl?: string;
  /** Everything is as it should be (published and unchanged): the panel shows a green check. */
  ok: boolean;
  /** What the main button says: "Publish", "Update" once the note has been published, "Publish again" after a withdrawal. */
  publishLabel: "Publish" | "Update" | "Publish again" | "Send draft";
  /** The main button is the call to action (there is something to send); false when it would only say "No changes". */
  emphasizePublish: boolean;
  /** Studio notes: what the Studio itself reported (mentions, warnings, whether it could be reached). Absent for other routes. */
  studio?: { mentions?: { count: number; complete: boolean }; warnings: string[]; /** Muted transparency lines (a newer minor contract): not warnings, not counted. */ notes?: string[]; unreachable?: boolean };
  /** Studio notes that are replies (roadmap S10): what they answer, and what is wrong with it, if anything. */
  stub?: { label: string; problem: string | null };
  /**
   * Studio notes (roadmap S13): the hoppers the note asks for (null: the property cannot be read), what the Studio holds for its item (null:
   * not known), and whether the two differ. Changing hoppers needs no published item; "Use the Studio's hoppers" does.
   */
  hoppers?: { note: string[] | null; studio: string[] | null; differ: boolean; canTake: boolean };
  /** Which buttons make sense. Publish and withdraw still ask the services, which refuse whatever must be refused. */
  canPublish: boolean;
  canWithdraw: boolean;
  canOpenWeb: boolean;
  /** A note in a Studio folder that carries another blyg's record (the old GitHub one): "Repost to Studio" publishes it as a new item. */
  showRepost: boolean;
  canRepost: boolean;
  /** A published Studio note whose text differs from the Studio's working copy: "Use the Studio's copy" brings that text into the note (S2.7). */
  showPull: boolean;
  canPull: boolean;
  /** A Studio note in a "Drafts only" folder: it is only ever sent as a draft, never published or withdrawn from there. */
  draftsOnly: boolean;
  /** A Studio note whose item was never published: "Delete draft" removes the draft from the Studio. */
  showDelete: boolean;
  canDelete: boolean;
  /**
   * Whether the buttons are drawn at all. Withdrawing is a Blyg-item operation (an endcap, spec §9): it does not exist for
   * essays and pages. "Open on web" is drawn for Blyg items only until plain routes have a web address (not built yet).
   */
  showWithdraw: boolean;
  showOpenWeb: boolean;
  /**
   * The writing buttons. New thread / New note need only a Blyg folder in the settings; the others act on the open Blyg note and are
   * grayed out when none is open: Quote in thread (a new thread that quotes it), Continue thread (a thread is open), Insert quote
   * (into the open thread), Insert link (into the open Blyg note).
   */
  write: { /** A Studio is set up: "Reply to an item" is drawn (roadmap S10). */ canReply: boolean; /** The open note is an unpublished Studio thread: "Make this thread a reply". */ canMakeReply: boolean; canCreate: boolean; canQuoteInThread: boolean; canContinue: boolean; canMakeThread: boolean; canInsertQuote: boolean; canInsertLink: boolean; /** A Studio is set up and a folder publishes to it: "Import from Studio" is drawn (roadmap S7). */ canImport: boolean };
}

export interface PanelInput {
  settings: BlygSettings;
  note: NoteRef | null;
  frontmatter: LocalBlygFrontmatter;
  /** Blyg: from `localContentHash`. Plain: from `localPlainHash`. Null when the text cannot be published as it is (see there). */
  localHash: string | null;
  /** Plain routes: what the plugin last saw on the active branch for this file, or null/undefined when it has no record. */
  plainRecord?: PublishedRecord | null;
  /** Blyg notes: from `summarizeThreadText`. */
  thread?: ThreadSummary;
  /** Studio notes: what the Studio last said (a cached answer, never fetched here) and the warnings that hold for the whole Studio. */
  studio?: { facts?: StudioFacts; warnings: string[]; notes?: string[] };
}

/** A timestamp as ISO text: Obsidian's YAML parser may hand back a string or a Date (see core/blyg.ts). */
function timestampOf(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (Object.prototype.toString.call(value) === "[object Date]" && !Number.isNaN((value as Date).getTime())) {
    return (value as Date).toISOString();
  }
  return null;
}

const versionOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** The permalink under the blyg's address for the active target: `/f/{id}/` for a fragment, `/t/{id}/` for a thread (contract §4); undefined without an address. */
export function itemUrl(settings: BlygSettings, id: string, kind: BlygKind = "fragment"): string | undefined {
  const origin = activeChannel(settings) === "preview" ? settings.blyg.previewOrigin : settings.blyg.origin;
  if (origin === "") return undefined;
  return `${origin.endsWith("/") ? origin : `${origin}/`}${itemPagePath(kind, id)}`;
}

/** The fingerprint of what a plain-route publish would commit for this text now, or null for an unclosed `%%` comment. */
export async function localPlainHash(rawNote: string): Promise<string | null> {
  const commit = plainCommitText(rawNote);
  return commit.ok ? plainSyncHash(commit.text) : null;
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The state of the panel for one note: what is true, what to say, which buttons to draw. */
export function computePanelState(input: PanelInput): PanelState {
  const core = computeCore(input);
  const route = routeFor(input.settings.routes, input.note?.path ?? "");
  const blygRoute = core.route?.mode === "blyg";
  const draftsOnly = route?.mode === "studio" && route.draftsOnly === true;
  // The writing buttons work the same in a Blyg (GitHub) folder and in a Studio folder.
  const openBlyg = (blygRoute || core.route?.mode === "studio") && input.note?.extension === "md";
  const openThread = openBlyg && core.kind === "thread";
  return {
    ...core,
    ...(core.status === "other-blyg" && !githubInUse(input.settings) ? { notes: ["This item belongs to another blyg, not to the Studio set up now. Publishing it here is not offered."] } : {}),
    ...publishButton(core.status),
    ...(draftsOnly ? { publishLabel: "Send draft" as const, canWithdraw: false } : {}),
    draftsOnly,
    showDelete: core.status === "draft",
    canDelete: core.status === "draft",
    ok: core.status === "in-sync" || core.status === "plain-in-sync",
    showWithdraw: (blygRoute || core.route?.mode === "studio") && !draftsOnly,
    ...(core.route?.mode === "studio" && input.studio ? { studio: studioInfo(input.studio) } : {}),
    ...(core.route?.mode === "studio" && input.note?.extension === "md" ? { hoppers: hopperInfo(input) } : {}),
    ...(core.route?.mode === "studio" && input.note?.extension === "md" ? stubInfo(input.frontmatter.stubOf, core.kind) : {}),
    // Repost is a corner case of the older GitHub way: offered only to a setup that uses GitHub (settings/studioOnly.ts). Hidden, not removed.
    showRepost: core.status === "other-blyg" && githubInUse(input.settings),
    canRepost: core.status === "other-blyg" && githubInUse(input.settings) && input.localHash !== null,
    showPull: core.status === "edited-there" || (core.route?.mode === "studio" && core.status === "local-changes"),
    canPull: core.status === "edited-there" || (core.route?.mode === "studio" && core.status === "local-changes"),
    showOpenWeb: blygRoute || route?.mode === "studio" || Boolean(route?.webUrl?.trim()),
    write: {
      canCreate: input.settings.routes.some((r) => (r.mode === "blyg" || r.mode === "studio") && r.vaultPrefix !== ""),
      canQuoteInThread: openBlyg,
      canContinue: openThread,
      // Only a fragment that has never been published can become a thread: the kind of a published item never changes.
      canMakeThread: openBlyg && core.kind === "fragment" && core.item === undefined,
      canInsertQuote: openThread,
      canInsertLink: openBlyg,
      canReply: input.settings.studio.baseUrl !== "" && input.settings.routes.some((r) => r.mode === "studio"),
      canMakeReply: core.route?.mode === "studio" && input.note?.extension === "md" && core.kind === "thread" && !(typeof core.item?.version === "number" && core.item.version > 0),
      canImport: input.settings.studio.baseUrl !== "" && input.settings.routes.some((r) => r.mode === "studio"),
    },
  };
}

function stubInfo(raw: unknown, kind: BlygKind | undefined): { stub: NonNullable<PanelState["stub"]> } | Record<string, never> {
  const read = readStubProperty(raw);
  if (!read.ok) return { stub: { label: "(not readable)", problem: `${read.problem}.` } };
  if (read.stub === null) return {};
  return { stub: { label: stubLabel(read.stub), problem: kind === "thread" ? null : "Only a thread can be a reply: make the note a thread, or remove blyg_stub_of." } };
}

function hopperInfo(input: PanelInput): NonNullable<PanelState["hoppers"]> {
  const read = readHopperNames(input.frontmatter.hoppers);
  const note = read.ok ? read.names : null;
  const facts = input.studio?.facts;
  const studio = facts && typeof facts.item !== "string" && Array.isArray(facts.hoppers) ? facts.hoppers : null;
  const fold = (names: string[]): string => names.map((n) => n.toLowerCase()).sort().join("\n");
  const differ = note !== null && studio !== null && fold(note) !== fold(studio);
  return { note, studio, differ, canTake: studio !== null };
}

function studioInfo(studio: NonNullable<PanelInput["studio"]>): NonNullable<PanelState["studio"]> {
  const facts = studio.facts;
  return {
    warnings: studio.warnings,
    ...(studio.notes && studio.notes.length > 0 ? { notes: studio.notes } : {}),
    ...(facts?.mentions ? { mentions: facts.mentions } : {}),
    ...(facts?.item === "unreachable" ? { unreachable: true } : {}),
  };
}

type CoreState = Omit<PanelState, "ok" | "publishLabel" | "emphasizePublish" | "showWithdraw" | "showOpenWeb" | "showRepost" | "canRepost" | "showPull" | "canPull" | "draftsOnly" | "showDelete" | "canDelete" | "write">;

/** The main button's wording follows the state: once something has been published, the button updates it. */
function publishButton(status: PanelStatus): Pick<PanelState, "publishLabel" | "emphasizePublish"> {
  switch (status) {
    case "in-sync":
    case "plain-in-sync":
      return { publishLabel: "Update", emphasizePublish: false };
    case "local-changes":
    case "plain-changed":
    case "edited-there":
      return { publishLabel: "Update", emphasizePublish: true };
    case "production-note":
      return { publishLabel: "Update", emphasizePublish: false };
    case "withdrawn":
      return { publishLabel: "Publish again", emphasizePublish: true };
    case "draft":
      return { publishLabel: "Publish", emphasizePublish: true };
    default:
      return { publishLabel: "Publish", emphasizePublish: true };
  }
}

function computeCore(input: PanelInput): CoreState {
  const { settings, note, frontmatter: fm } = input;
  const channel = activeChannel(settings);
  const branch = activeBranch(settings);
  const base = { channel, branch, canPublish: false, canWithdraw: false, canOpenWeb: false };

  if (!note) {
    return { ...base, status: "no-note", headline: "No note is open.", notes: ["Open a note from one of your publish folders."], note: null, route: null };
  }
  const noteInfo = { name: note.name, path: note.path };

  const route = routeFor(settings.routes, note.path);
  if (!route) {
    const folders = settings.routes.map((r) => r.vaultPrefix).filter((p) => p !== "");
    return {
      ...base,
      status: "no-route",
      headline: "Not in a publish folder.",
      notes: [folders.length > 0 ? `Only notes in your publish folders can be published: ${folders.join(", ")}` : "No publish folders are set up yet (Settings → Blyg → Routes)."],
      note: noteInfo,
      route: null,
    };
  }
  const routeInfo = { label: route.label, mode: route.mode };

  if (note.extension !== "md") {
    return { ...base, status: "not-markdown", headline: "Not a Markdown note.", notes: ["Only .md notes are published."], note: noteInfo, route: routeInfo };
  }

  if (route.mode === "plain") {
    const target = resolvePlainTarget(route, note, settings.blyg.itemsDir);
    if (!target.ok) {
      return {
        ...base,
        status: "plain-unusable",
        headline: "This note cannot be published here.",
        notes: [
          target.reason === "no-destination"
            ? "This route has no destination folder in the repository (Settings → Blyg → Routes)."
            : target.reason === "unusable-path"
              ? "The note's path has an empty or relative part."
              : "Its path leads into the Blyg folder, which essays and pages never write to.",
        ],
        note: noteInfo,
        route: routeInfo,
      };
    }
    const common = { note: noteInfo, route: routeInfo, repoPath: target.destPath, deployPath: target.destPath };
    // In test mode every statement is about the preview branch; say so, so the box does not seem to change for no reason.
    const on = channel === "preview" ? " on preview" : "";
    // "Open on web" exists for a plain route only when its web address is set (the plugin cannot guess a site's URLs).
    const template = route.webUrl?.trim() ?? "";
    const channelOrigin = channel === "preview" ? settings.blyg.previewOrigin : settings.blyg.origin;
    const stem = (n: string): string => n.replace(/\.md$/i, "");
    const url = template
      ? expandWebAddress(template, { site: siteOrigin(channelOrigin), name: stem(note.name), path: stem(target.rel) })
      : undefined;
    const web = url ? { webUrl: url, canOpenWeb: true } : {};
    // Why there is no link: say so in one line instead of leaving the user to guess.
    const hint = url
      ? undefined
      : template === ""
        ? "To get a link, set a “Web address” for this route in Settings → Blyg."
        : checkWebAddress(template) !== null
          ? "The web address of this route (Settings → Blyg) is not valid, so there is no link."
          : `To get a link, set the ${channel === "preview" ? "preview " : ""}Blyg address in Settings → Blyg: this route's web address uses it.`;

    if (input.localHash === null) {
      return {
        ...base,
        ...common,
        status: "unreadable-text",
        headline: "Can't be published yet.",
        notes: ["A %% comment is never closed, so the rest of the note might be private. Close it first."],
        ...(hint ? { hint } : {}),
      };
    }
    const record = input.plainRecord ?? null;
    if (record === null) {
      return {
        ...base,
        ...common,
        ...web,
        ...(hint ? { hint } : {}),
        status: "plain-unknown",
        headline: `${capitalise(route.label)}: not checked${on} yet.`,
        notes: ["Tap Publish to compare it with the site; nothing is written if it is already there."],
        canPublish: true,
      };
    }
    const inSync = record.hash === input.localHash;
    return {
      ...base,
      ...common,
      ...web,
      published: { at: record.at },
      status: inSync ? "plain-in-sync" : "plain-changed",
      ...(hint ? { hint } : {}),
      headline: inSync ? `${capitalise(route.label)}: published${on} and up to date.` : `${capitalise(route.label)}: changed since it was published${on}.`,
      notes: [inSync ? "Edit it, then tap Update to send the changes." : "Tap Update to review the changes before they go out."],
      canPublish: true,
    };
  }

  if (route.mode === "studio") return studioCore(input, { note: noteInfo, route: routeInfo, base });

  // Blyg route.
  const declared = localKind(fm.kind);
  const kind: BlygKind = "kind" in declared ? declared.kind : "fragment";
  const summary = input.thread;
  const common = {
    note: noteInfo,
    route: routeInfo,
    kind,
    ...(kind === "thread" && summary ? { thread: { quotes: summary.quotes, passages: summary.passages, links: summary.links } } : {}),
  };
  const rawId = fm.id;
  const hasId = rawId !== undefined && rawId !== null && rawId !== "" && rawId !== false;
  const notes: string[] = [];
  const problems = summary?.problems ?? [];

  if ("invalid" in declared) {
    return {
      ...base,
      ...common,
      status: "invalid-kind",
      headline: "The blyg_kind in this note is not valid.",
      notes: ["Use “thread”, or remove the property for a fragment; publishing is refused until then."],
    };
  }

  // The marker keeps notes from the test channel off production (publishBlyg refuses them before any network call).
  if (fm.channel === "preview" && channel === "production") {
    return {
      ...base,
      ...common,
      status: "preview-note",
      headline: "A test note (preview only).",
      notes: ["It can't go to production. Use “Toggle production/preview” to work on it."],
      ...(isBlygId(rawId)
        ? {
            item: { id: rawId, version: versionOf(fm.version), created: timestampOf(fm.created), updated: timestampOf(fm.updated) },
            deployPath: `${settings.blyg.itemsDir}/${rawId}.md`,
          }
        : {}),
    };
  }

  if (!hasId && problems.length > 0) {
    return { ...base, ...common, status: "thread-unreadable", headline: "Can't be published yet.", notes: problems.slice(0, 2) };
  }
  if (!hasId) {
    return {
      ...base,
      ...common,
      status: "not-published",
      headline: "Not published yet.",
      notes: ["Tap Publish to send it as version 1."],
      canPublish: true,
    };
  }
  if (!isBlygId(rawId)) {
    return {
      ...base,
      ...common,
      status: "invalid-id",
      headline: "The blyg_id in this note is not valid.",
      notes: ["Fix or remove it in the note's properties; publishing is refused until then."],
    };
  }

  const item = { id: rawId, version: versionOf(fm.version), created: timestampOf(fm.created), updated: timestampOf(fm.updated) };
  const deployPath = `${settings.blyg.itemsDir}/${rawId}.md`;
  const on = channel === "preview" ? " on preview" : "";
  const webUrl = itemUrl(settings, rawId, kind);
  const web = webUrl ? { webUrl, canOpenWeb: true } : {};
  const hint = webUrl ? {} : { hint: `To get a link, set the ${channel === "preview" ? "preview " : ""}Blyg address in Settings → Blyg.` };
  const withVersion = item.version !== null ? ` (v${item.version})` : "";

  if (fm.withdrawn === true) {
    return {
      ...base,
      ...common,
      item,
      deployPath,
      ...web,
      ...hint,
      status: "withdrawn",
      headline: `Withdrawn${on}${withVersion}.`,
      notes: [...notes, `Its address stays up as “withdrawn”. Tap Publish again to bring it back${item.version !== null ? ` as v${item.version + 1}` : ""}.`],
      canPublish: true,
    };
  }

  if (input.localHash === null) {
    return {
      ...base,
      ...common,
      item,
      deployPath,
      ...web,
      ...hint,
      status: "unreadable-text",
      headline: "Can't be published yet.",
      notes: [...notes, "A %% comment is never closed, so the rest of the note might be private. Close it first."],
      canWithdraw: true,
    };
  }

  if (problems.length > 0) {
    return { ...base, ...common, item, deployPath, ...web, ...hint, status: "thread-unreadable", headline: "Can't be published yet.", notes: problems.slice(0, 2), canWithdraw: true };
  }

  // Target preview, but the note's stamp is from production: its hash says nothing about the preview branch.
  if (channel === "preview" && fm.channel !== "preview") {
    return {
      ...base,
      ...common,
      item,
      deployPath,
      ...web,
      ...hint,
      status: "production-note",
      headline: `Published on production${withVersion}.`,
      notes: ["Publishing to preview only works if that branch already has this item."],
      canPublish: true,
      canWithdraw: true,
    };
  }

  const inSync = typeof fm.hash === "string" && fm.hash === input.localHash;
  return {
    ...base,
    ...common,
    item,
    deployPath,
    ...web,
    ...hint,
    status: inSync ? "in-sync" : "local-changes",
    headline: inSync ? `Published${on}${withVersion} and up to date.` : `Published${on}${withVersion}, with changes not sent yet.`,
    notes: [...notes, inSync ? "Edit the note, then tap Update to send the changes." : "Tap Update to review the changes before they go out."],
    canPublish: true,
    canWithdraw: true,
  };
}


/**
 * The panel for a note in a Studio route, from the note's own record only (no network): published and up to date, changed since, or
 * not published; or why the plugin will not publish it. What the Studio itself holds (edited there? withdrawn there?) comes in the
 * next increment; the publish asks the Studio anyway and refuses what must be refused.
 */
function studioCore(
  input: PanelInput,
  ctx: { note: { name: string; path: string }; route: { label: string; mode: RouteMode }; base: Pick<PanelState, "channel" | "branch" | "canPublish" | "canWithdraw" | "canOpenWeb"> },
): CoreState {
  const { settings, frontmatter: fm } = input;
  const { note, route, base } = ctx;
  const address = studioAddress(settings.studio);
  const draftsOnly = routeFor(settings.routes, note.path)?.draftsOnly === true;
  const declared = localKind(fm.kind);
  const kind: BlygKind = "kind" in declared ? declared.kind : "fragment";
  const summary = input.thread;
  const common = {
    note,
    route,
    kind,
    ...(kind === "thread" && summary ? { thread: { quotes: summary.quotes, passages: summary.passages, links: summary.links, ...(summary.remote && summary.remote.length > 0 ? { remote: summary.remote } : {}) } } : {}),
  };

  if ("invalid" in declared) {
    return { ...base, ...common, status: "invalid-kind", headline: "The blyg_kind in this note is not valid.", notes: ["Use “thread”, or remove the property for a fragment; publishing is refused until then."] };
  }
  if (!address) {
    return { ...base, ...common, status: "studio-missing", headline: "No Studio is set up.", notes: ["Enter the Studio's address and token in Settings → Blyg → Studio."] };
  }
  const rawId = fm.id;
  const hasId = rawId !== undefined && rawId !== null && rawId !== "" && rawId !== false;
  const origin = typeof fm.origin === "string" && fm.origin.trim() !== "" ? fm.origin : null;
  const problems = input.thread?.problems ?? [];

  if (!hasId && origin === null) {
    if (input.localHash === null) {
      return { ...base, ...common, status: "unreadable-text", headline: "Can't be published yet.", notes: ["A %% comment is never closed, so the rest of the note might be private. Close it first."] };
    }
    if (problems.length > 0) return { ...base, ...common, status: "thread-unreadable", headline: "Can't be published yet.", notes: problems.slice(0, 2) };
    return draftsOnly
      ? { ...base, ...common, status: "not-published", headline: "Not sent yet.", notes: ["Tap Send draft to see the Studio's preview and send it as a draft. Nothing goes live from this folder."], canPublish: true }
      : { ...base, ...common, status: "not-published", headline: "Not published yet.", notes: ["Tap Publish to see the Studio's preview and send it as version 1."], canPublish: true };
  }
  if (!isBlygId(rawId)) {
    return { ...base, ...common, status: "invalid-id", headline: "The blyg_id in this note is not valid.", notes: ["Fix or remove it in the note's properties; publishing is refused until then."] };
  }
  if (origin === null || !sameOrigin(origin, address.origin)) {
    return {
      ...base,
      ...common,
      status: "other-blyg",
      headline: origin === null ? "Published on your site's old blyg, not in the Studio." : "Published in another blyg.",
      notes: [
        origin === null
          ? "Tap “Repost to Studio” to publish its text as a new item here. The old item stays where it is."
          : `It belongs to ${origin}, not to the Studio set up now. Tap “Repost to Studio” to publish its text here as a new item.`,
      ],
    };
  }

  // A Studio note carries no dates of its own (it is not stamped with blyg_created/blyg_updated): they come from what the Studio last said.
  const known = input.studio?.facts?.item;
  const dates = known && typeof known !== "string" ? { created: known.created ?? null, updated: known.updated ?? null } : { created: null, updated: null };
  const item = { id: rawId, version: versionOf(fm.version), ...dates };
  const stampedUrl = typeof fm.url === "string" && fm.url.startsWith(address.origin) ? fm.url : studioItemUrl(address, kind, rawId);
  const web = { webUrl: stampedUrl, canOpenWeb: true };
  const withVersion = item.version !== null ? ` (v${item.version})` : "";

  const facts = input.studio?.facts;
  if (facts?.item === "missing") {
    return {
      ...base, ...common, item, ...web,
      status: "studio-item-missing",
      headline: "The Studio has no such item.",
      notes: ["It may have been deleted there, or this note belongs to a different Studio. Publishing is refused until the note’s properties are fixed."],
      canOpenWeb: false,
    };
  }
  if (facts && typeof facts.item !== "string" && facts.item.status === "withdrawn" && fm.withdrawn !== true) {
    return {
      ...base, ...common, item: { ...item, version: facts.item.version }, ...web,
      status: "withdrawn",
      headline: `Withdrawn in the Studio (v${facts.item.version}).`,
      notes: ["It was withdrawn there, not from this note. Tap Publish again to bring it back as the next version."],
      canPublish: true,
    };
  }

  if (fm.withdrawn === true) {
    return {
      ...base, ...common, item, ...web,
      status: "withdrawn",
      headline: `Withdrawn${withVersion}.`,
      notes: [`Its address stays up as “withdrawn”. Tap Publish again to bring it back${item.version !== null ? ` as v${item.version + 1}` : ""}.`],
      canPublish: true,
    };
  }
  if (input.localHash === null) {
    return { ...base, ...common, item, ...web, status: "unreadable-text", headline: "Can't be published yet.", notes: ["A %% comment is never closed, so the rest of the note might be private. Close it first."], canWithdraw: true };
  }
  if (problems.length > 0) return { ...base, ...common, item, ...web, status: "thread-unreadable", headline: "Can't be published yet.", notes: problems.slice(0, 2), canWithdraw: true };

  const inSync = typeof fm.sent === "string" && fm.sent === input.localHash;
  // Never published: a draft. It has no public address, so no web link; the notes say how it goes live.
  if (item.version === 0) {
    return {
      ...base, ...common, item,
      status: "draft",
      headline: inSync ? "Draft in the Studio (not published)." : "Draft in the Studio, with changes not sent yet.",
      notes: [
        draftsOnly
          ? inSync
            ? "Publish it in the Studio, or move the note to a normal Studio folder and tap Publish. “Delete draft” removes it."
            : "Tap Send draft to update it. Nothing goes live from this folder."
          : inSync
            ? "Tap Publish to make it version 1. “Delete draft” removes it from the Studio."
            : "Tap Publish to see the Studio's preview before it goes out.",
      ],
      canPublish: true,
    };
  }
  if (facts && editedInStudio(facts, { sent: typeof fm.sent === "string" ? fm.sent : null, localHash: input.localHash })) {
    return {
      ...base, ...common, item, ...web,
      status: "edited-there",
      headline: `Published${withVersion}; its working copy in the Studio was changed there.`,
      notes: ["Update sends this note to the Studio and replaces the online copy; “Replace this note with the online text” does the opposite. Both show the two texts first and ask; nothing is overwritten unless you agree."],
      canPublish: true,
      canWithdraw: true,
    };
  }
  return {
    ...base, ...common, item, ...web,
    status: inSync ? "in-sync" : "local-changes",
    headline: inSync ? `Published${withVersion} and up to date.` : `Published${withVersion}, with changes not sent yet.`,
    notes: [
      draftsOnly
        ? inSync
          ? "In this folder only drafts are sent: nothing goes live from here."
          : "Tap Send draft to update the working copy in the Studio; the published version stays as it is."
        : inSync
          ? "Edit the note, then tap Update to send the changes."
          : "Tap Update to see the Studio's preview before it goes out.",
    ],
    canPublish: true,
    canWithdraw: true,
  };
}

/** What the panel shows about the newest commit of this session: waiting for its checks, or the verdict. */
export type PanelDeploy =
  | { phase: "watching"; branch: string; version?: number; path?: string }
  | { phase: "done"; branch: string; version?: number; path?: string; kind: DeployResult["kind"]; text: string; attention: boolean; at: Date };

export interface DeployLine {
  /** Short, for the line itself. */
  headline: string;
  /** The full sentence(s) the notice used to carry; shown under the headline when it needs attention. */
  detail: string | null;
  attention: boolean;
}

const HEADLINES: Record<DeployResult["kind"], string> = {
  deployed: "Deployed",
  failed: "Checks failed ✗ — nothing went live",
  replaced: "Not deployed — a newer publish replaced this one",
  superseded: "Cancelled — probably replaced by a newer deploy",
  skipped: "Skipped — nothing went live",
  timeout: "Still deploying after 5 minutes",
  "no-checks": "No deploy started",
  "no-access": "Cannot read the deploy status",
  error: "Could not read the deploy status",
  stopped: "",
};

/** The panel's deploy line, or null when this session has committed nothing (or watching is off and nothing is known). */
export function deployLine(deploy: PanelDeploy | null): DeployLine | null {
  if (!deploy) return null;
  const what = `${deploy.version !== undefined ? `v${deploy.version} on ` : ""}${deploy.branch}`;
  if (deploy.phase === "watching") return { headline: `Checking the deploy of ${what}…`, detail: null, attention: false };
  return {
    headline: `${what}: ${HEADLINES[deploy.kind]}`,
    detail: deploy.attention ? deploy.text : null,
    attention: deploy.attention,
  };
}

/** What `loadPanelState` needs from the outside. */
export interface PanelEnv {
  settings: BlygSettings;
  vault: VaultPort;
  /** The plugin's record of plain publishes; without one, plain routes always read "not known". */
  published?: PublishedStore;
  /**
   * Studio notes: what the Studio last said about this item (a cached answer; the caller starts a fetch in the background and redraws when
   * it arrives). `id` is the note's id when it has one of this Studio's. Never called for other routes. Without it the panel shows only
   * what the note's own record says.
   */
  studioLive?: (note: NoteRef, id: string | null) => { facts?: StudioFacts; warnings: string[]; notes?: string[] };
  /** Reading the images a Studio note embeds (to tell whether they changed, and to name what stops a publish). Without it such a note shows a problem. */
  images?: BinaryVaultPort;
  /** Digests of images already read; keeps the panel from reading an unchanged image on every redraw. */
  imageDigests?: DigestCache;
}

/**
 * The panel's state for `note`: reads the note's own frontmatter and, only when a comparison is needed (a Blyg note with an
 * id that is not withdrawn; a plain note that can be published), its text. Never touches the network. A note that cannot be read counts as "no note".
 */
export async function loadPanelState(env: PanelEnv, note: NoteRef | null): Promise<PanelState> {
  const { settings, vault } = env;
  if (!note) return computePanelState({ settings, note: null, frontmatter: {}, localHash: null });
  try {
    const frontmatter: LocalBlygFrontmatter = {
      id: vault.blygId(note),
      version: vault.frontmatterValue(note, "blyg_version"),
      created: vault.frontmatterValue(note, "blyg_created"),
      updated: vault.frontmatterValue(note, "blyg_updated"),
      hash: vault.frontmatterValue(note, "blyg_hash"),
      withdrawn: vault.frontmatterValue(note, "blyg_withdrawn"),
      channel: vault.frontmatterValue(note, "blyg_channel"),
      kind: vault.frontmatterValue(note, "blyg_kind"),
      origin: vault.frontmatterValue(note, ORIGIN_KEY),
      sent: vault.frontmatterValue(note, SENT_KEY),
      url: vault.frontmatterValue(note, URL_KEY),
      hoppers: vault.frontmatterValue(note, HOPPERS_KEY),
      stubOf: vault.frontmatterValue(note, STUB_KEY),
    };
    const route = routeFor(settings.routes, note.path);
    const needsHash = route?.mode === "blyg" && note.extension === "md" && isBlygId(frontmatter.id) && frontmatter.withdrawn !== true;
    if (route?.mode === "plain" && note.extension === "md") {
      const target = resolvePlainTarget(route, note, settings.blyg.itemsDir);
      if (target.ok) {
        const localHash = await localPlainHash(await vault.read(note));
        let plainRecord: PublishedRecord | null = null;
        try {
          plainRecord = (await env.published?.get(activeBranch(settings), target.destPath)) ?? null;
        } catch {
          // An unreadable record only means "not known".
        }
        return computePanelState({ settings, note, frontmatter, localHash, plainRecord });
      }
    }
    if (route?.mode === "studio" && note.extension === "md") {
      const stripped = stripObsidianComments(stripFrontmatter(await vault.read(note)));
      const declared = localKind(frontmatter.kind);
      const kind: BlygKind = "kind" in declared ? declared.kind : "fragment";
      if (!stripped.ok) return computePanelState({ settings, note, frontmatter, localHash: null, thread: { quotes: 0, passages: 0, links: 0, problems: [] } });
      // The hash a publish stamps (`blyg_sent`) is of the text with names turned into ids and pictures in their canonical form, so that is the text to hash here too.
      const pictures = await resolveImages(normalizeContentMd(stripped.text), { vault, binary: env.images, fromPath: note.path, folder: route.vaultPrefix, ...(env.imageDigests ? { cache: env.imageDigests } : {}) });
      // A picture that cannot be sent is listed with the other problems (the publish refuses with the same words); the text is then taken as written.
      const { contentMd, ...summary } = studioTextSummary(pictures.problems.length > 0 ? normalizeContentMd(stripped.text) : pictures.text, kind, { settings, vault, note });
      const thread = pictures.problems.length > 0 ? { ...summary, problems: [...pictures.problems, ...summary.problems] } : summary;
      const address = studioAddress(settings.studio);
      const idOfThisStudio = address && isBlygId(frontmatter.id) && typeof frontmatter.origin === "string" && sameOrigin(frontmatter.origin, address.origin) ? frontmatter.id : null;
      const live = env.studioLive?.(note, idOfThisStudio);
      return computePanelState({ settings, note, frontmatter, localHash: await localStudioHash(contentMd), thread, ...(live ? { studio: live } : {}) });
    }
    if (route?.mode === "blyg" && note.extension === "md") {
      const raw = await vault.read(note);
      const declared = localKind(frontmatter.kind);
      const kind: BlygKind = "kind" in declared ? declared.kind : "fragment";
      const text = publishedTextOf(raw, { vault, routes: settings.routes, fromPath: note.path });
      if (!text.ok) return computePanelState({ settings, note, frontmatter, localHash: null, thread: { quotes: 0, passages: 0, links: 0, problems: [] } });
      const thread = summarizeContent(text.contentMd, kind, text.embedProblems, localPublishProblems(text.contentMd, kind, { settings, vault, note }));
      return computePanelState({ settings, note, frontmatter, localHash: needsHash ? await contentHash(text.contentMd) : null, thread });
    }
    return computePanelState({ settings, note, frontmatter, localHash: null });
  } catch {
    return computePanelState({ settings, note: null, frontmatter: {}, localHash: null });
  }
}
