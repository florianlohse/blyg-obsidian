// Contract 7 (Studio 0.73.0 = 7.0.0, 0.73.1 = 7.1.0): what changed, for the operations src/studio/client.ts calls, against Studio 0.69.0 (contract 6.2.0).
// Named here so a change that is not in this list fails the test instead of passing unseen: provenance is gone from item create and edit (the client never
// sent it), the item status gains `private` (the client refuses such an item), everything else is additive.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Op { operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean }>; requestBody?: { content: { "application/json"?: { schema: Schema } } } }
interface Schema { properties?: Record<string, unknown>; required?: string[]; anyOf?: Schema[]; enum?: string[] }
interface Spec { info: { version: string }; paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, Schema> } }
const load = (f: string): Spec => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8")) as Spec;
const v6 = load("studio-openapi-0.69.0.json");
const v7 = load("studio-openapi-0.73.1.json");

const CALLED: Array<[string, string]> = [
  ["get", "/capabilities"], ["get", "/items"], ["get", "/items/summary"], ["get", "/items/{id}"], ["post", "/items"], ["patch", "/items/{id}"], ["delete", "/items/{id}"],
  ["post", "/items/{id}/publish"], ["post", "/items/{id}/withdraw"], ["post", "/media"], ["post", "/preview"], ["get", "/search"],
  ["get", "/reading"], ["get", "/reading/imported"], ["get", "/mentions"], ["post", "/subscriptions/poll"], ["post", "/peek/links"], ["get", "/peek"],
  ["get", "/subscriptions"], ["post", "/subscriptions"], ["get", "/hoppers"], ["get", "/hoppers/{id}/memberships"], ["get", "/shelf"], ["put", "/shelf"],
];
const norm = (p: string): string => p.replace(/\{[^}]+\}/g, "{id}");
function find(spec: Spec, method: string, path: string): Op | null {
  for (const [p, ops] of Object.entries(spec.paths)) if (norm(p) === norm(path) && ops[method]) return ops[method] ?? null;
  return null;
}
const bodyKeys = (op: Op): string[] => {
  const s = op.requestBody?.content["application/json"]?.schema;
  return s ? (s.anyOf ? s.anyOf.flatMap((x) => Object.keys(x.properties ?? {})) : Object.keys(s.properties ?? {})) : [];
};

describe("contract 7 against contract 6.2, for the operations the client calls", () => {
  it("the file is Studio 0.73.1's (contract 7.1.0)", () => {
    expect(v7.info.version).toBe("7.1.0");
    expect(v6.info.version).toBe("6.2.0");
  });
  it("every called operation still exists, and no query parameter is newly required", () => {
    for (const [m, p] of CALLED) {
      const a = find(v6, m, p);
      const b = find(v7, m, p);
      expect(b, `${m} ${p} in 7.1`).not.toBeNull();
      if (!a || !b) continue;
      const was = new Set((a.parameters ?? []).map((x) => `${x.in}:${x.name}`));
      for (const x of b.parameters ?? []) if (x.required === true) expect(was.has(`${x.in}:${x.name}`), `${m} ${p} parameter ${x.name}`).toBe(true);
    }
  });
  it("request fields: only `provenance` is gone (from item create and edit); `visibility` is new on publish", () => {
    const gone: string[] = [];
    for (const [m, p] of CALLED) {
      const a = find(v6, m, p);
      const b = find(v7, m, p);
      if (!a || !b) continue;
      const now = new Set(bodyKeys(b));
      for (const k of bodyKeys(a)) if (!now.has(k)) gone.push(`${m} ${p} ${k}`);
    }
    expect(gone.sort()).toEqual(["patch /items/{id} provenance", "post /items provenance"]);
    expect(bodyKeys(find(v7, "post", "/items/{id}/publish")!)).toContain("visibility");
    expect(bodyKeys(find(v6, "post", "/items/{id}/publish")!)).not.toContain("visibility");
  });
  it("the item status gains `private`, and nothing else in it", () => {
    const was = v6.components.schemas.Item?.properties?.status as Schema;
    const now = v7.components.schemas.Item?.properties?.status as Schema;
    expect(now.enum).toEqual(["draft", "public", "private", "withdrawn"]);
    expect(was.enum).toEqual(["draft", "public", "withdrawn"]);
  });
  it("the item fields the client reads are still required in an item", () => {
    const req = v7.components.schemas.Item?.required ?? [];
    for (const k of ["id", "revision", "kind", "status", "version", "contentMd", "dirty"]) expect(req).toContain(k);
  });
});
