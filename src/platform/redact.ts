// Redaction (docs/SECURITY.md §1): a credential must never reach a log, a notice or an error message.

const KNOWN_TOKEN_SHAPES: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // The Studio's access token is a JWT (three base64url parts, the first two start with "eyJ"). Covered by shape too, because the logger does not know it.
  /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g,
];

export const REDACTED = "[redacted]";

/**
 * Remove the given secrets and anything shaped like a GitHub token or Authorization value from `text`.
 * Secrets shorter than 6 characters are ignored to avoid mangling ordinary text.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const shape of KNOWN_TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

export function redactingLogger(
  sink: (line: string) => void,
  secrets: () => readonly string[] = () => [],
): { debug(message: string): void; warn(message: string): void } {
  return {
    debug: (m) => sink(`[blyg] ${redact(m, secrets())}`),
    warn: (m) => sink(`[blyg] warning: ${redact(m, secrets())}`),
  };
}
