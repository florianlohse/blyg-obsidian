// Blyg ids (spec §5.1): 128 random bits as 26 lowercase Crockford base32 characters, no padding.
import type { Random } from "../platform/ports";

export const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Exactly what a minted id looks like. Anything else is never used to build a repo path. */
export const BLYG_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;

export function isBlygId(value: unknown): value is string {
  return typeof value === "string" && BLYG_ID_PATTERN.test(value);
}

/** 128 random bits → 26 chars of 5-bit groups (128/5 = 25.6: the last char carries two zero padding bits). */
export function mintBlygId(random: Random): string {
  const bytes = random.bytes(16);
  let buffer = 0;
  let bitsInBuffer = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      output += CROCKFORD_ALPHABET[(buffer >>> bitsInBuffer) & 0x1f];
    }
  }
  if (bitsInBuffer > 0) {
    output += CROCKFORD_ALPHABET[(buffer << (5 - bitsInBuffer)) & 0x1f];
  }
  return output;
}
