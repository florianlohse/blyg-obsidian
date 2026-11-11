// The two commands' logic, with every Obsidian-facing piece passed in so it runs in Node tests.
import { createContentsClient, type ContentsClient } from "../github/contents";
import type { GithubHttp, RawTransport } from "../platform/http";
import type { BinaryVaultPort, Clock, Keychain, Logger, NoteEditPort, NoteRef, Random, SiteReader, Timers, VaultPort, Yaml } from "../platform/ports";
import { redact } from "../platform/redact";
import { readToken } from "../platform/token";
import { fetchQuotable, type Quotable } from "../publish/items";
import { deleteDraftNote, publishNote, pullNote, repostNote, withdrawNote } from "../publish/router";
import { studioFailureOutcome } from "../publish/studio";
import { takeHoppersNote } from "../publish/studioHopperNote";
import type { DigestCache } from "../studio/media";
import type { StudioHopper } from "../studio/types";
import { lookupAddress, stubTargetOf } from "../studio/lookup";
import { parseItemAddress, type StubTarget } from "../studio/stub";
import type { ImportDeps, NoteFiles } from "../publish/studioImport";
import type { Confirmation, Outcome, PublishDeps, WritePreview } from "../publish/types";
import type { BlygSettings } from "../settings/schema";
import { studioAddress } from "../studio/address";
import { devStudioProblem } from "../studio/devLock";
import { contractCacheFor, createStudioClient } from "../studio/client";
import type { ContractVerdict } from "../studio/version";
import { createStudioHttp } from "../studio/http";
import { loadStudioFacts, loadStudioNotices, type StudioFacts, type StudioNotices } from "../studio/live";
import { readQuotable } from "../studio/passage";
import type { PendingDrafts } from "../studio/pending";
import { hitPick, type StudioPick } from "../studio/picker";
import { createPublishedRecorder, type PublishedStore } from "./publishedStore";
import { M } from "../publish/messages";
import { preflight, toPublishSettings } from "./publishSettings";
import { githubInUse } from "../settings/studioOnly";

export interface AppEnv {
  settings: BlygSettings;
  activeNote(): NoteRef | null;
  /** Save any pending edits of the open note to disk, so what is published is what is on screen. */
  flush(): Promise<void>;
  keychain: Keychain;
  /** Creates the GitHub client; passed in so tests can fake the network. */
  http: GithubHttp;
  vault: VaultPort;
  /** Reading images a note embeds (Studio routes). Optional (tests that never do); without it a note with an image is refused with a reason. */
  images?: BinaryVaultPort;
  /** Digests of images already read (shared with the panel). */
  imageDigests?: DigestCache;
  /** Replacing a note's text (bringing the Studio's copy in). Optional (tests that never do). */
  edit?: NoteEditPort;
  yaml: Yaml;
  clock: Clock;
  random: Random;
  /** Reads the quoted items' documents from the site (threads and item links). */
  site?: SiteReader;
  logger?: Logger;
  confirm(preview: WritePreview): Promise<Confirmation>;
  /** Where plain publishes are remembered (for the panel); optional. */
  published?: PublishedStore;
  /** What a publish through a Studio needs from the outside: the network, timers, and the record of drafts not yet stamped. Optional (tests, older callers). */
  studio?: { transport: RawTransport; timers: Timers; pending: PendingDrafts; /** What the session has learnt about each Studio's API contract (see studio/client.ts); optional (tests). */ contracts?: Map<string, ContractVerdict> };
}

const refuse = (message: string): Outcome => ({ status: "refused", notices: [message] });

/** The Studio client for the settings, or why there is none. A missing Studio never blocks essays and pages: only a Studio route is refused. */
function buildStudio(env: AppEnv): { ok: true; studio: NonNullable<PublishDeps["studio"]>; token: string } | { ok: false; message: string } {
  const address = studioAddress(env.settings.studio);
  if (!address || !env.studio) return { ok: false, message: devStudioProblem(env.settings.studio.baseUrl) ?? M.studioNotConfigured };
  const token = readToken(env.keychain, env.settings.studio.tokenSecretName, "Studio");
  if (!token.ok) return { ok: false, message: token.message };
  const http = createStudioHttp({ transport: env.studio.transport, timers: env.studio.timers, address, ...(env.logger ? { logger: env.logger } : {}) });
  return { ok: true, token: token.token, studio: { client: createStudioClient({ http, token: token.token, ...(env.studio.contracts ? { gate: contractCacheFor(env.studio.contracts, address.apiBase) } : {}) }), address, pending: env.studio.pending } };
}

