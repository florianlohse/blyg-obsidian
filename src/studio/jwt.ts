// A Studio's manual token is a JWT. Its expiry is in the payload (`exp`, seconds since 1970), so the plugin can warn before the
// 30 days are up without any setting and without asking the Studio. This reads the payload; it does NOT verify the signature (the
// plugin cannot, and does not need to: the Studio verifies the token on every request). Nothing here is ever logged.

function payloadOf(token: string): Record<string, unknown> | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const payload = JSON.parse(new TextDecoder("utf-8").decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))) as unknown;
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The token's expiry as a Date, or null when it is not a JWT with a numeric `exp`. */
export function tokenExpiry(token: string): Date | null {
  const exp = payloadOf(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000) : null;
}

/** The permissions the token was minted with (`scope`, space separated), or null when it is not a JWT that says. */
export function tokenScopes(token: string): string[] | null {
  const scope = payloadOf(token)?.scope;
  return typeof scope === "string" ? scope.split(/\s+/).filter((s) => s !== "") : null;
}

export type ExpiryVerdict = { kind: "unknown" } | { kind: "ok"; days: number } | { kind: "soon"; days: number } | { kind: "expired" };

/** `soon` from five days before the end: a token is minted by hand each month, so the warning must come while it still works. */
export function expiryVerdict(token: string, now: Date, warnDays = 5): ExpiryVerdict {
  const at = tokenExpiry(token);
  if (!at) return { kind: "unknown" };
  const days = Math.floor((at.getTime() - now.getTime()) / 86_400_000);
  if (at.getTime() <= now.getTime()) return { kind: "expired" };
  return days <= warnDays ? { kind: "soon", days } : { kind: "ok", days };
}
