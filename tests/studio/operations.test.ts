// The operation-level test of S16 (docs/plans/S16-contract-5.md §3.5): for every operation the client calls, each request it builds
// (body with `additionalProperties: false`, query names, path) is valid against the Studio 0.51.0 OpenAPI file, and each answer the fake Studio
// gives is valid against that operation's response schema. This is what would have caught the contract-5 break before any user did.
// Validation runs on the real client driving the fake over its real http adapter.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { idleTimers } from "../helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN, type Seen } from "./fake-studio";

interface Operation {
  parameters?: Array<{ name: string; in: string; $ref?: string }>;
  requestBody?: { content: { "application/json": { schema: unknown } } };
  responses: Record<string, { content?: { "application/json": { schema: unknown } } }>;
}
const spec = JSON.parse(readFileSync(new URL("../fixtures/studio-openapi-0.51.0.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, Operation>> };

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(spec, "studio");
const pointer = (parts: string[]): string => `studio#/${parts.map((p) => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;

/** The operation (path template and method) a request belongs to, by matching its path against the file's templates. */
function operationOf(seen: Seen): { template: string; op: Operation } | null {
  const path = seen.path.split("?")[0]?.replace(/^\/api/, "") ?? "";
  // literal templates win over templated ones ("/items/summary" before "/items/{id}")
  const templates = Object.keys(spec.paths).sort((a, b) => (a.includes("{") ? 1 : 0) - (b.includes("{") ? 1 : 0) || b.length - a.length);
  for (const template of templates) {
    const re = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`);
    const op = spec.paths[template]?.[seen.method.toLowerCase()];
    if (re.test(path) && op) return { template, op };
  }
  return null;
}