/**
 * Everything the publish services need, or the reason there is none (invalid settings). Neither service is needed for the other: a Studio-only
 * setup (settings/studioOnly.ts) never touches GitHub, and a missing GitHub token or Studio token only refuses the routes that use it.
 * `secrets` are the tokens in play, for redacting anything that is shown.
 */
function buildDeps(env: AppEnv): { ok: true; deps: PublishDeps; secrets: string[] } | { ok: false; outcome: Outcome } {
  const problem = preflight(env.settings);
  if (problem) return { ok: false, outcome: refuse(problem) };
  const { github } = env.settings;
  const secrets: string[] = [];
  let githubClient: ContentsClient | undefined;
  let githubProblem: string | undefined;
  if (githubInUse(env.settings)) {
    const token = readToken(env.keychain, github.tokenSecretName);
    if (token.ok) {
      secrets.push(token.token);
      githubClient = createContentsClient({ http: env.http, token: token.token, owner: github.owner, repo: github.repo });
    } else githubProblem = token.message;
  }
  const studio = buildStudio(env);
  if (studio.ok) secrets.push(studio.token);
  return {
    ok: true,
    secrets,
    deps: {
      ...(studio.ok ? { studio: studio.studio } : { studioProblem: studio.message }),
      ...(githubClient ? { github: githubClient } : { githubProblem: githubProblem ?? M.githubNotSetUp }),
      settings: toPublishSettings(env.settings),
      confirm: (preview) => env.confirm(preview),
      vault: env.vault,
      ...(env.images ? { images: env.images } : {}),
      ...(env.imageDigests ? { imageDigests: env.imageDigests } : {}),
      ...(env.edit ? { edit: env.edit } : {}),
      yaml: env.yaml,
      clock: env.clock,
      random: env.random,
      ...(env.site ? { site: env.site } : {}),
      ...(env.logger ? { logger: env.logger } : {}),
      ...(env.published ? { rememberPublished: createPublishedRecorder(env.published, env.clock) } : {}),
    },
  };
}

async function run(env: AppEnv, action: typeof publishNote): Promise<Outcome> {
  const note = env.activeNote();
  if (!note) return refuse("No active note — open a note first.");

  const built = buildDeps(env);
  if (!built.ok) return built.outcome;

  try {
    await env.flush();
    return await action(built.deps, note);
  } catch (err) {
    // Last resort: an unexpected exception must not leave the user guessing, and must not leak the token.
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`unexpected error: ${detail}`);
    return { status: "failed", notices: [`Something unexpected went wrong: ${redact(detail, built.secrets)}. Nothing was committed unless an earlier message said so.`] };
  }
}

export const runPublish = (env: AppEnv): Promise<Outcome> => run(env, publishNote);
export const runWithdraw = (env: AppEnv): Promise<Outcome> => run(env, withdrawNote);
export const runRepost = (env: AppEnv): Promise<Outcome> => run(env, repostNote);
export const runPull = (env: AppEnv): Promise<Outcome> => run(env, pullNote);
export const runDeleteDraft = (env: AppEnv): Promise<Outcome> => run(env, deleteDraftNote);
export const runTakeHoppers = (env: AppEnv): Promise<Outcome> => run(env, takeHoppersNote);

/** The Studio's hoppers, for the picker (roadmap S13). Needs only the Studio settings and token. */
export async function runStudioHoppers(env: AppEnv): Promise<{ ok: true; hoppers: StudioHopper[] } | { ok: false; outcome: Outcome }> {
  const built = buildStudio(env);
  if (!built.ok) return { ok: false, outcome: refuse(built.message) };
  try {
    const listed = await built.studio.client.listHoppers();
    if (listed.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Reading the hoppers", listed) };
    return { ok: true, hoppers: listed.value };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`unexpected error: ${detail}`);
    return { ok: false, outcome: { status: "failed", notices: [M.studioNetworkSafe] } };
  }
}

/** Look up one published item for the quote picker (read-only: settings, token and the site, no window, no write). */
export async function runFetchQuotable(env: AppEnv, id: string): Promise<Quotable> {
  const built = buildDeps(env);
  if (!built.ok) return { ok: false, outcome: built.outcome };
  try {
    return await fetchQuotable(built.deps, id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`unexpected error: ${detail}`);
    return { ok: false, outcome: { status: "failed", notices: [`Something unexpected went wrong: ${redact(detail, built.secrets)}.`] } };
  }
}

