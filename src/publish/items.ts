// What a note quotes (`![[id]]`) and links to (`[[id]]`): resolve each id to one of the author's own published items on the
// target branch, take the frozen snapshot, check the quoted passages, and decide what the committed file will say
// (docs/CONTRACT.md §3.3, §3.4; spec §10.2).
//
// Resolution order is the spec's: (1) an own published item; (2) an imported item from the reader cache (R4, not built: until
// then an unknown id is an error); (3) an error. The committed file on the TARGET branch says which version exists and whether
// it is withdrawn; the deployed item document on that branch's origin supplies `content_html`, which is stored unmodified (the
// site sanitises when it bakes). A source that is already frozen in the committed thread at the same version keeps its snapshot:
// republishing never changes a quote the author did not touch.
import { itemPagePath } from "../contract";
import type { BlygKind, CommittedBlyg } from "../core/blyg";
import { renderQuoteSelection } from "../core/quote";
import {
  describeSourceChanges,
  findClosureCycle,
  linkLabel,
  readLinks,
  readSources,
  sourcesDiffer,
  type LinkEntry,
  type SourceEntry,
} from "../core/sources";
import { excerptFromHtml, locateSelection, selectionText } from "../core/textContent";
import { isBlygId } from "../core/ids";
import type { Directive } from "../core/thread";
import { isRecord } from "../core/frontmatter";
import { HttpError } from "../platform/http";
import { publicHttpsUrl } from "../platform/siteReader";
import { M } from "./messages";
import { logError, lookupCommittedBlyg } from "./shared";
import { failed, refused, type Outcome, type PreviewQuote, type PublishDeps, type WritePreview } from "./types";

/** Thrown inside this module when the publish must stop with a ready-made outcome (a failed read, say). */
class StopPublish extends Error {
  constructor(readonly outcome: Outcome) {
    super("stop");
  }
}

export interface PreparedItems {
  sources: SourceEntry[];
  links: LinkEntry[];
  /** Contract §3.3: a source moved or changed, so the thread needs a new version even if its text did not change. */
  sourcesChanged: boolean;
  preview: NonNullable<WritePreview["thread"]>;
  /** Plain-language lines about what moved in the sources, for the write preview. */
  changes: string[];
}

type Doc = { ok: true; html: string; page: string; author: Record<string, unknown> | undefined } | { ok: false; message: string };

const withSlash = (url: string): string => (url.endsWith("/") ? url : `${url}/`);
const sameOrigin = (a: string, b: string): boolean => withSlash(a) === withSlash(b);
const unique = <T>(items: T[]): T[] => [...new Set(items)];

