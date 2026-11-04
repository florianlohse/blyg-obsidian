import type { Keychain } from "./ports";

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "keychain-unavailable" | "no-secret-name" | "secret-missing"; message: string };

/**
 * Read the GitHub token from the keychain. There is deliberately no plaintext fallback (docs/SECURITY.md §1): if
 * the keychain is unavailable or the entry is empty, the caller must stop and tell the user why.
 */
export function readToken(keychain: Keychain, secretName: string, what: "GitHub" | "Studio" = "GitHub"): TokenResult {
  if (!keychain.available()) {
    return {
      ok: false,
      reason: "keychain-unavailable",
      message: "This Obsidian version has no keychain. Update Obsidian to 1.11.4 or newer.",
    };
  }
  if (secretName === "") {
    return {
      ok: false,
      reason: "no-secret-name",
      message: `No ${what} token chosen yet. In the plugin settings, pick or create a keychain entry.`,
    };
  }
  const token = keychain.get(secretName);
  if (token === null || token.trim() === "") {
    return {
      ok: false,
      reason: "secret-missing",
      message: `The keychain entry “${secretName}” is empty on this device. Open the plugin settings and enter the token again (keychain entries are not synced between devices).`,
    };
  }
  return { ok: true, token };
}
