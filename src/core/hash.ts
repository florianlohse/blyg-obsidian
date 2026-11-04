// Hashing and base64 (Web APIs only: they exist on mobile).

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** `blyg_hash`: "sha256:" + hex(SHA-256(content_md as UTF-8)). Contract §3.1. */
export async function contentHash(contentMd: string): Promise<string> {
  return `sha256:${await sha256Hex(contentMd)}`;
}

/** sha256(""): the endcap's hash (spec §9: a withdrawn item has empty content). */
export const EMPTY_CONTENT_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// btoa()/atob() only handle Latin-1, so go through UTF-8 bytes.
export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\s/g, ""));
  return new TextDecoder("utf-8").decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
