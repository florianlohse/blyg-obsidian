// E1: the plugin speaks contract 5 and 6 side by side. This is the structural check behind that claim: for EVERY operation src/studio/client.ts calls
// (the operations test only covers those the fake Studio serves), the vendored Studio 0.69.0 file (contract 6.2.0) must differ from the 0.51.0 file
// (contract 5.2.0) only by additions, with the one removal announced in contract 6.0.0 (`GET /changes`) named here and nowhere else.
// "Additive": no operation or parameter gone, no parameter or request field newly required, no field gone from an answer or a request, no enum value
// gone, no type changed. (A new field in an answer, a new optional field in a request, a new enum value in an answer are additions.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const load = (file: string): Obj => JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8")) as Obj;
const v5 = load("studio-openapi-0.51.0.json");
const v6 = load("studio-openapi-0.69.0.json");

/** Every operation src/studio/client.ts calls: method and path (path parameters unnamed; the two files name them differently). */
const CALLED: Array<[string, string]> = [
  ["get", "/capabilities"], ["get", "/items"], ["get", "/items/summary"], ["get", "/items/{}"], ["post", "/items"], ["patch", "/items/{}"], ["delete", "/items/{}"],
  ["post", "/items/{}/publish"], ["post", "/items/{}/withdraw"], ["post", "/media"], ["post", "/preview"], ["get", "/search"],
  ["get", "/imports/{}/{}"], ["get", "/reading"], ["get", "/reading/imported"], ["put", "/reading/{}/{}/read"], ["delete", "/reading/{}/{}/read"],
  ["get", "/mentions"], ["patch", "/mentions/{}"], ["post", "/subscriptions/poll"], ["post", "/subscriptions/{}/resync"], ["get", "/changes"],
  ["post", "/peek/links"], ["get", "/peek"], ["get", "/subscriptions"], ["post", "/subscriptions"], ["get", "/subscriptions/{}"], ["patch", "/subscriptions/{}"],
  ["delete", "/subscriptions/{}"], ["get", "/hoppers"], ["get", "/hoppers/{}/memberships"], ["put", "/hoppers/{}/items/{}/{}"], ["delete", "/hoppers/{}/items/{}/{}"],
];
/** Contract 6.0.0 (Studio 0.67.0) removed exactly this, and said so. */
const REMOVED_IN_6: Array<[string, string]> = [["get", "/changes"]];

/** SH1: operations only a newer Studio has (the shelf, Studio 0.61 and later). The client calls them only when the Studio's own `GET /capabilities` lists them (`getShelf`, `putShelf`), so a Studio without them is never asked. */
const GATED: Array<[string, string]> = [["get", "/shelf"], ["put", "/shelf"]];

const norm = (path: string): string => path.replace(/\{[^}]+\}/g, "{}");
const isObj = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function resolve(doc: Obj, node: Json | undefined, seen: string[] = []): Json | undefined {
  if (isObj(node) && typeof node.$ref === "string") {
    if (seen.includes(node.$ref)) return { $cycle: node.$ref };
    let at: Json | undefined = doc;
    for (const part of node.$ref.slice(2).split("/")) at = isObj(at) ? at[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    return resolve(doc, at, [...seen, node.$ref]);
  }
  if (Array.isArray(node)) return node.map((n) => resolve(doc, n, seen) as Json);
  if (isObj(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(doc, v, seen) as Json]));
  return node;
}

function operation(doc: Obj, method: string, path: string): Obj | null {
  const paths = doc.paths as Obj;
  const key = Object.keys(paths).find((p) => norm(p) === path);
  const op = key === undefined ? undefined : (paths[key] as Obj)[method];
  return isObj(op) ? (resolve(doc, op) as Obj) : null;
}

/** What got worse between two schemas, as readable lines. `side`: a request may not gain required fields; an answer may not lose them. */
function worse(a: Json | undefined, b: Json | undefined, at: string, side: "request" | "answer", out: string[]): void {
  if (!isObj(a) || !isObj(b)) return;
  if (a.type !== undefined && JSON.stringify(a.type) !== JSON.stringify(b.type)) out.push(`${at}: type ${JSON.stringify(a.type)} became ${JSON.stringify(b.type)}`);
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) for (const v of a.enum) if (!b.enum.includes(v)) out.push(`${at}: enum value ${JSON.stringify(v)} is gone`);
  const pa = isObj(a.properties) ? a.properties : {};
  const pb = isObj(b.properties) ? b.properties : {};
  for (const k of Object.keys(pa)) {
    if (!(k in pb)) out.push(`${at}.${k}: field is gone`);
    else worse(pa[k], pb[k], `${at}.${k}`, side, out);
  }
  if (side === "request") {
    const was = new Set(Array.isArray(a.required) ? a.required : []);
    for (const k of Array.isArray(b.required) ? b.required : []) if (!was.has(k)) out.push(`${at}.${k as string}: is now required`);
  }
  for (const key of ["items", "additionalProperties"] as const) worse(a[key], b[key], `${at}[${key}]`, side, out);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const la = a[key];
    const lb = b[key];
    if (Array.isArray(la) && Array.isArray(lb)) la.forEach((x, i) => worse(x, lb[i], `${at}.${key}[${i}]`, side, out));
  }
}

