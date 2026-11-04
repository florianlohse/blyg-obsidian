import { describe, expect, it } from "vitest";
import { checkFragmentBody, decideBlygPublish, decideWithdraw, readCommittedBlyg, type CommittedBlyg } from "../../src/core/blyg";
import { buildBlygFileText, buildEndcapFileText, extractFrontmatterBlock, stripFrontmatter } from "../../src/core/frontmatter";
import { EMPTY_CONTENT_HASH } from "../../src/core/hash";
import { embeddedImages, plainTextsEquivalent, validatePlain } from "../../src/core/plain";
import { newItemRoute, resolvePlainTarget, routeFor } from "../../src/core/routes";
import type { Route } from "../../src/settings/schema";
import { jsYaml, MACRO_ROUTES } from "../world";

describe("frontmatter helpers", () => {
  it("strip and extract the leading block, LF or CRLF", () => {
    expect(stripFrontmatter("---\na: 1\n---\nbody\n")).toBe("body\n");
    expect(stripFrontmatter("---\r\na: 1\r\n---\r\nbody\r\n")).toBe("body\r\n");
    expect(stripFrontmatter("no frontmatter\n")).toBe("no frontmatter\n");
    expect(stripFrontmatter("text\n---\na: 1\n---\n")).toBe("text\n---\na: 1\n---\n"); // only a leading block counts
    expect(extractFrontmatterBlock("---\na: 1\nb: 2\n---\nx")).toBe("a: 1\nb: 2");
    expect(extractFrontmatterBlock("---\na: 1\nnever closes")).toBeNull();
    expect(extractFrontmatterBlock("plain")).toBeNull();
  });

  it("builds item files and endcaps in the contract's layout", () => {
    expect(buildBlygFileText(jsYaml, { a: 1 }, "body")).toBe("---\na: 1\n---\n\nbody\n");
    expect(buildEndcapFileText(jsYaml, { a: 1 })).toBe("---\na: 1\n---\n");
  });
});

describe("newItemRoute", () => {
  const routes: Route[] = [
    { vaultPrefix: "Essays/", mode: "plain", dest: "src/content/essays/", label: "essay" },
    { vaultPrefix: "website/blyg/", mode: "blyg", label: "old blyg" },
    { vaultPrefix: "Studio test/", mode: "studio", label: "test" },
  ];
  it("makes the item where you are, when that is a Blyg or Studio folder", () => {
    expect(newItemRoute(routes, "website/blyg/a.md")?.label).toBe("old blyg");
    expect(newItemRoute(routes, "Studio test/a.md")?.label).toBe("test");
  });
  it("from anywhere else, prefers the first Studio folder over the first Blyg folder", () => {
    expect(newItemRoute(routes, "Notes/a.md")?.label).toBe("test");
    expect(newItemRoute(routes, "Essays/a.md")?.label).toBe("test");
    expect(newItemRoute(routes, null)?.label).toBe("test");
  });
  it("falls back to the first Blyg folder, and to nothing", () => {
    expect(newItemRoute(routes.slice(0, 2), "Notes/a.md")?.label).toBe("old blyg");
    expect(newItemRoute(routes.slice(0, 1), "Notes/a.md")).toBeNull();
    expect(newItemRoute([{ vaultPrefix: "", mode: "studio", label: "x" }], null)).toBeNull();
  });
});

describe("routeFor", () => {
  it("matches by vault-path prefix, first route wins, no match → null (fail closed)", () => {
    expect(routeFor(MACRO_ROUTES, "website/blyg/a.md")?.mode).toBe("blyg");
    expect(routeFor(MACRO_ROUTES, "website/essays/sub/a.md")?.label).toBe("essay");
    expect(routeFor(MACRO_ROUTES, "website/Essays/a.md")).toBeNull();
    expect(routeFor(MACRO_ROUTES, "website/essays")).toBeNull();
    expect(routeFor([], "x.md")).toBeNull();
  });

  it("never lets an empty prefix match everything", () => {
    const routes: Route[] = [{ vaultPrefix: "", mode: "blyg", label: "x" }];
    expect(routeFor(routes, "anything.md")).toBeNull();
  });
});

