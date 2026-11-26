// HK3: the groups of the Reception section: a fixed order, only the non-empty ones, a reply is a reply wherever its quote sits.
import { describe, expect, it } from "vitest";
import { groupOf, groupReception } from "../../src/marginalia/groups";
import type { MarginaliaMention } from "../../src/marginalia/lookup";
import type { Placement, ReceptionRow } from "../../src/marginalia/reception";

const mention = (id: string, relation: MarginaliaMention["relation"] = "transclusion"): MarginaliaMention => ({ id, targetItemId: "t", relation, status: "verified", hidden: false, sourceOrigin: "https://b.example/", sourceId: id, sourcePage: null, sourceAuthorName: id, firstSeen: "2026-11-10T00:00:00Z" });
const row = (id: string, placement: Placement, relation: MarginaliaMention["relation"] = "transclusion"): ReceptionRow => ({ mention: mention(id, relation), placement, excerpt: null });

describe("groupReception", () => {
  const rows = [
    row("kai", { kind: "unknown", reason: "unreadable" }),
    row("ed", { kind: "earlier" }),
    row("ana", { kind: "reply" }, "stub"),
    row("jo", { kind: "paragraph", index: 0, method: "exact" }, "stub"),
    row("mira", { kind: "whole" }),
    row("teo", { kind: "paragraph", index: 1, method: "exact" }),
  ];
  it("puts the groups in the fixed order and keeps each group's rows in the order given", () => {
    expect(groupReception(rows).map((g) => [g.id, g.rows.map((r) => r.mention.id)])).toEqual([["paragraph", ["teo"]], ["whole", ["mira"]], ["replies", ["ana", "jo"]], ["earlier", ["ed"]], ["unknown", ["kai"]]]);
  });
  it("titles are the words the section shows", () => {
    expect(groupReception(rows).map((g) => g.title)).toEqual(["Quoted a paragraph", "Quoted the whole note", "Replies", "From an earlier version", "Could not be read"]);
  });
  it("leaves out groups with no rows, and an empty list gives none", () => {
    expect(groupReception([rows[4]!]).map((g) => g.id)).toEqual(["whole"]);
    expect(groupReception([])).toEqual([]);
  });
  it("a reply that quotes older wording is still a reply; an unreadable reply stays unreadable", () => {
    expect(groupOf(row("x", { kind: "earlier" }, "stub"))).toBe("replies");
    expect(groupOf(row("y", { kind: "unknown", reason: "no-text" }, "stub"))).toBe("unknown");
  });
});
