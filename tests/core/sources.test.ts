// R3 core: snapshots and links as committed YAML, the bump rule, labels, the closure walk, and the committed-kind rules.
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { decideBlygPublish, decideWithdraw, readCommittedBlyg, type CommittedBlyg } from "../../src/core/blyg";
import { buildBlygFileText, extractFrontmatterBlock } from "../../src/core/frontmatter";
import {
  describeSourceChanges,
  findClosureCycle,
  linkLabel,
  readLinks,
  readSources,
  renderLinksYaml,
  renderSourcesYaml,
  sourcesDiffer,
  yamlQuote,
  type LinkEntry,
  type SourceEntry,
} from "../../src/core/sources";
import { jsYaml } from "../world";

const A = "7c9wk2mhq0v3xj8tn5rzfd41bg";
const B = "1vgtgz0gq5b2c9k7d3m8r4n6xy";
const ORIGIN = "https://example.com/blyg/";

const source = (over: Partial<SourceEntry> = {}): SourceEntry => ({
  id: A,
  version: 3,
  origin: ORIGIN,
  kind: "fragment",
  html: "<p>Hello.</p>",
  page: `${ORIGIN}f/${A}/`,
  retrieved: "2026-10-10T08:00:00.000Z",
  ...over,
});

const parseBlock = (yamlText: string): Record<string, unknown> => yaml.load(yamlText) as Record<string, unknown>;

describe("yamlQuote", () => {
  const nasty = [
    "",
    "plain",
    'say "hi" and \\ back',
    "line one\nline two\r\nline three\ttab",
    "<p>It’s “curly” — and <em>full</em> of &amp; things: yes, # not a comment, - not a list</p>\n<p>second</p>",
    "ends with a colon:",
    "null",
    "true",
    "12345678901234567890123456",
    "0x1F",
    "~",
    "- dash first",
    "# hash first",
    "'single' and `tick`",
    "\u0085 next line \u2028 line sep \u2029 para sep \ufeff bom \u0000 nul \u007f del",
    "emoji 👨‍👩‍👧‍👦 ünïcödé 日本語",
    " leading and trailing space ",
    "a".repeat(5000),
  ];
  it.each(nasty.map((s, i) => [i, s] as const))("round-trips #%i through a YAML reader", (_i, s) => {
    expect(parseBlock(`key: ${yamlQuote(s)}`)).toEqual({ key: s });
  });

  it("is a single line, whatever the text holds", () => {
    const quoted = yamlQuote("a\nb" + String.fromCharCode(0x2028) + "c" + String.fromCharCode(0x85));
    expect(quoted).not.toContain("\n");
    expect(quoted).not.toContain(String.fromCharCode(0x2028));
    expect(quoted).not.toContain(String.fromCharCode(0x85));
  });
});

describe("renderSourcesYaml / readSources", () => {
  it("writes an empty list for a withdrawn thread and parses it back", () => {
    expect(renderSourcesYaml([])).toBe("blyg_sources: []\n");
    expect(parseBlock("blyg_sources: []")).toEqual({ blyg_sources: [] });
  });

  it("reads back exactly what it wrote, including a partial quote and a passed-through author", () => {
    const sources: SourceEntry[] = [
      source({ html: '<p>Time moves down the stack, and <em>everything</em> keeps its own "clock".</p>\n<p>Two.</p>', author: { name: "Ada Example", url: "https://example.com/" } }),
      source({ id: B, version: 1, kind: "thread", selector: { exact: "its own “clock”", prefix: "and everything keeps ", suffix: " And more." } }),
    ];
    const parsed = parseBlock(renderSourcesYaml(sources));
    expect(readSources(parsed.blyg_sources)).toEqual(sources);
  });

  it("is laid out like the contract's example", () => {
    expect(renderSourcesYaml([source({ selector: { exact: "Hello." } })])).toBe(
      [
        "blyg_sources:",
        `  - id: "${A}"`,
        "    version: 3",
        `    origin: "${ORIGIN}"`,
        '    kind: "fragment"',
        '    html: "<p>Hello.</p>"',
        `    page: "${ORIGIN}f/${A}/"`,
        '    retrieved: "2026-10-10T08:00:00.000Z"',
        "    selector:",
        '      exact: "Hello."',
        "",
      ].join("\n"),
    );
  });

  it("accepts the site's own golden file (unquoted dates, nested author) and rejects damaged entries", () => {
    const golden = readFileSync(new URL("../fixtures/site/threads/thread-two-sources.md", import.meta.url), "utf8");
    const fm = parseBlock(extractFrontmatterBlock(golden) ?? "");
    const sources = readSources(fm.blyg_sources);
    expect(sources?.map((s) => [s.id, s.version, s.kind, s.selector?.exact])).toEqual([
      [A, 3, "fragment", undefined],
      [B, 1, "fragment", "Stigmergy is what a protocol looks like from inside."],
    ]);
    expect(sources?.[0]?.retrieved).toBe("2026-10-10T07:59:00.000Z");
    expect(sources?.[0]?.author).toEqual({ name: "Ada Example" });
    expect(readLinks(fm.blyg_links)).toEqual([
      {
        id: "3d7mnhr5g0kq8v2wxb4tjy6fz9",
        origin: "https://example.org/blyg/",
        page: "https://example.org/blyg/f/3d7mnhr5g0kq8v2wxb4tjy6fz9/",
        label: "“Micro Time seems to be the emerging regime…”",
      },
    ]);
    expect(readSources([{ id: A }])).toBeNull();
    expect(readSources("nope")).toBeNull();
    expect(readSources([{ ...source(), version: 0 }])).toBeNull();
    expect(readSources([{ ...source(), kind: "withdrawn" }])).toBeNull();
    expect(readSources([{ ...source(), selector: { exact: "" } }])).toBeNull();
    expect(readSources(undefined)).toEqual([]);
  });
});

