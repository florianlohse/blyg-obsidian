// The map of reposted items that the S3 redirect rules are written from (roadmap S3.1).
import { describe, expect, it } from "vitest";
import { studioAddress } from "../../src/studio/address";
import { repostMap, repostMapText } from "../../src/studio/repostMap";

const address = studioAddress({ baseUrl: "https://blyg.example.com", mount: "" });
if (!address) throw new Error("test address");
const OLD = "12jdqbj03qfpq4z5hgyggaetm4";
const NEW = "a0000000000000000000000001";
const OLD_T = "dq6263yx1daeym5dx8p1byfdz8";
const NEW_T = "a0000000000000000000000002";

describe("repostMap", () => {
  const notes = [
    { name: "Thread", frontmatter: { blyg_origin: "https://blyg.example.com/", blyg_id: NEW_T, blyg_kind: "thread", blyg_url: `https://blyg.example.com/t/${NEW_T}/`, blyg_previous: { origin: "https://old.example.com/blyg/", id: OLD_T, version: 5, url: `https://old.example.com/blyg/t/${OLD_T}/`, withdrawn: true } } },
    { name: "A fragment", frontmatter: { blyg_origin: "https://blyg.example.com", blyg_id: NEW, blyg_previous: { id: OLD, version: 2 } } },
    { name: "Never reposted", frontmatter: { blyg_origin: "https://blyg.example.com/", blyg_id: "a0000000000000000000000003" } },
    { name: "Old record only", frontmatter: { blyg_id: OLD } },
    { name: "Another Studio", frontmatter: { blyg_origin: "https://elsewhere.example/", blyg_id: NEW, blyg_previous: { id: OLD } } },
    { name: "Damaged", frontmatter: { blyg_origin: "https://blyg.example.com/", blyg_id: NEW, blyg_previous: { id: "nope" } } },
  ];

  it("lists the notes of this Studio that carry an old record, sorted by name, with both page addresses", () => {
    const lines = repostMap(notes, address, "https://old.example.com/blyg/");
    expect(lines).toEqual([
      { kind: "fragment", oldId: OLD, newId: NEW, oldPage: `https://old.example.com/blyg/f/${OLD}/`, newPage: `https://blyg.example.com/f/${NEW}/`, name: "A fragment" },
      { kind: "thread", oldId: OLD_T, newId: NEW_T, oldPage: `https://old.example.com/blyg/t/${OLD_T}/`, newPage: `https://blyg.example.com/t/${NEW_T}/`, name: "Thread" },
    ]);
  });

  it("says plainly when the old address is not known", () => {
    const lines = repostMap([notes[1] as (typeof notes)[number]], address, "");
    expect(lines[0]?.oldPage).toBeNull();
    expect(repostMapText(lines, address.origin)).toContain(`fragment ${OLD} ${NEW} - https://blyg.example.com/f/${NEW}/ # A fragment`);
  });

  it("gives a header and one line per item, the note name last", () => {
    const text = repostMapText(repostMap(notes, address, "https://old.example.com/blyg/"), address.origin);
    const rows = text.split("\n");
    expect(rows[0]).toMatch(/^# Reposted items: kind old-id new-id old-page new-page # note name\. Studio https:\/\/blyg\.example\.com\/$/);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toBe(`thread ${OLD_T} ${NEW_T} https://old.example.com/blyg/t/${OLD_T}/ https://blyg.example.com/t/${NEW_T}/ # Thread`);
  });

  it("is empty when nothing was reposted", () => {
    expect(repostMap([notes[2] as (typeof notes)[number], notes[3] as (typeof notes)[number]], address, "")).toEqual([]);
  });
});