describe("resolvePlainTarget", () => {
  const essay = MACRO_ROUTES[1] as Route;
  const t = (path: string, extension = "md") => resolvePlainTarget(essay, { path, extension }, "src/content/notes");

  it("maps the relative path 1:1", () => {
    expect(t("website/essays/sub/Über Äpfel.md")).toEqual({ ok: true, rel: "sub/Über Äpfel.md", destPath: "src/content/essays/sub/Über Äpfel.md" });
  });

  it("refuses non-Markdown, odd paths, a missing destination and the Blyg folder", () => {
    expect(t("website/essays/a.png", "png")).toEqual({ ok: false, reason: "not-markdown" });
    for (const p of ["website/essays/../x.md", "website/essays/./x.md", "website/essays//x.md", "website/essays/"]) {
      expect(t(p), p).toEqual({ ok: false, reason: "unusable-path" });
    }
    expect(resolvePlainTarget({ vaultPrefix: "a/", mode: "plain", label: "x" }, { path: "a/b.md", extension: "md" }, "n")).toEqual({ ok: false, reason: "no-destination" });
    expect(resolvePlainTarget({ vaultPrefix: "a/", mode: "plain", dest: "src/content/notes/", label: "x" }, { path: "a/b.md", extension: "md" }, "src/content/notes")).toEqual({ ok: false, reason: "inside-blyg-folder" });
  });
});

describe("validatePlain", () => {
  const essay = { requireTitle: true };
  const v = (text: string, route = essay) => validatePlain(text, route, jsYaml);

  it("accepts good frontmatter and notes without any", () => {
    expect(v("---\ntitle: T\n---\nbody\n")).toEqual({ errors: [], warnings: [] });
    expect(v("---\ntitle: T\n---\nbody\n", { requireTitle: false }).errors).toEqual([]);
    expect(v("just text\n").warnings).toHaveLength(1); // an essay without frontmatter has no title
  });

  it("blocks an unclosed block, unquoted colons, invalid YAML and blyg_id", () => {
    expect(v("---\ntitle: Foo\nbody never closes\n").errors[0]).toMatch(/never closes/);
    expect(v("---\ntitle: Foo: bar\n---\nb\n").errors[0]).toMatch(/Unquoted value containing a colon/);
    expect(v('---\ntitle: "x"\nlist: [a, b\n---\nb\n').errors[0]).toMatch(/not valid YAML/);
    expect(v("---\ntitle: T\nblyg_id: x\n---\nb\n").errors[0]).toMatch(/blyg_id/);
  });

  it("accepts quoted colons", () => {
    expect(v('---\ntitle: "Foo: bar"\n---\nb\n').errors).toEqual([]);
    expect(v("---\ntitle: 'Foo: bar'\n---\nb\n").errors).toEqual([]);
  });

  it("warns, but does not block, about a missing title (only when the route wants one)", () => {
    expect(v("---\ndescription: x\n---\nb\n").warnings[0]).toMatch(/no title/);
    expect(v("---\ndescription: x\n---\nb\n", { requireTitle: false }).warnings).toEqual([]);
  });
});

describe("plainTextsEquivalent", () => {
  const strict = { ignoreTrailingWhitespace: false };
  const lenient = { ignoreTrailingWhitespace: true };

  it("always ignores line endings", () => {
    expect(plainTextsEquivalent("a\r\nb\r\n", "a\nb\n", strict)).toBe(true);
    expect(plainTextsEquivalent("a\nb\n", "a\nb\nc\n", strict)).toBe(false);
  });

  it("at parity, whitespace-only differences count as a change", () => {
    expect(plainTextsEquivalent("a \nb\n", "a\nb\n", strict)).toBe(false);
    expect(plainTextsEquivalent("a\nb\n\n", "a\nb\n", strict)).toBe(false);
  });

  // The R2 wishlist rule, switched on: three taps on a note that only gained a trailing space made three deploys.
  it("with the whitespace rule, trailing whitespace per line and at the end is ignored", () => {
    expect(plainTextsEquivalent("a \t\nb  \n", "a\nb\n", lenient)).toBe(true);
    expect(plainTextsEquivalent("a\nb\n\n\n", "a\nb\n", lenient)).toBe(true);
    expect(plainTextsEquivalent("a\nb", "a\nb\n", lenient)).toBe(true);
  });

  it("with the whitespace rule, real differences still count", () => {
    expect(plainTextsEquivalent("a\nb\n", "a\nB\n", lenient)).toBe(false);
    expect(plainTextsEquivalent(" a\nb\n", "a\nb\n", lenient)).toBe(false); // leading whitespace is meaningful (indentation)
    expect(plainTextsEquivalent("a\n\nb\n", "a\nb\n", lenient)).toBe(false); // inner blank lines too
  });
});