describe("renderLinksYaml / readLinks", () => {
  const links: LinkEntry[] = [
    { id: A, origin: ORIGIN, page: `${ORIGIN}f/${A}/`, label: "“Micro Time seems to be the emerging…”" },
    { id: B, origin: ORIGIN },
  ];
  it("writes nothing for no links and round-trips the rest", () => {
    expect(renderLinksYaml([])).toBe("");
    expect(readLinks(parseBlock(renderLinksYaml(links)).blyg_links)).toEqual(links);
  });
});

describe("linkLabel", () => {
  it("is the first 60 characters of the plain text in curly quotes, ellipsis inside when it cut", () => {
    expect(linkLabel("<p>Micro Time seems to be the emerging regime of the whole thing, really.</p>")).toBe("“Micro Time seems to be the emerging regime of the whole thin…”");
    expect(linkLabel("<p>Short.</p>")).toBe("“Short.”");
    expect(linkLabel("<p></p>")).toBe("");
  });
});

describe("the bump rule for sources (contract §3.3)", () => {
  const committed = [source(), source({ id: B, version: 1, selector: { exact: "x" } })];
  it("is quiet when (id, version, origin, selector) all match, whatever else differs", () => {
    const next = [source({ html: "<p>drifted</p>", retrieved: "2030-01-01T00:00:00.000Z" }), source({ id: B, version: 1, selector: { exact: "x", prefix: "p" } })];
    expect(sourcesDiffer(committed, next)).toBe(false);
    expect(sourcesDiffer([source({ origin: "https://example.com/blyg" })], [source()])).toBe(false); // a trailing slash is not a different origin
  });
  it("differs on a version, an origin, a selector, an id, a count — and when the committed list was unreadable", () => {
    expect(sourcesDiffer(committed, [source({ version: 4 }), committed[1] as SourceEntry])).toBe(true);
    expect(sourcesDiffer(committed, [source({ origin: "https://other.example/" }), committed[1] as SourceEntry])).toBe(true);
    expect(sourcesDiffer(committed, [committed[0] as SourceEntry, source({ id: B, version: 1, selector: { exact: "y" } })])).toBe(true);
    expect(sourcesDiffer(committed, [committed[0] as SourceEntry, source({ id: B, version: 1 })])).toBe(true); // partial became whole
    expect(sourcesDiffer(committed, [committed[0] as SourceEntry])).toBe(true);
    expect(sourcesDiffer(null, [])).toBe(true);
    expect(sourcesDiffer([], [])).toBe(false);
  });
  it("says what moved", () => {
    expect(describeSourceChanges(null, [source()])).toEqual([`quote of ${A.slice(0, 8)}… v3: new`]);
    expect(describeSourceChanges([source({ version: 2 })], [source()])).toEqual([`quote of ${A.slice(0, 8)}… moves from v2 to v3`]);
    expect(describeSourceChanges(committed, [committed[0] as SourceEntry])).toEqual(["1 quote removed"]);
    expect(describeSourceChanges(committed, committed)).toEqual([]);
  });
});

describe("findClosureCycle (spec §10.2: a thread may not quote a thread that quotes it)", () => {
  const graph: Record<string, string[] | null> = { t1: ["t2"], t2: ["t3", "f1"], t3: ["self"], f1: null, loop1: ["loop2"], loop2: ["loop1"] };
  const quotes = (id: string): Promise<string[] | null> => Promise.resolve(graph[id] ?? null);

  it("finds the chain back to the publishing thread", async () => {
    expect(await findClosureCycle("self", ["t1"], quotes)).toEqual(["t1", "t2", "t3", "self"]);
  });
  it("finds nothing when no chain leads back, and ends on loops that do not involve the thread", async () => {
    expect(await findClosureCycle("self", ["f1"], quotes)).toBeNull();
    expect(await findClosureCycle("self", ["loop1"], quotes)).toBeNull();
  });
  it("catches a thread quoting itself, and cannot be cyclic for a thread that has no id yet", async () => {
    expect(await findClosureCycle("self", ["self"], quotes)).toEqual(["self"]);
    expect(await findClosureCycle(undefined, ["t1"], quotes)).toBeNull();
  });
});

