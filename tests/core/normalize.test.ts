import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentHash, EMPTY_CONTENT_HASH } from "../../src/core/hash";
import { normalizeContentMd } from "../../src/core/normalize";

interface Case {
  name: string;
  input: string;
  content_md: string;
  hash: string;
}
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/normalize.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("shared normalisation fixtures (must also hold in the site's normalizeContentMd)", () => {
  for (const c of fixtures.cases) {
    it(c.name, async () => {
      expect(normalizeContentMd(c.input)).toBe(c.content_md);
      expect(await contentHash(c.content_md)).toBe(c.hash);
    });
  }

  it("the withdrawal endcap hash is the hash of empty content", async () => {
    expect(await contentHash("")).toBe(EMPTY_CONTENT_HASH);
  });

  it("covers the awkward inputs", () => {
    const names = fixtures.cases.map((c) => c.name).join("|");
    for (const needle of ["CRLF", "umlauts", "emoji", "NBSP", "NFD", "empty"]) expect(names).toContain(needle);
  });
});
