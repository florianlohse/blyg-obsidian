// Ports: the small interfaces that services depend on. Obsidian-backed implementations live in the *Obsidian files
// next to this one; tests supply fakes (docs/ARCHITECTURE.md §1). Nothing in this file imports "obsidian".

export interface Keychain {
  /** False on an Obsidian too old to have app.secretStorage. */
  available(): boolean;
  /** The secret stored under `name`, or null. Never log the result. */
  get(name: string): string | null;
}

export interface Notifier {
  notice(message: string, durationMs?: number): void;
}

export interface Clock {
  now(): Date;
}

export interface Random {
  /** Cryptographically secure random bytes. */
  bytes(length: number): Uint8Array;
}

export interface Timers {
  /** Run `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export interface Logger {
  debug(message: string): void;
  warn(message: string): void;
}

/** Reads a JSON document from the blyg's own site, without credentials. Throws only on a network failure or a refused address. */
export interface SiteReader {
  getJson(url: string): Promise<{ status: number; json: unknown }>;
}

export interface Yaml {
  /** Obsidian's parseYaml in the plugin; js-yaml in tests. Throws on invalid YAML. */
  parse(text: string): unknown;
  stringify(value: unknown): string;
}

/** A note as the publish services see it (decoupled from Obsidian's TFile). */
export interface NoteRef {
  /** Vault-relative path. */
  path: string;
  name: string;
  extension: string;
}

/** The bytes of a vault file (an image a note embeds), for uploading and for telling whether it changed. Separate from `VaultPort` on purpose. */
export interface BinaryVaultPort {
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Size in bytes and last-modified time, without reading the file; null when there is no such file. */
  fileInfo(path: string): { size: number; mtime: number } | null;
}

/** What replacing a note's text (pulling a Studio's copy into it) needs from the vault, beyond reading and stamping. */
export interface NoteEditPort {
  /** Notes whose `blyg_id` property is `id` (any route, any origin: the caller judges). */
  notesWithBlygId(id: string): NoteRef[];
  /** How a link to `note` is written from `fromPath`: its name, or its path when the name is ambiguous. */
  linkText(note: NoteRef, fromPath: string): string;
  /** Replace the text after the frontmatter with `replacement`, atomically. Throws, changing nothing, when that text is no longer `expected`. */
  replaceBody(note: NoteRef, expected: string, replacement: string): Promise<void>;
}

export interface VaultPort {
  read(note: NoteRef): Promise<string>;
  /** `blyg_id` from the note's frontmatter, as the metadata cache has it (any type: it is user-editable). */
  blygId(note: NoteRef): unknown;
  /** Any frontmatter value of the note, as the metadata cache has it (user-editable: treat as untrusted). */
  frontmatterValue(note: NoteRef, key: string): unknown;
  /** The vault note a wikilink target points at, seen from `fromPath` (Obsidian's own link resolution), or null. */
  resolveLink(target: string, fromPath: string): { path: string; extension: string } | null;
  /** Rewrite the note's frontmatter in place; the body is never touched. */
  updateFrontmatter(note: NoteRef, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
}
