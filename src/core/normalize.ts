// Text normalisation shared with the site: normalizeContentMd must equal `normalizeContentMd` in the site's
// src/lib/blyg.ts byte for byte, or CI fails on a hash mismatch (docs/CONTRACT.md §3.1).

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** content_md: line endings → LF, then trimmed (String.prototype.trim: also NBSP and BOM). */
export function normalizeContentMd(body: string): string {
  return normalizeLineEndings(body).trim();
}