describe("embeddedImages", () => {
  it("lists image embeds lowercased and de-duplicated, ignoring notes and other extensions", () => {
    expect(embeddedImages("![[A B.JPG]] ![[a b.jpg]] ![[Note]] ![[doc.pdf]] ![[x.svg]]")).toEqual(["a b.jpg", "x.svg"]);
    expect(embeddedImages("no embeds")).toEqual([]);
  });
});

describe("checkFragmentBody", () => {
  it("enforces empty and cap", () => {
    expect(checkFragmentBody("", 1000)).toEqual({ ok: false, reason: "empty" });
    expect(checkFragmentBody("x".repeat(1000), 1000)).toEqual({ ok: true });
    expect(checkFragmentBody("x".repeat(1001), 1000)).toEqual({ ok: false, reason: "too-long", length: 1001, cap: 1000 });
  });

  it("a configured cap can lower the limit but never raise it above the contract's 1000", () => {
    expect(checkFragmentBody("x".repeat(51), 50)).toEqual({ ok: false, reason: "too-long", length: 51, cap: 50 });
    expect(checkFragmentBody("x".repeat(1000), 5000)).toEqual({ ok: true });
    expect(checkFragmentBody("x".repeat(1001), 5000)).toEqual({ ok: false, reason: "too-long", length: 1001, cap: 1000 });
    expect(checkFragmentBody("x".repeat(1001), Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false, reason: "too-long" });
  });
});

