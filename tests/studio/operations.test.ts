// The operation-level test of S16 (docs/plans/S16-contract-5.md §3.5): for every operation the client calls, each request it builds
// (body with `additionalProperties: false`, query names, path) is valid against the Studio's OpenAPI file, and each answer the fake Studio
// gives is valid against that operation's response schema. This is what would have caught the contract-5 break before any user did.
// Validation runs on the real client driving the fake over its real http adapter. Since E1 it runs twice: against the 0.51.0 file with the fake
// speaking contract 5.2.0, and against the 0.69.0 file with the fake speaking 6.2.0 (no `GET /changes`, `background` on subscriptions).
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
interface Spec {
  paths: Record<string, Record<string, Operation>>;
}

/** Everything that checks a request or an answer against one vendored OpenAPI file. */
function checkerFor(file: string) {
  const spec = JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8")) as Spec;

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

  return { spec, validate, pointer, operationOf, checkSeen };
}

function setup(contractVersion = "5.2.0") {
  const studio = new FakeStudio();
  studio.contractVersion = contractVersion;
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return { studio, client };
}

describe("the fixtures", () => {
  it("studio-openapi-0.69.0.json is the unmodified release asset of Studio 0.69.0 (contract 6.2.0; its SHA256SUMS line)", () => {
    const text = readFileSync(new URL("../fixtures/studio-openapi-0.69.0.json", import.meta.url));
    expect(createHash("sha256").update(text).digest("hex")).toBe("b5d8e504fcb6e44da50138ee875eb21765cae18f147478edb88c13ba1e5aae17");
    expect(checkerFor("studio-openapi-0.69.0.json").spec.paths["/changes"]).toBeUndefined();
    expect(checkerFor("studio-openapi-0.51.0.json").spec.paths["/changes"]).toBeDefined();
  });
  it("studio-openapi-0.49.1.json stays as the documented last contract-4 file (release SHA256SUMS)", () => {
    const text = readFileSync(new URL("../fixtures/studio-openapi-0.49.1.json", import.meta.url));
    expect(createHash("sha256").update(text).digest("hex")).toBe("2ec3063fa9f578a2112293680d431727b5377f0905faa6139b7f0f1b04fb33d1");
  });
});

const CONTRACTS = [
  { label: "Studio 0.51.0 file, contract 5.2.0", file: "studio-openapi-0.51.0.json", contractVersion: "5.2.0", changes: true },
  { label: "Studio 0.69.0 file, contract 6.2.0", file: "studio-openapi-0.69.0.json", contractVersion: "6.2.0", changes: false },
];

describe.each(CONTRACTS)("every operation the client calls, against the $label", ({ file, contractVersion, changes }) => {
  const { validate, pointer, operationOf, checkSeen } = checkerFor(file);
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
    ["GET", "/subscriptions"],
    ["POST", "/subscriptions"],
    ["PATCH", "/subscriptions/{id}"],
    ["DELETE", "/subscriptions/{id}"],
    // contract 5 only: the reader's change counters (contract 6 removed them; the client then asks nothing, see below)
    ...(changes ? [["GET", "/changes"] as [string, string]] : []),
  ];

  it("each request validates, each answer validates, and the scenario touches every operation in the list", async () => {
    const { studio, client } = setup(contractVersion);
    studio.manage = true;
    const remote = "095s4h48j67mnbf6hq8vatc2d4";
    studio.importItem({ remote_id: remote, content_md: "Theirs.", origin: "https://blog-b.test/" });
    studio.mentions.push({ id: "m1", target_item_id: "x", status: "verified", relation: "transclusion", hidden: false });
    const hopper = studio.addHopper("Reading");

    await client.capabilities();
    // The reader's freshness check: asks `GET /changes` only of a Studio that lists the operation.
    const counters = await client.changes();
    expect(counters.kind === "ok" && (counters.value !== null) === changes).toBe(true);
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
    await client.listSubscriptions();
    await client.createSubscription("https://blog-c.test/");
    const followed = await client.createSubscription("https://blog-c.test/", { confirm: true, title: "Blog C" });
    const followedId = followed.kind === "ok" && followed.value.state === "created" ? followed.value.subscription.id : "";
    await client.updateSubscription(followedId, { title: "Mine" });
    await client.updateSubscription(followedId, { title: null });
    await client.deleteSubscription(followedId);
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

  it("the shelf (SH1): every request and answer validates against the file, on a Studio that has it", async () => {
    const { studio, client } = setup(contractVersion);
    studio.token = STUDIO_TOKEN;
    studio.importItem({ remote_id: "095s4h48j67mnbf6hq8vatc2d4", content_md: "Theirs." });
    await client.capabilities();
    const asked = [await client.getShelf(), await client.putShelf([{ sub: "sub1", remoteId: "095s4h48j67mnbf6hq8vatc2d4" }], 0), await client.putShelf([], 0) /* stale: 409 with the current list */, await client.listShelved()];
    if (!studio.operationsListedHasShelf()) {
      // contract 5: nothing was asked, and the client said so
      expect(asked.map((a) => a.kind)).toEqual(["ok", "absent", "absent", "ok"]);
      expect(studio.seen.filter((s) => s.path.startsWith("/api/shelf") || s.path.includes("shelf=")).length).toBe(0);
      return;
    }
    const problems: string[] = [];
    for (const seen of studio.seen.filter((s) => s.path.startsWith("/api/shelf") || s.path.includes("shelf=true"))) {
      const result = checkSeen(seen);
      if (result.problems.length > 0) problems.push(`${result.key}: ${result.problems.join("; ")}`);
    }
    expect(problems).toEqual([]);
    expect(studio.seen.filter((s) => s.path.startsWith("/api/shelf")).map((s) => `${s.method} ${s.status}`)).toEqual(["GET 200", "PUT 200", "PUT 409"]);
  });

  it("the old contract-4 bodies are what the file refuses (the check would have caught the break)", () => {
    const old = { mode: "blank", kind: "fragment", content_md: "x" };
    expect(validate(pointer(["paths", "/items", "post", "requestBody", "content", "application/json", "schema"]), old).length).toBeGreaterThan(0);
    expect(validate(pointer(["paths", "/items/{id}/publish", "post", "requestBody", "content", "application/json", "schema"]), {})).not.toEqual([]);
    expect(validate(pointer(["paths", "/items/{id}/publish", "post", "requestBody", "content", "application/json", "schema"]), { expectedRevision: 1 })).toEqual([]);
  });

  it("the walks use a cursor and never an offset, and a cursor-expired answer is a documented ApiError", async () => {
    const { studio, client } = setup(contractVersion);
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