/** The Studio's search for the quote picker. Needs only the Studio settings and token, not the GitHub ones. */
export async function runStudioSearch(env: AppEnv, q: string): Promise<{ ok: true; picks: StudioPick[] } | { ok: false; outcome: Outcome }> {
  const built = buildStudio(env);
  if (!built.ok) return { ok: false, outcome: refuse(built.message) };
  try {
    const found = await built.studio.client.search({ q, source: "all", limit: 25 });
    if (found.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Search", found) };
    return { ok: true, picks: found.value.items.map(hitPick) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`unexpected error: ${detail}`);
    return { ok: false, outcome: { status: "failed", notices: [M.studioSearchFailed] } };
  }
}

/** A pasted address as one picker row (roadmap S9). Needs only the Studio settings and token. */
export async function runStudioLookup(env: AppEnv, input: string): Promise<{ ok: true; pick: StudioPick } | { ok: false; error: string } | null> {
  const built = buildStudio(env);
  if (!built.ok) return parseItemAddress(input, studioAddress(env.settings.studio)) === null ? null : { ok: false, error: built.message };
  try {
    const found = await lookupAddress(built.studio.client, built.studio.address, input);
    if (found.kind === "not-an-address") return null;
    return found.kind === "found" ? { ok: true, pick: found.pick } : { ok: false, error: found.message };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`unexpected error: ${detail}`);
    return { ok: false, error: M.studioSearchFailed };
  }
}

/** What a reply to the picked row names (its blyg, id and current version), or why it cannot be answered. */
export async function runStudioReplyTarget(env: AppEnv, pick: StudioPick): Promise<{ ok: true; target: StubTarget } | { ok: false; message: string }> {
  const built = buildStudio(env);
  if (!built.ok) return { ok: false, message: built.message };
  try {
    return await stubTargetOf(built.studio.client, built.studio.address, pick);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`unexpected error: ${detail}`);
    return { ok: false, message: M.studioSearchFailed };
  }
}

/** The text of a picked item, to choose a passage from. */
export async function runStudioQuotable(env: AppEnv, pick: StudioPick): Promise<Quotable> {
  const built = buildStudio(env);
  if (!built.ok) return { ok: false, outcome: refuse(built.message) };
  try {
    return await readQuotable(built.studio.client, pick);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    env.logger?.warn(`unexpected error: ${detail}`);
    return { ok: false, outcome: { status: "failed", notices: [`Something unexpected went wrong: ${redact(detail, [built.token])}.`] } };
  }
}

/** What the Studio says about one item, for the panel. Never throws; "could not ask" is an answer (`unreachable`). */
export async function runStudioFacts(env: AppEnv, id: string): Promise<StudioFacts> {
  const built = buildStudio(env);
  if (!built.ok) return { item: "unreachable", mentions: null, at: env.clock.now().getTime() };
  return loadStudioFacts(built.studio.client, id, env.clock);
}

/** Warnings for the whole Studio (token expiry, release outside the tested range, no token on this device) as sentences for the panel. */
export async function runStudioWarnings(env: AppEnv): Promise<StudioNotices> {
  const built = buildStudio(env);
  if (!built.ok) return { warnings: env.settings.studio.baseUrl === "" ? [] : [built.message], notes: [] };
  return loadStudioNotices(built.studio.client, built.token, env.clock);
}

/**
 * What "Studio: import new items" needs (roadmap S7). Only the Studio settings and token, not the GitHub ones: an import touches neither the
 * site repository nor GitHub.
 */
export function buildImportDeps(env: AppEnv, more: { files: NoteFiles; templateProps?: ImportDeps["templateProps"] }): { ok: true; deps: ImportDeps } | { ok: false; outcome: Outcome } {
  const built = buildStudio(env);
  if (!built.ok) return { ok: false, outcome: refuse(built.message) };
  if (!env.edit) return { ok: false, outcome: refuse(M.studioPullNoEdit) };
  return {
    ok: true,
    deps: {
      client: built.studio.client,
      address: built.studio.address,
      routes: env.settings.routes,
      importFolder: env.settings.studio.importFolder,
      fragmentCharCap: env.settings.blyg.fragmentCharCap,
      vault: env.vault,
      edit: env.edit,
      yaml: env.yaml,
      files: more.files,
      ...(more.templateProps ? { templateProps: more.templateProps } : {}),
      ...(env.logger ? { logger: env.logger } : {}),
    },
  };
}
