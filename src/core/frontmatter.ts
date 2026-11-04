import type { Yaml } from "../platform/ports";

export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

/** The text with its body (everything after the frontmatter block) replaced, or null when the body is not `expected` (the note changed meanwhile). */
export function swapBody(raw: string, expected: string, replacement: string): string | null {
  const body = stripFrontmatter(raw);
  if (body !== expected) return null;
  return raw.slice(0, raw.length - body.length) + replacement;
}

/** The text between the two `---` lines, or null if the text has no complete frontmatter block. */
export function extractFrontmatterBlock(raw: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  return match ? (match[1] ?? "") : null;
}

/**
 * A Blyg item file: frontmatter, blank line, body, newline. `extraYaml` is ready-made YAML appended to the frontmatter (a thread's
 * `blyg_sources` / `blyg_links`, written by `core/sources.ts`: long double-quoted strings the YAML library must not reformat).
 */
export function buildBlygFileText(yaml: Yaml, frontmatter: Record<string, unknown>, contentMd: string, extraYaml = ""): string {
  return `---\n${yaml.stringify(frontmatter).trimEnd()}\n${extraYaml}---\n\n${contentMd}\n`;
}

/** A withdrawal endcap: frontmatter only, empty body (spec §9). `extraYaml` as above (a thread's `blyg_sources: []`). */
export function buildEndcapFileText(yaml: Yaml, frontmatter: Record<string, unknown>, extraYaml = ""): string {
  return `---\n${yaml.stringify(frontmatter).trimEnd()}\n${extraYaml}---\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
