// Frozen snapshots and item links of a thread (docs/CONTRACT.md §3.3, §3.4): their shape, how they are written into a committed
// file, how they are read back, when a changed source means a new version, and the local-closure walk. Pure.
import { isRecord } from "./frontmatter";
import { excerptFromHtml, type Selector } from "./textContent";

export interface SourceEntry {
  id: string;
  version: number;
  /** The blyg origin the snapshot came from (always written, also for the site's own items). */
  origin: string;
  kind: "fragment" | "thread";
  /** The source item document's `content_html` at `version`, unmodified. */
  html: string;
  /** The source's own author object, passed through; absent when its item document has none. */
  author?: Record<string, unknown>;
  /** Absolute URL of the source's page. */
  page?: string;
  /** When the snapshot was taken (ISO 8601). */
  retrieved: string;
  /** Only for a partial quotation. */
  selector?: Selector;
}

export interface LinkEntry {
  id: string;
  origin: string;
  page?: string;
  /** The anchor text, frozen at publish. */
  label?: string;
}

const withSlash = (url: string): string => (url.endsWith("/") ? url : `${url}/`);

/** The anchor text of a link to `html`'s item: its first ~60 characters in curly quotes (the reference's choice); "" when it has no text. */
export function linkLabel(html: string): string {
  const excerpt = excerptFromHtml(html, 60);
  return excerpt === "" ? "" : `“${excerpt}”`;
}

// ---- writing ---------------------------------------------------------------------------------------------------------

/**
 * A YAML double-quoted scalar. JSON-style escaping plus the characters JSON leaves raw but YAML 1.1 readers treat as line breaks
 * (U+0085, U+2028, U+2029): a snapshot is long, full of quotes and newlines, and must read back as the same string.
 */
export function yamlQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || (c >= 0xd800 && c <= 0xdfff)) {
      out += `\\u${c.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `${out}"`;
}

const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const isNonEmpty = (value: unknown): value is unknown[] | Record<string, unknown> =>
  Array.isArray(value) ? value.length > 0 : isRecord(value) && Object.keys(value).length > 0;

/** A value that fits after `key:` or `- ` on one line: a scalar (strings always quoted) or an empty container. */
function inline(value: unknown): string {
  if (typeof value === "string") return yamlQuote(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : JSON.stringify(value);
  if (isRecord(value)) return Object.keys(value).length === 0 ? "{}" : JSON.stringify(value);
  return "null";
}

/** The entries of a JSON object as YAML mapping lines, `indent` spaces in. */
function emitMapping(obj: Record<string, unknown>, indent: number): string[] {
  const pad = " ".repeat(indent);
  return Object.entries(obj).flatMap(([key, value]) => {
    const name = SIMPLE_KEY.test(key) ? key : yamlQuote(key);
    if (Array.isArray(value) && value.length > 0) return [`${pad}${name}:`, ...emitSequence(value, indent + 2)];
    if (isRecord(value) && isNonEmpty(value)) return [`${pad}${name}:`, ...emitMapping(value, indent + 2)];
    return [`${pad}${name}: ${inline(value)}`];
  });
}

function emitSequence(items: unknown[], indent: number): string[] {
  const pad = " ".repeat(indent);
  return items.flatMap((item) => {
    if (isRecord(item) && isNonEmpty(item)) {
      const [first = "", ...rest] = emitMapping(item, indent + 2);
      return [`${pad}- ${first.slice(indent + 2)}`, ...rest];
    }
    return [`${pad}- ${inline(item)}`];
  });
}

/** The `blyg_sources` key of a committed file (`blyg_sources: []` when there is none: a withdrawn thread). Ends with a newline. */
export function renderSourcesYaml(sources: SourceEntry[]): string {
  if (sources.length === 0) return "blyg_sources: []\n";
  const items = sources.map((s) => ({
    id: s.id,
    version: s.version,
    origin: s.origin,
    kind: s.kind,
    html: s.html,
    ...(s.author ? { author: s.author } : {}),
    ...(s.page ? { page: s.page } : {}),
    retrieved: s.retrieved,
    ...(s.selector ? { selector: { exact: s.selector.exact, ...(s.selector.prefix ? { prefix: s.selector.prefix } : {}), ...(s.selector.suffix ? { suffix: s.selector.suffix } : {}) } } : {}),
  }));
  return `${["blyg_sources:", ...emitSequence(items, 2)].join("\n")}\n`;
}

/** The `blyg_links` key; nothing at all when there are no links. */
export function renderLinksYaml(links: LinkEntry[]): string {
  if (links.length === 0) return "";
  const items = links.map((l) => ({ id: l.id, origin: l.origin, ...(l.page ? { page: l.page } : {}), ...(l.label ? { label: l.label } : {}) }));
  return `${["blyg_links:", ...emitSequence(items, 2)].join("\n")}\n`;
}

// ---- reading back ----------------------------------------------------------------------------------------------------

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Object.prototype.toString.call(value) === "[object Date]" && !Number.isNaN((value as Date).getTime())) return (value as Date).toISOString();
  return undefined;
}