describe("kind in the item state machine", () => {
  const committed = (over: Partial<CommittedBlyg> = {}): CommittedBlyg => ({
    blyg: "0.2",
    kind: "fragment",
    rawSources: undefined,
    rawLinks: undefined,
    version: 2,
    created: "2026-10-01T00:00:00.000Z",
    changelog: [
      { version: 1, at: "2026-10-01T00:00:00.000Z", note: null },
      { version: 2, at: "2026-10-02T00:00:00.000Z", note: null },
    ],
    hash: "sha256:aa",
    withdrawn: false,
    ...over,
  });
  const input = { contentHash: "sha256:aa", existingId: A, now: "2026-10-10T00:00:00.000Z", newId: () => B };

  it("reads the committed kind (absent = fragment) and refuses an unknown one", () => {
    expect(readCommittedBlyg({ blyg_version: 1, blyg_created: "2026-10-01T00:00:00.000Z" })).toMatchObject({ ok: true, committed: { kind: "fragment" } });
    expect(readCommittedBlyg({ blyg_version: 1, blyg_created: "2026-10-01T00:00:00.000Z", blyg_kind: "thread", blyg_sources: [] })).toMatchObject({
      ok: true,
      committed: { kind: "thread", rawSources: [] },
    });
    expect(readCommittedBlyg({ blyg_version: 1, blyg_created: "2026-10-01T00:00:00.000Z", blyg_kind: "essay" })).toMatchObject({ ok: false });
  });

  it("a fragment is written exactly as before: no blyg_kind key", () => {
    const d = decideBlygPublish({ ...input, existingId: undefined }, null);
    expect(d.action === "create" && Object.keys(d.frontmatter)).toEqual(["blyg", "blyg_id", "blyg_version", "blyg_created", "blyg_updated", "blyg_hash", "blyg_changelog"]);
  });

  it("a thread carries blyg_kind right after blyg_id, on create and on update", () => {
    const created = decideBlygPublish({ ...input, existingId: undefined, kind: "thread" }, null);
    expect(created.action === "create" && Object.keys(created.frontmatter).slice(0, 3)).toEqual(["blyg", "blyg_id", "blyg_kind"]);
    const updated = decideBlygPublish({ ...input, kind: "thread", contentHash: "sha256:bb" }, committed({ kind: "thread" }));
    expect(updated.action === "update" && updated.frontmatter.blyg_kind).toBe("thread");
  });

  it("the kind never changes: either direction is refused", () => {
    expect(decideBlygPublish({ ...input, kind: "thread" }, committed())).toEqual({ action: "refuse", reason: "kind-changed", committedKind: "fragment" });
    expect(decideBlygPublish({ ...input, kind: "fragment" }, committed({ kind: "thread" }))).toEqual({ action: "refuse", reason: "kind-changed", committedKind: "thread" });
  });

  it("an unchanged body is a no-op unless the sources changed", () => {
    expect(decideBlygPublish({ ...input, kind: "thread" }, committed({ kind: "thread" })).action).toBe("noop");
    const changed = decideBlygPublish({ ...input, kind: "thread", sourcesChanged: true }, committed({ kind: "thread" }));
    expect(changed).toMatchObject({ action: "update", version: 3 });
  });

  it("a withdrawn thread keeps its kind; a withdrawn fragment gets none", () => {
    const thread = decideWithdraw({ id: A, now: "2026-10-10T00:00:00.000Z" }, committed({ kind: "thread" }));
    expect(thread.action === "withdraw" && thread.frontmatter.blyg_kind).toBe("thread");
    const fragment = decideWithdraw({ id: A, now: "2026-10-10T00:00:00.000Z" }, committed());
    expect(fragment.action === "withdraw" && "blyg_kind" in fragment.frontmatter).toBe(false);
  });
});

describe("a thread file", () => {
  it("is the frontmatter, the sources and links as written YAML, a blank line, the body", () => {
    const text = buildBlygFileText(jsYaml, { blyg_id: A, blyg_kind: "thread" }, "Body.", renderSourcesYaml([source()]) + renderLinksYaml([{ id: B, origin: ORIGIN, label: "“x”" }]));
    const fm = parseBlock(extractFrontmatterBlock(text) ?? "");
    expect(Object.keys(fm)).toEqual(["blyg_id", "blyg_kind", "blyg_sources", "blyg_links"]);
    expect(text.endsWith("---\n\nBody.\n")).toBe(true);
  });
});