export async function prepareItems(
  deps: PublishDeps,
  input: { kind: BlygKind; directives: Directive[]; linkIds: string[]; selfId: string | undefined; committed: CommittedBlyg | null },
): Promise<{ ok: true; prepared: PreparedItems } | { ok: false; outcome: Outcome }> {
  const { settings, site, clock } = deps;
  const { directives, linkIds, committed } = input;
  const origin = settings.origin;

  // A thread that quotes and links to nothing needs neither the site nor an address.
  if (directives.length === 0 && linkIds.length === 0) {
    const frozen = committed ? readSources(committed.rawSources) : [];
    return {
      ok: true,
      prepared: {
        sources: [],
        links: [],
        sourcesChanged: input.kind === "thread" && sourcesDiffer(frozen, []),
        preview: { quotes: [], itemLinks: [] },
        changes: input.kind === "thread" ? describeSourceChanges(frozen, []) : [],
      },
    };
  }

  if (publicHttpsUrl(origin) === null) return { ok: false, outcome: refused(M.needsOrigin(settings.channel)) };
  if (!site) return { ok: false, outcome: refused(M.needsSite) };

  // What the committed file froze earlier (null: unreadable, so nothing is reused and the sources count as changed).
  const frozenSources = committed ? readSources(committed.rawSources) : [];
  const frozenLinks = committed ? readLinks(committed.rawLinks) : [];

  /** The committed item `id` on the target branch, or null when there is none. Read once per id. */
  const infos = new Map<string, Promise<CommittedBlyg | null>>();
  const infoOf = (id: string): Promise<CommittedBlyg | null> => {
    let info = infos.get(id);
    if (!info) {
      info = (async (): Promise<CommittedBlyg | null> => {
        const lookup = await lookupCommittedBlyg(deps, `${settings.itemsDir}/${id}.md`);
        if (lookup.kind === "stop") throw new StopPublish(lookup.outcome);
        return lookup.kind === "missing" ? null : lookup.committed;
      })();
      infos.set(id, info);
    }
    return info;
  };

  const docs = new Map<string, Promise<Doc>>();
  const docOf = (id: string, info: CommittedBlyg, what: string): Promise<Doc> => {
    let doc = docs.get(id);
    if (!doc) {
      doc = readDeployedItem(deps, id, info, what);
      docs.set(id, doc);
    }
    return doc;
  };

  const whatFor = (id: string): string => {
    const lines = directives.filter((d) => d.id === id).map((d) => d.line);
    return lines.length > 0 ? `The quote on line ${lines.join(", ")}` : `The link [[${id.slice(0, 8)}…]]`;
  };

  try {
    const allIds = unique([...directives.map((d) => d.id), ...linkIds]);
    const problems: string[] = [];

    // 1. What exists on the target branch.
    const resolved = new Map<string, CommittedBlyg>();
    await Promise.all(allIds.map((id) => infoOf(id)));
    for (const id of allIds) {
      const info = await infoOf(id);
      if (!info) problems.push(M.noSuchItem(whatFor(id), id, settings.branch));
      else if (info.withdrawn) problems.push(M.withdrawnItem(whatFor(id), id));
      else resolved.set(id, info);
    }

    // 2. Snapshots: reuse the frozen one when the version is unchanged, otherwise read the deployed document.
    const reusable = (id: string, version: number): SourceEntry | undefined =>
      frozenSources?.find((s) => s.id === id && s.version === version && sameOrigin(s.origin, origin));
    const frozenLink = (id: string): LinkEntry | undefined => frozenLinks?.find((l) => l.id === id && sameOrigin(l.origin, origin));
    const needDoc = unique([
      ...directives.filter((d) => resolved.has(d.id) && !reusable(d.id, resolved.get(d.id)?.version ?? 0)).map((d) => d.id),
      ...linkIds.filter((id) => resolved.has(id) && !frozenLink(id)),
    ]);
    const fetched = new Map<string, Doc>();
    await Promise.all(
      needDoc.map(async (id) => {
        const committedItem = resolved.get(id);
        if (committedItem) fetched.set(id, await docOf(id, committedItem, whatFor(id)));
      }),
    );
    for (const [, doc] of fetched) if (!doc.ok) problems.push(doc.message);

    // 3. The sources, in directive order, with their selectors.
    const now = clock.now().toISOString();
    const sources: SourceEntry[] = [];
    for (const directive of directives) {
      const item = resolved.get(directive.id);
      if (!item) continue;
      const frozen = reusable(directive.id, item.version);
      const fetchedDoc = fetched.get(directive.id);
      const doc = fetchedDoc && fetchedDoc.ok ? fetchedDoc : undefined;
      if (!frozen && !doc) continue; // already reported
      const html = frozen?.html ?? doc?.html ?? "";
      const author = frozen ? frozen.author : doc?.author;
      let selector: SourceEntry["selector"];
      if (directive.quoteMd !== null) {
        const rendered = renderQuoteSelection(directive.quoteMd);
        if (!rendered.ok) {
          problems.push(M.quoteUnsupported(directive.line, rendered.reason));
          continue;
        }
        if (rendered.selection === "") {
          problems.push(M.quoteEmpty(directive.line));
          continue;
        }
        selector = frozen?.selector?.exact === rendered.selection ? frozen.selector : (locateSelection(html, rendered.selection) ?? undefined);
        if (!selector) {
          problems.push(M.quoteNotFound(directive.line, directive.id, item.version, /['"`]/.test(rendered.selection)));
          continue;
        }
      }
      sources.push({
        id: directive.id,
        version: item.version,
        origin,
        kind: item.kind,
        html,
        ...(author ? { author } : {}),
        page: frozen?.page ?? doc?.page ?? `${withSlash(origin)}${itemPagePath(item.kind, directive.id)}`,
        retrieved: frozen?.retrieved ?? now,
        ...(selector ? { selector } : {}),
      });
    }

    // 4. The links: a frozen label stays (it is frozen on purpose), a new link gets one from the target's text.
    const links: LinkEntry[] = [];
    for (const id of linkIds) {
      const item = resolved.get(id);
      if (!item) continue;
      const frozen = frozenLink(id);
      if (frozen) {
        links.push(frozen);
        continue;
      }
      const doc = fetched.get(id);
      if (!doc || !doc.ok) continue; // already reported
      const label = linkLabel(doc.html);
      links.push({ id, origin, page: doc.page, ...(label ? { label } : {}) });
    }

    // 5. A thread may not quote a thread that quotes it (spec §10.2, local closure).
    if (input.kind === "thread" && problems.length === 0) {
      const quotes = async (id: string): Promise<string[] | null> => {
        const info = await infoOf(id);
        if (!info || info.kind !== "thread") return null;
        const quoted = readSources(info.rawSources);
        return quoted ? quoted.filter((s) => sameOrigin(s.origin, origin)).map((s) => s.id) : null;
      };
      const cycle = await findClosureCycle(input.selfId, unique(directives.map((d) => d.id)), quotes);
      if (cycle) return { ok: false, outcome: refused(M.closure(cycle)) };
    }

    if (problems.length > 0) return { ok: false, outcome: refused(M.itemProblems(problems)) };

    const quotes: PreviewQuote[] = sources.map((s, i) => {
      const before = frozenSources?.[i];
      const change = !before || before.id !== s.id ? "new" : before.version !== s.version ? "moved" : "unchanged";
      return {
        id: s.id,
        version: s.version,
        kind: s.kind,
        passage: s.selector?.exact ?? null,
        excerpt: excerptFromHtml(s.html, 80),
        change,
        ...(change === "moved" && before ? { fromVersion: before.version } : {}),
      };
    });
    return {
      ok: true,
      prepared: {
        sources,
        links,
        sourcesChanged: input.kind === "thread" && sourcesDiffer(frozenSources, sources),
        preview: { quotes, itemLinks: links.map((l) => ({ id: l.id, label: l.label ?? "", isNew: !frozenLinks?.some((f) => f.id === l.id) })) },
        changes: input.kind === "thread" ? describeSourceChanges(frozenSources, sources) : [],
      },
    };
  } catch (err) {
    if (err instanceof StopPublish) return { ok: false, outcome: err.outcome };
    logError(deps, "resolving quotes and links", err);
    return { ok: false, outcome: failed(err instanceof HttpError ? M.networkSite : M.networkRead) };
  }
}

/** The deployed item document of `id`: its rendered HTML must be the committed version, or the snapshot would not be that version. */
async function readDeployedItem(deps: PublishDeps, id: string, committed: CommittedBlyg, what: string): Promise<Doc> {
  const { settings, site } = deps;
  if (!site) return { ok: false, message: M.needsSite };
  const url = publicHttpsUrl(new URL(`items/${id}.json`, settings.origin).href);
  if (!url) return { ok: false, message: M.badAddress(what, settings.origin) };
  const res = await site.getJson(url.href);
  if (res.status === 404) return { ok: false, message: M.notDeployed(what, id, committed.version, null) };
  if (res.status !== 200 || !isRecord(res.json)) return { ok: false, message: M.docUnreadable(what, id, res.status) };
  const doc = res.json;
  if (doc.kind === "withdrawn") return { ok: false, message: M.withdrawnItem(what, id) };
  if (doc.id !== id || typeof doc.version !== "number" || typeof doc.content_html !== "string" || doc.content_html === "") {
    return { ok: false, message: M.docUnreadable(what, id, 200) };
  }
  if (doc.version < committed.version) return { ok: false, message: M.notDeployed(what, id, committed.version, doc.version) };
  if (doc.version > committed.version) return { ok: false, message: M.serverNewer(what, id, committed.version, doc.version) };
  if (doc.kind !== committed.kind) return { ok: false, message: M.docKind(what, id, committed.kind, String(doc.kind)) };
  let page = `${withSlash(settings.origin)}${itemPagePath(committed.kind, id)}`;
  if (typeof doc.page === "string") {
    const resolved = publicHttpsUrl(new URL(doc.page, settings.origin).href);
    if (resolved) page = resolved.href;
  }
  return { ok: true, html: doc.content_html, page, author: isRecord(doc.author) ? doc.author : undefined };
}


/** One published item as the quote picker needs it: the text a reader sees, one line per block, to select a passage from. */
export type Quotable =
  | { ok: true; id: string; version: number; kind: BlygKind; /** The item's `content_html`, as the site serves it. */ html: string; /** `selectionText(html)`. */ text: string }
  | { ok: false; outcome: Outcome };

/**
 * Look up one of the author's own published items on the target branch and read its deployed document, with the same checks the
 * publish makes (it exists, is not withdrawn, the site serves the committed version). Writes nothing.
 */
export async function fetchQuotable(deps: PublishDeps, id: string): Promise<Quotable> {
  const { settings, site } = deps;
  if (!isBlygId(id)) return { ok: false, outcome: refused(M.invalidId(id)) };
  if (publicHttpsUrl(settings.origin) === null) return { ok: false, outcome: refused(M.needsOrigin(settings.channel)) };
  if (!site) return { ok: false, outcome: refused(M.needsSite) };
  try {
    const lookup = await lookupCommittedBlyg(deps, `${settings.itemsDir}/${id}.md`);
    if (lookup.kind === "stop") return { ok: false, outcome: lookup.outcome };
    const what = "This item";
    if (lookup.kind === "missing") return { ok: false, outcome: refused(M.noSuchItem(what, id, settings.branch)) };
    if (lookup.committed.withdrawn) return { ok: false, outcome: refused(M.withdrawnItem(what, id)) };
    const doc = await readDeployedItem(deps, id, lookup.committed, what);
    if (!doc.ok) return { ok: false, outcome: refused(doc.message) };
    return { ok: true, id, version: lookup.committed.version, kind: lookup.committed.kind, html: doc.html, text: selectionText(doc.html) };
  } catch (err) {
    logError(deps, "reading an item to quote", err);
    return { ok: false, outcome: failed(err instanceof HttpError ? M.networkSite : M.networkRead) };
  }
}
