import type { Yaml } from "../platform/ports";
import type { Route } from "../settings/schema";
import { stripObsidianComments } from "./comments";
import { extractFrontmatterBlock, isRecord } from "./frontmatter";
import { contentHash } from "./hash";
import { normalizeLineEndings } from "./normalize";

const FRONTMATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;

export type PlainCommitText =
  | { ok: true; /** the exact text a publish commits */ text: string; /** the body without the frontmatter, comments removed */ body: string; removed: number }
  | { ok: false; line: number };

/**
 * What a plain-route publish commits for a note: line endings to LF, the frontmatter as it is, `%%` comments stripped from
 * the body only. One function for the publish and for the panel, so "in sync" can only mean "a publish would send the same text".
 * An unclosed comment is `ok: false` (the rest of the note might be private).
 */
export function plainCommitText(rawNote: string): PlainCommitText {
  const original = normalizeLineEndings(rawNote);
  const head = FRONTMATTER.exec(original)?.[0] ?? "";
  const stripped = stripObsidianComments(original.slice(head.length));
  if (!stripped.ok) return { ok: false, line: stripped.line };
  return { ok: true, text: head + stripped.text, body: stripped.text, removed: stripped.removed };
}

/** Trailing whitespace on every line and at the end of the file does not count (the R2 rule; see `plainTextsEquivalent`). */
export function squashPlain(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trimEnd();
}

/** Fingerprint of a plain file's text under the same equivalence the publish uses for "No changes". */
export function plainSyncHash(text: string): Promise<string> {
  return contentHash(squashPlain(text));
}

export interface PlainValidation {
  /** Block the publish. */
  errors: string[];
  /** Shown after a successful publish. */
  warnings: string[];
}

/** Checks a plain-route note before any network call (ported from the macro, which ported it from sync-content.sh). */
export function validatePlain(text: string, route: Pick<Route, "requireTitle">, yaml: Yaml): PlainValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const block = extractFrontmatterBlock(text);
  if (/^---[ \t]*\n/.test(text) && block === null) {
    errors.push("The frontmatter opens with --- but never closes.");
  }
  let fm: unknown = null;
  if (block !== null) {
    // An unquoted value containing ": " breaks the YAML parser used by the site build.
    for (const line of block.split("\n")) {
      const m = /^([A-Za-z_-]+):[ \t]+(.*)$/.exec(line);
      if (m && !/^["']/.test(m[2] ?? "") && (m[2] ?? "").includes(": ")) {
        errors.push(`Unquoted value containing a colon (${line.slice(0, 60)}) — wrap the value in double quotes.`);
      }
    }
    if (errors.length === 0) {
      try {
        fm = yaml.parse(block);
      } catch (err) {
        errors.push(`The frontmatter is not valid YAML (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
  }
  if (isRecord(fm) && "blyg_id" in fm) {
    errors.push("This note carries Blyg fields (blyg_id) — it belongs in website/blyg/, not here.");
  }
  if (route.requireTitle && !(isRecord(fm) && fm.title)) {
    warnings.push("no title: in the frontmatter — the page will show its slug as the heading.");
  }
  return { errors, warnings };
}

/**
 * "Nothing to publish" test for plain files. Line endings are always ignored. With `ignoreTrailingWhitespace`
 * (the R2 wishlist rule, off at parity) trailing whitespace on every line and at the end of the file is ignored too,
 * so three taps on a note that only gained a trailing space make one deploy, not three.
 */
export function plainTextsEquivalent(
  local: string,
  committed: string,
  options: { ignoreTrailingWhitespace: boolean },
): boolean {
  const a = normalizeLineEndings(local);
  const b = normalizeLineEndings(committed);
  if (!options.ignoreTrailingWhitespace) return a === b;
  return squashPlain(a) === squashPlain(b);
}

/** `![[name.ext]]` image embeds, lowercased and de-duplicated (the site looks attachments up lowercased). */
export function embeddedImages(text: string): string[] {
  const wanted = new Set<string>();
  for (const m of text.matchAll(/!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg))\]\]/gi)) {
    wanted.add((m[1] ?? "").toLowerCase());
  }
  return [...wanted];
}