function readSelector(raw: unknown): Selector | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw) || typeof raw.exact !== "string" || raw.exact === "") return null;
  return {
    exact: raw.exact,
    ...(typeof raw.prefix === "string" && raw.prefix !== "" ? { prefix: raw.prefix } : {}),
    ...(typeof raw.suffix === "string" && raw.suffix !== "" ? { suffix: raw.suffix } : {}),
  };
}

/** `blyg_sources` of a committed file, validated; null when it is missing, not a list or any entry is unusable. */
export function readSources(raw: unknown): SourceEntry[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: SourceEntry[] = [];
  for (const item of raw as unknown[]) {
    if (!isRecord(item)) return null;
    const { id, version, origin, kind, html } = item;
    const retrieved = timestamp(item.retrieved);
    const selector = readSelector(item.selector);
    if (typeof id !== "string" || typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
    if (typeof origin !== "string" || (kind !== "fragment" && kind !== "thread") || typeof html !== "string" || retrieved === undefined) return null;
    if (selector === null) return null;
    out.push({
      id,
      version,
      origin,
      kind,
      html,
      ...(isRecord(item.author) ? { author: item.author } : {}),
      ...(typeof item.page === "string" ? { page: item.page } : {}),
      retrieved,
      ...(selector ? { selector } : {}),
    });
  }
  return out;
}

/** `blyg_links` of a committed file, validated; null when it is not a list or any entry is unusable. */
export function readLinks(raw: unknown): LinkEntry[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: LinkEntry[] = [];
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.origin !== "string") return null;
    out.push({
      id: item.id,
      origin: item.origin,
      ...(typeof item.page === "string" ? { page: item.page } : {}),
      ...(typeof item.label === "string" ? { label: item.label } : {}),
    });
  }
  return out;
}

// ---- when a source change is a new version ---------------------------------------------------------------------------

/** Contract §3.3: a republish bumps the version when any source's `(id, version, origin, selector)` differs from the committed one. */
export function sourcesDiffer(committed: SourceEntry[] | null, next: SourceEntry[]): boolean {
  if (committed === null || committed.length !== next.length) return true;
  return next.some((s, i) => {
    const c = committed[i];
    return !c || c.id !== s.id || c.version !== s.version || withSlash(c.origin) !== withSlash(s.origin) || (c.selector?.exact ?? null) !== (s.selector?.exact ?? null);
  });
}

/** Plain-language lines about what changed in the sources, for the write preview. `committed` is null on a first publish. */
export function describeSourceChanges(committed: SourceEntry[] | null, next: SourceEntry[]): string[] {
  const lines: string[] = [];
  next.forEach((s, i) => {
    const c = committed?.[i];
    const what = `${s.selector ? "passage from" : "quote of"} ${s.id.slice(0, 8)}…`;
    if (!c || c.id !== s.id) lines.push(`${what} v${s.version}: new`);
    else if (c.version !== s.version) lines.push(`${what} moves from v${c.version} to v${s.version}`);
    else if ((c.selector?.exact ?? null) !== (s.selector?.exact ?? null)) lines.push(`${what} v${s.version}: the quoted passage changed`);
  });
  if (committed && committed.length > next.length) lines.push(`${committed.length - next.length} quote${committed.length - next.length === 1 ? "" : "s"} removed`);
  return lines;
}

// ---- local closure (spec §10.2) --------------------------------------------------------------------------------------

/**
 * A thread must not quote a local thread whose own local sources, transitively, include the publishing thread. `quotes(id)`
 * gives the ids a local thread quotes (null: not a thread, or unreadable: a leaf). Returns the chain that leads back to
 * `selfId` (starting with the directly quoted thread), or null when there is none. Walking is bounded by visiting each id once.
 */
export async function findClosureCycle(selfId: string | undefined, direct: string[], quotes: (id: string) => Promise<string[] | null>): Promise<string[] | null> {
  if (selfId === undefined) return null; // a thread that has no id yet cannot be quoted by anything
  const seen = new Set<string>();
  const walk = async (id: string, path: string[]): Promise<string[] | null> => {
    if (id === selfId) return path;
    if (seen.has(id)) return null;
    seen.add(id);
    for (const next of (await quotes(id)) ?? []) {
      const found = await walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  for (const id of direct) {
    const found = await walk(id, [id]);
    if (found) return found;
  }
  return null;
}