function breakages(method: string, path: string): string[] {
  const a = operation(v5, method, path);
  const b = operation(v6, method, path);
  if (a === null) return [`${method} ${path}: not in the contract 5 file (the list above is wrong)`];
  if (b === null) return [`${method} ${path}: not in the contract 6 file`];
  const out: string[] = [];
  const params = (op: Obj): Map<string, Obj> => new Map((Array.isArray(op.parameters) ? op.parameters : []).filter(isObj).map((p): [string, Obj] => [`${String(p.in as string)}:${String(p.name as string)}`, p]));
  const pa = params(a);
  const pb = params(b);
  for (const k of pa.keys()) if (!pb.has(k)) out.push(`parameter ${k} is gone`);
  for (const [k, p] of pb) if (!pa.has(k) && p.required === true) out.push(`parameter ${k} is new and required`);
  for (const [k, p] of pa) {
    const q = pb.get(k);
    if (q) worse(p.schema, q.schema, `parameter ${k}`, "request", out);
  }
  const body = (op: Obj): Json | undefined => (isObj(op.requestBody) && isObj(op.requestBody.content) ? (op.requestBody.content["application/json"] as Obj | undefined)?.schema : undefined);
  if (body(a) !== undefined && body(b) === undefined) out.push("the request body is gone");
  worse(body(a), body(b), "request", "request", out);
  const answers = (op: Obj): Obj => (isObj(op.responses) ? op.responses : {});
  for (const [status, ra] of Object.entries(answers(a))) {
    const rb = answers(b)[status];
    if (rb === undefined) {
      out.push(`answer ${status} is gone`);
      continue;
    }
    const schema = (r: Json | undefined): Json | undefined => (isObj(r) && isObj(r.content) ? (r.content["application/json"] as Obj | undefined)?.schema : undefined);
    worse(schema(ra), schema(rb), `answer ${status}`, "answer", out);
  }
  return out;
}

describe("contract 6.2.0 against contract 5.2.0, for every operation the client calls", () => {
  it("the list is not stale: every operation client.ts names is in it", () => {
    const client = readFileSync(new URL("../../src/studio/client.ts", import.meta.url), "utf8");
    const named = new Set([...CALLED, ...GATED].map(([, p]) => p.split("/")[1]));
    for (const m of client.matchAll(/area: "api", path: [`"]\/([a-z-]+)/g)) expect(named.has(m[1] ?? ""), `/${m[1]} is called by client.ts but not listed here`).toBe(true);
    for (const m of client.matchAll(/walk\(`?"?\/([a-z-]+)/g)) expect(named.has(m[1] ?? ""), `/${m[1]} is walked by client.ts but not listed here`).toBe(true);
  });

  it("the shelf operations are not in the contract 5 file, are in the 6.2 file, and the client asks the Studio's list first (SH1)", () => {
    for (const [m, p] of GATED) {
      expect(operation(v5, m, p), `${m} ${p} in the 0.51.0 file`).toBeNull();
      expect(operation(v6, m, p), `${m} ${p} in the 0.69.0 file`).not.toBeNull();
    }
    const client = readFileSync(new URL("../../src/studio/client.ts", import.meta.url), "utf8");
    expect(client).toMatch(/getShelf: async[\s\S]{0,200}offers\(gateCache\.get\(\), SHELF_OPERATIONS\.get\)/);
    expect(client).toMatch(/putShelf: async[\s\S]{0,400}offers\(verdict, SHELF_OPERATIONS\.put\)/);
  });

  it("the only operation gone is GET /changes (announced in 6.0.0)", () => {
    const gone = CALLED.filter(([m, p]) => operation(v5, m, p) !== null && operation(v6, m, p) === null);
    expect(gone).toEqual(REMOVED_IN_6);
  });

  it.each(CALLED.filter(([m, p]) => !REMOVED_IN_6.some(([rm, rp]) => rm === m && rp === p)))("%s %s changed by additions only", (method, path) => {
    expect(breakages(method, path)).toEqual([]);
  });

  it("the check can fail: a made-up removal is seen", () => {
    const a = { type: "object", properties: { x: { type: "string", enum: ["a", "b"] }, y: { type: "number" } }, required: ["x"] } as Json;
    const b = { type: "object", properties: { x: { type: "string", enum: ["a"] } }, required: ["x", "z"] } as Json;
    const out: string[] = [];
    worse(a, b, "request", "request", out);
    expect(out).toEqual(['request.x: enum value "b" is gone', "request.y: field is gone", "request.z: is now required"]);
  });
});