describe("readCommittedBlyg", () => {
  const good = { blyg: "0.2", blyg_version: 2, blyg_created: "c", blyg_hash: "sha256:x", blyg_changelog: [{ version: 1, at: "c", note: null }] };

  it("reads a valid item", () => {
    const r = readCommittedBlyg(good);
    expect(r).toMatchObject({ ok: true, committed: { version: 2, created: "c", hash: "sha256:x", withdrawn: false } });
  });

  it("accepts timestamps as Obsidian's YAML writer leaves them: unquoted, so a YAML 1.1 parser yields Date objects", () => {
    const written = jsYaml.parse(
      'blyg: "0.2"\nblyg_id: x\nblyg_version: 1\nblyg_created: 2026-10-01T10:32:16.835Z\nblyg_updated: 2026-10-01T10:32:16.835Z\nblyg_hash: sha256:abc\nblyg_changelog:\n  - version: 1\n    at: 2026-10-01T10:32:16.835Z\n    note:\n',
    ) as { blyg_created: unknown };
    expect(Object.prototype.toString.call(written.blyg_created)).toBe("[object Date]"); // the premise of this test
    expect(readCommittedBlyg(written)).toMatchObject({ ok: true, committed: { version: 1, created: "2026-10-01T10:32:16.835Z", blyg: "0.2" } });
    expect(readCommittedBlyg({ blyg_created: new Date("invalid") })).toMatchObject({ ok: false });
  });

  it("treats a missing version as 0 and a missing changelog as empty (as the macro did)", () => {
    expect(readCommittedBlyg({ blyg_created: "c" })).toMatchObject({ ok: true, committed: { version: 0, changelog: [] } });
  });

  it("refuses malformed data instead of guessing", () => {
    for (const bad of [null, "x", [], { ...good, blyg_version: "2" }, { ...good, blyg_version: 1.5 }, { ...good, blyg_version: -1 }, { ...good, blyg_changelog: "x" }, { blyg_version: 1 }]) {
      expect(readCommittedBlyg(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("decideBlygPublish", () => {
  const now = "2026-10-01T06:00:00.000Z";
  const committed: CommittedBlyg = { blyg: "0.2", kind: "fragment", rawSources: undefined, rawLinks: undefined, version: 3, created: "2026-09-30T00:00:00.000Z", changelog: [{ version: 3, at: "x", note: null }], hash: "sha256:old", withdrawn: false };
  const input = (over: Partial<{ contentHash: string; existingId: string | undefined }> = {}) => ({
    contentHash: "sha256:new", existingId: "7c9wk2mhq0v3xj8tn5rzfd41bg" as string | undefined, now, newId: () => "NEWID", ...over,
  });

  it("creates version 1 with a one-entry changelog when the note has no id", () => {
    const d = decideBlygPublish(input({ existingId: undefined }), null);
    expect(d).toMatchObject({ action: "create", id: "NEWID" });
    if (d.action !== "create") throw new Error();
    expect(Object.keys(d.frontmatter)).toEqual(["blyg", "blyg_id", "blyg_version", "blyg_created", "blyg_updated", "blyg_hash", "blyg_changelog"]);
    expect(d.frontmatter).toMatchObject({ blyg_version: 1, blyg_created: now, blyg_updated: now, blyg_hash: "sha256:new", blyg_changelog: [{ version: 1, at: now, note: null }] });
  });

  it("is a no-op when the local hash equals the committed hash", () => {
    expect(decideBlygPublish(input({ contentHash: "sha256:old" }), committed)).toEqual({ action: "noop" });
  });

  it("bumps from the committed version, keeps created, appends to the changelog", () => {
    const d = decideBlygPublish(input(), committed);
    if (d.action !== "update") throw new Error(JSON.stringify(d));
    expect(d.version).toBe(4);
    expect(d.frontmatter).toMatchObject({ blyg_version: 4, blyg_created: committed.created, blyg_updated: now, blyg_hash: "sha256:new" });
    expect((d.frontmatter.blyg_changelog as unknown[]).length).toBe(2);
    expect("blyg_withdrawn" in d.frontmatter).toBe(false);
  });

  it("publishing after a withdrawal un-withdraws: a new version without the flag", () => {
    const d = decideBlygPublish(input(), { ...committed, withdrawn: true, hash: EMPTY_CONTENT_HASH });
    expect(d.action).toBe("update");
    if (d.action === "update") expect("blyg_withdrawn" in d.frontmatter).toBe(false);
  });

  it("refuses when the note has an id but nothing is committed", () => {
    expect(decideBlygPublish(input(), null)).toEqual({ action: "refuse", reason: "committed-missing" });
  });

  it("does not mint an id it does not need", () => {
    let minted = 0;
    decideBlygPublish({ ...input(), newId: () => (minted++, "x") }, committed);
    expect(minted).toBe(0);
  });
});

describe("decideWithdraw", () => {
  const committed: CommittedBlyg = { blyg: undefined, kind: "fragment", rawSources: undefined, rawLinks: undefined, version: 2, created: "c0", changelog: [{ version: 2, at: "x", note: null }], hash: "sha256:h", withdrawn: false };

  it("builds the endcap: version +1, flag, empty-body hash, 'withdrawn' changelog entry", () => {
    const d = decideWithdraw({ id: "ID", now: "T" }, committed);
    if (d.action !== "withdraw") throw new Error();
    expect(d.version).toBe(3);
    expect(Object.keys(d.frontmatter)).toEqual(["blyg", "blyg_id", "blyg_version", "blyg_created", "blyg_updated", "blyg_hash", "blyg_withdrawn", "blyg_changelog"]);
    expect(d.frontmatter).toMatchObject({ blyg: "0.2", blyg_hash: EMPTY_CONTENT_HASH, blyg_withdrawn: true, blyg_created: "c0", blyg_updated: "T" });
    expect(d.frontmatter.blyg_changelog).toEqual([...committed.changelog, { version: 3, at: "T", note: "withdrawn" }]);
  });

  it("is a no-op on an already withdrawn item", () => {
    expect(decideWithdraw({ id: "ID", now: "T" }, { ...committed, withdrawn: true })).toEqual({ action: "already-withdrawn" });
  });
});
