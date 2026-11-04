import { describe, expect, it } from "vitest";
import { fromBase64Utf8, sha256Hex, toBase64Utf8 } from "../../src/core/hash";
import { BLYG_ID_PATTERN, CROCKFORD_ALPHABET, isBlygId, mintBlygId } from "../../src/core/ids";

const fixed = (bytes: number[]) => ({ bytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => bytes[i % bytes.length] ?? 0) });

describe("mintBlygId", () => {
  it("is 26 lowercase Crockford characters", () => {
    for (let seed = 0; seed < 50; seed++) {
      const id = mintBlygId(fixed([seed * 5 + 1, seed * 11 + 3, 255 - seed]));
      expect(id).toHaveLength(26);
      expect([...id].every((c) => CROCKFORD_ALPHABET.includes(c))).toBe(true);
      expect(isBlygId(id)).toBe(true);
    }
  });

  it("encodes known byte patterns (5 bits per character, last character zero-padded)", () => {
    expect(mintBlygId(fixed([0]))).toBe("0".repeat(26));
    // 16 bytes of 0xff: 25 full 5-bit groups of ones ("z") and a last group holding 3 ones + 2 zero-padding bits (11100 = 28 = "w").
    expect(mintBlygId(fixed([255]))).toBe("z".repeat(25) + "w");
  });

  it("uses the random source for all 128 bits (different bytes, different id)", () => {
    expect(mintBlygId(fixed([1, 2, 3]))).not.toBe(mintBlygId(fixed([1, 2, 4])));
  });

  it("asks for exactly 16 bytes", () => {
    let asked = 0;
    mintBlygId({ bytes: (n) => ((asked = n), new Uint8Array(n)) });
    expect(asked).toBe(16);
  });
});

describe("isBlygId", () => {
  it("accepts minted ids and rejects anything that could be misused as a path", () => {
    expect(isBlygId("7c9wk2mhq0v3xj8tn5rzfd41bg")).toBe(true);
    for (const bad of ["", "short", "../../etc/passwd", "7c9wk2mhq0v3xj8tn5rzfd41b/", "7C9WK2MHQ0V3XJ8TN5RZFD41BG", "7c9wk2mhq0v3xj8tn5rzfd41bi", "7c9wk2mhq0v3xj8tn5rzfd41bg1", 12, null, undefined, {}]) {
      expect(isBlygId(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(BLYG_ID_PATTERN.test("i".repeat(26))).toBe(false); // i, l, o, u are not in the alphabet
  });
});

describe("hash and base64", () => {
  it("sha256Hex matches the known test vectors", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("round-trips UTF-8 through base64 (btoa alone is Latin-1 only)", () => {
    for (const text of ["", "plain", "Prüfung: Äöü ß — 🌿", "line\r\nbreaks\n"]) {
      expect(fromBase64Utf8(toBase64Utf8(text))).toBe(text);
    }
    expect(toBase64Utf8("ü")).toBe("w7w=");
  });

  it("decodes base64 with the line breaks GitHub inserts", () => {
    expect(fromBase64Utf8("w7w=\n")).toBe("ü");
    expect(fromBase64Utf8("aGVs\nbG8=\n")).toBe("hello");
  });
});