function validate(ref: string, value: unknown): string[] {
  const fn = ajv.getSchema(ref);
  if (!fn) throw new Error(`no schema at ${ref}`);
  return fn(value) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`);
}

function checkSeen(seen: Seen): { key: string; problems: string[] } {
  const found = operationOf(seen);
  const key = `${seen.method} ${seen.path.split("?")[0]}`;
  if (!found) return { key, problems: ["no such operation in the 0.51.0 file"] };
  const problems: string[] = [];
  const { template, op } = found;
  const method = seen.method.toLowerCase();
  // request body
  if (op.requestBody) {
    if (seen.body === undefined) problems.push("the operation needs a body and none was sent");
    else problems.push(...validate(pointer(["paths", template, method, "requestBody", "content", "application/json", "schema"]), seen.body).map((p) => `request body: ${p}`));
  } else if (seen.body !== undefined) problems.push("a body was sent to an operation that takes none");
  // query names
  const declared = new Set((op.parameters ?? []).map((p) => (p.$ref ? p.$ref : p.name)));
  for (const name of new URL(seen.path, "https://x.test").searchParams.keys()) if (!declared.has(name)) problems.push(`query parameter ${name} is not declared`);
  // answer
  const status = String(seen.status);
  const schema = op.responses[status]?.content?.["application/json"]?.schema;
  if (schema === undefined) problems.push(`status ${status} is not a documented JSON answer`);
  else problems.push(...validate(pointer(["paths", template, method, "responses", status, "content", "application/json", "schema"]), seen.answer).map((p) => `answer ${status}: ${p}`));
  return { key, problems };
}

function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return { studio, client };
}

describe("the fixtures", () => {
  it("studio-openapi-0.49.1.json stays as the documented last contract-4 file (release SHA256SUMS)", () => {
    const text = readFileSync(new URL("../fixtures/studio-openapi-0.49.1.json", import.meta.url));
    expect(createHash("sha256").update(text).digest("hex")).toBe("2ec3063fa9f578a2112293680d431727b5377f0905faa6139b7f0f1b04fb33d1");
  });
});

describe("every operation the client calls, against the Studio 0.51.0 file", () => {
  // The client's whole surface, in one scenario against the fake. The list below is what the plugin calls (method, path template).
  const CALLS: Array<[string, string]> = [
    ["GET", "/capabilities"],
    ["GET", "/items"],
    ["GET", "/items/summary"],
    ["GET", "/items/{id}"],
    ["POST", "/items"],
    ["PATCH", "/items/{id}"],
    ["DELETE", "/items/{id}"],
    ["POST", "/items/{id}/publish"],
    ["POST", "/items/{id}/withdraw"],
    ["POST", "/preview"],
    ["GET", "/search"],
    ["GET", "/imports/{sub}/{id}"],
    ["GET", "/mentions"],
    ["GET", "/hoppers"],
    ["GET", "/hoppers/{id}/memberships"],
    ["PUT", "/hoppers/{id}/items/{sub}/{remoteId}"],
    ["DELETE", "/hoppers/{id}/items/{sub}/{remoteId}"],
    ["GET", "/peek"],
    ["POST", "/peek/links"],
    ["GET", "/subscriptions/{id}"],
  ];

  it("each request validates, each answer validates, and the scenario touches every operation in the list", async () => {
    const { studio, client } = setup();
    studio.manage = true;
    const remote = "095s4h48j67mnbf6hq8vatc2d4";
    studio.importItem({ remote_id: remote, content_md: "Theirs.", origin: "https://blog-b.test/" });
    studio.mentions.push({ id: "m1", target_item_id: "x", status: "verified", relation: "transclusion", hidden: false });
    const hopper = studio.addHopper("Reading");

    await client.capabilities();
    const frag = await client.createItem({ kind: "fragment", contentMd: "Hello." });
    const id = frag.kind === "ok" ? frag.value.id : "";
    const thread = await client.createItem({ kind: "thread", contentMd: `![[${remote}]]`, stubOf: { origin: "https://blog-b.test/", id: remote, version: 1 } });
    const threadId = thread.kind === "ok" ? thread.value.id : "";
    await client.updateItem(id, { contentMd: "Hello again.", kind: "fragment" }, 1);
    await client.updateItem(threadId, { contentMd: `![[${remote}]]\n\nMine.`, stubOf: null }, 1);
    await client.getItem(id);
    await client.preview({ contentMd: "Hello again.", kind: "fragment", itemId: id });
    await client.preview({ contentMd: `![[${remote}]]`, kind: "thread" });
    await client.publish(id, "first", 2);
    await client.getItem(id);
    await client.countItems();
    await client.listItems();
    await client.search({ q: "Hello", source: "mine", limit: 5 });
    await client.getImported("sub1", remote);
    await client.countMentions("x");
    await client.listHoppers();
    await client.addToHopper(hopper.id, id);
    await client.hopperMembers(hopper.id);
    await client.removeFromHopper(hopper.id, id);
    await client.peekItem("https://blog-b.test/", remote);
    await client.classifyLinks([`https://blog-b.test/f/${remote}/`]);
    await client.getSubscription("sub1");
    await client.withdraw(id, "retracted", 3);
    await client.deleteItem(threadId, 2);
    // refusals the client reads: a stale revision and an expired cursor (ApiError schema)
    await client.updateItem(id, { contentMd: "stale" }, 1);

    const problems: string[] = [];
    const touched = new Set<string>();
    for (const seen of studio.seen) {
      if (seen.path === "/blyg.json") continue;
      const result = checkSeen(seen);
      if (result.problems.length > 0) problems.push(`${result.key}: ${result.problems.join("; ")}`);
      const found = operationOf(seen);
      if (found) touched.add(`${seen.method} ${found.template}`);
    }
    expect(problems).toEqual([]);
    for (const [method, template] of CALLS) expect(touched.has(`${method} ${template}`), `${method} ${template} was not exercised`).toBe(true);
  });

  it("the old contract-4 bodies are what the file refuses (the check would have caught the break)", () => {
    const old = { mode: "blank", kind: "fragment", content_md: "x" };
    expect(validate(pointer(["paths", "/items", "post", "requestBody", "content", "application/json", "schema"]), old).length).toBeGreaterThan(0);
    expect(validate(pointer(["paths", "/items/{id}/publish", "post", "requestBody", "content", "application/json", "schema"]), {})).not.toEqual([]);
    expect(validate(pointer(["paths", "/items/{id}/publish", "post", "requestBody", "content", "application/json", "schema"]), { expectedRevision: 1 })).toEqual([]);
  });

  it("the walks use a cursor and never an offset, and a cursor-expired answer is a documented ApiError", async () => {
    const { studio, client } = setup();
    for (let i = 0; i < 120; i++) studio.seed({ content_md: `n${i}` });
    studio.onNext("GET", /^\/api\/items$/, () => undefined);
    studio.onNext("GET", /^\/api\/items$/, () => void studio.seed({ content_md: "mid-walk" }));
    await client.listItems();
    const expired = studio.seen.find((s) => s.status === 409);
    expect(expired).toBeDefined();
    const problems = studio.seen.filter((s) => s.path !== "/blyg.json").flatMap((s) => checkSeen(s).problems);
    expect(problems).toEqual([]);
  });
});
