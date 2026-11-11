// Replies (roadmap S10) and finding an item by its address (roadmap S9). The Studio's rules here were checked on a real Studio 0.49.1
// (docs/plans/S10-stubs.md "As built"): only a thread can be a reply, the Studio bakes the citation itself, and it accepts a changed target.
import { describe, expect, it } from "vitest";
import { M } from "../../src/publish/messages";
import { lookupAddress, stubTargetOf } from "../../src/studio/lookup";
import { looksLikeAddress, parseItemAddress, parseItemId, readStubProperty, readWireStub, sameStubTarget, stubForWire, stubLabel, stubProperty } from "../../src/studio/stub";
import type { StudioPick } from "../../src/studio/picker";
import { frontmatterOf } from "../world";
import { STUDIO_HOST, STUDIO_ORIGIN } from "./fake-studio";
import { makeStudioWorld, tapStudio, tapStudioPull, type StudioWorld } from "./world";
import { importStudioItems, scanStudioImport } from "../../src/publish/studioImport";
import { jsYaml } from "../world";
import { STUDIO_ROUTES } from "./world";

const NOTE = "studio/Reply.md";
const fm = (w: StudioWorld, path = NOTE): Record<string, unknown> => frontmatterOf(w.local.get(path) ?? "");
const BLOG = "https://blog-b.test/";
const REMOTE = "r000000000000000000000000a";
const target = { origin: BLOG, id: REMOTE, version: 1 };
const thread = (props: string, body = "I disagree.\n"): string => `---\nblyg_kind: thread\n${props}\n---\n${body}`;
const setProps = (w: StudioWorld, path: string, change: (p: Record<string, unknown>) => void): void => {
  const text = w.local.get(path) ?? "";
  const props = frontmatterOf(text);
  change(props);
  w.local.set(path, `---\n${jsYaml.stringify(props).trimEnd()}\n---\n${text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")}`);
};
const stubNote = (extra = ""): string => `blyg_stub_of:\n  origin: ${BLOG}\n  id: ${REMOTE}\n  version: 1\n  label: "Blog B: a remote fragment"${extra}`;

describe("the reply target as a property", () => {
  it("reads a blyg target and a web page; a label stays the plugin's own and is never sent", () => {
    expect(readStubProperty(undefined)).toEqual({ ok: true, stub: null });
    const read = readStubProperty({ ...target, label: "Blog B: x" });
    expect(read).toEqual({ ok: true, stub: { ...target, label: "Blog B: x" } });
    expect(read.ok && read.stub && stubForWire(read.stub)).toEqual(target);
    expect(readStubProperty({ url: "https://example.com/a" })).toEqual({ ok: true, stub: { url: "https://example.com/a" } });
    expect(stubProperty({ ...target, label: "L" })).toEqual({ ...target, label: "L" });
  });

  it("refuses what is not a target, with a sentence", () => {
    for (const bad of ["just text", 7, { origin: "nope", id: "a", version: 1 }, { origin: BLOG, id: "a", version: 0 }, { origin: BLOG, id: "", version: 1 }, { origin: BLOG, id: "a b", version: 1 }, [1]]) {
      expect(readStubProperty(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("two targets are one reply when origin and id agree (the version is the Studio's to bake)", () => {
    expect(sameStubTarget(target, { ...target, version: 5 })).toBe(true);
    expect(sameStubTarget(target, { ...target, origin: "https://blog-b.test" })).toBe(true);
    expect(sameStubTarget(target, { ...target, id: "other" })).toBe(false);
    expect(sameStubTarget(target, null)).toBe(false);
    expect(sameStubTarget(null, null)).toBe(true);
    expect(readWireStub({ ...target, extra: 1 })).toEqual(target);
    expect(readWireStub("x")).toBeNull();
    expect(stubLabel(target)).toBe(`${REMOTE} at blog-b.test`);
  });
});

describe("a pasted address", () => {
  const studio = { host: STUDIO_HOST, mount: "", origin: STUDIO_ORIGIN, apiBase: `${STUDIO_HOST}/api` };
  it("is the Studio's reader, one of its own pages, or any other web address; words are not an address", () => {
    expect(parseItemAddress(`${STUDIO_HOST}/studio/reading/sub1/${REMOTE}`, studio)).toEqual({ kind: "reading", sub: "sub1", id: REMOTE });
    expect(parseItemAddress(`${STUDIO_HOST}/studio/reading/%7Eown/abc/?x=1#top`, studio)).toEqual({ kind: "reading", sub: "~own", id: "abc" });
    expect(parseItemAddress(`${STUDIO_ORIGIN}f/abc/`, studio)).toEqual({ kind: "own", id: "abc" });
    expect(parseItemAddress(`${STUDIO_ORIGIN}t/abc`, studio)).toEqual({ kind: "own", id: "abc" });
    expect(parseItemAddress(`<${BLOG}f/${REMOTE}/?utm_source=share>`, studio)).toEqual({ kind: "web", url: `${BLOG}f/${REMOTE}/` });
    expect(parseItemAddress(`  "${BLOG}t/${REMOTE}/"  `, studio)).toEqual({ kind: "web", url: `${BLOG}t/${REMOTE}/` });
    expect(parseItemAddress("what I said about stubs", studio)).toBeNull();
    expect(parseItemAddress(`see ${BLOG}f/${REMOTE}/ for more`, studio)).toBeNull();
    expect(parseItemAddress("ftp://x.test/f/abc/", studio)).toBeNull();
    // another host that merely looks like the reader is just a web address
    expect(parseItemAddress("https://elsewhere.test/studio/reading/a/b", studio)).toEqual({ kind: "web", url: "https://elsewhere.test/studio/reading/a/b" });
  });
});

describe("finding an item by its address, at the Studio", () => {
  function setup() {
    const w = makeStudioWorld();
    const imported = w.studio.importItem({ remote_id: REMOTE, content_md: "A remote fragment. It has a sentence.", version: 3 });
    const client = w.deps.studio?.client;
    const address = w.deps.studio?.address;
    if (!client || !address) throw new Error("world");
    return { w, imported, client, address };
  }

  it("the Studio's reader address of an item of a blyg you read: quotable, with its blyg and version", async () => {
    const { client, address } = setup();
    const found = await lookupAddress(client, address, `${STUDIO_HOST}/studio/reading/sub1/${REMOTE}`);
    expect(found).toMatchObject({ kind: "found", pick: { id: REMOTE, subscriptionId: "sub1", origin: BLOG, version: 3, quotable: true, kind: "fragment" } });
    expect(found.kind === "found" && found.pick.label).toMatch(/^Blog B: A remote fragment/);
  });

  it("the public page of an item of a blyg you read: the Studio classifies it and the held copy is used", async () => {
    const { w, client, address } = setup();
    const found = await lookupAddress(client, address, `${BLOG}f/${REMOTE}/`);
    expect(found).toMatchObject({ kind: "found", pick: { subscriptionId: "sub1", quotable: true } });
    expect(w.studio.seen.some((s) => s.path === "/api/peek/links")).toBe(true);
  });

  it("an item of a blyg you do not read can be replied to but not quoted, and the row says so", async () => {
    const { w, client, address } = setup();
    w.studio.peekable.push({ origin: "https://elsewhere.test/", id: "e1", kind: "thread", version: 2, content_html: "<p>Their thread.</p>" });
    const found = await lookupAddress(client, address, "https://elsewhere.test/t/e1/");
    expect(found).toMatchObject({ kind: "found", pick: { subscriptionId: null, origin: "https://elsewhere.test/", version: 2, quotable: false, kind: "thread" } });
    expect(found.kind === "found" && found.pick.detail).toMatch(/you do not read this blyg/);
  });

  it("an item of your own, by its public page or the reader's ~own address; an unpublished one is refused", async () => {
    const { w, client, address } = setup();
    const out = await (async () => {
      w.local.set("studio/Mine.md", "Mine.\n");
      return tapStudio(w, "studio/Mine.md");
    })();
    const byPage = await lookupAddress(client, address, `${STUDIO_ORIGIN}f/${out.id}/`);
    expect(byPage).toMatchObject({ kind: "found", pick: { id: out.id, subscriptionId: null, origin: null, version: 1 } });
    expect(await lookupAddress(client, address, `${STUDIO_HOST}/studio/reading/%7Eown/${out.id}`)).toMatchObject({ kind: "found", pick: { id: out.id } });
    const draft = w.studio.seed({ content_md: "Not yet." });
    expect(await lookupAddress(client, address, `${STUDIO_ORIGIN}f/${draft.id}/`)).toEqual({ kind: "problem", message: M.lookupOwnDraft });
  });

  it("an item id alone, as the reader's \"Copy id\" gives it: one of yours, or one held from a blyg you read; an unknown id says so", async () => {
    const { w, client, address } = setup();
    w.local.set("studio/Mine2.md", "Mine too.\n");
    const out = await tapStudio(w, "studio/Mine2.md");
    expect(await lookupAddress(client, address, `[[${out.id} | “Mine too.”]]`)).toMatchObject({ kind: "found", pick: { id: out.id, subscriptionId: null } });
    expect(await lookupAddress(client, address, REMOTE)).toMatchObject({ kind: "found", pick: { id: REMOTE, subscriptionId: "sub1", origin: BLOG, quotable: true } });
    expect(await lookupAddress(client, address, `[[${REMOTE}]]`)).toMatchObject({ kind: "found", pick: { id: REMOTE } });
    expect(await lookupAddress(client, address, "x9999999999999999999999999")).toEqual({ kind: "problem", message: M.lookupIdUnknown });
  });

  it("says why when it is not an item, not served, or not held; words are left to the search", async () => {
    const { client, address } = setup();
    expect(await lookupAddress(client, address, "https://example.com/some/page")).toEqual({ kind: "problem", message: M.lookupNotAnItem });
    expect(await lookupAddress(client, address, `${STUDIO_HOST}/studio/reading/sub1/nope`)).toEqual({ kind: "problem", message: M.lookupNotHeld });
    expect(await lookupAddress(client, address, `${STUDIO_ORIGIN}f/nope/`)).toEqual({ kind: "problem", message: M.lookupNotHere });
    expect(await lookupAddress(client, address, "a few words")).toEqual({ kind: "not-an-address" });
  });
});

describe("what a reply names", () => {
  const pick = (over: Partial<StudioPick>): StudioPick => ({ source: "studio", id: REMOTE, kind: "fragment", title: "t", detail: "d", subscriptionId: null, label: "Label", ...over });

  it("a search row of a blyg you read: the Studio is asked whose blyg it is and which version it holds", async () => {
    const w = makeStudioWorld();
    w.studio.importItem({ remote_id: REMOTE, content_md: "x", version: 4 });
    const { client, address } = w.deps.studio ?? (() => { throw new Error("world"); })();
    expect(await stubTargetOf(client, address, pick({ subscriptionId: "sub1" }))).toEqual({ ok: true, target: { origin: BLOG, id: REMOTE, version: 4, label: "Label" } });
  });

  it("one of your own items names this Studio's origin and its published version; a draft is refused", async () => {
    const w = makeStudioWorld({ vault: { "studio/Mine.md": "Mine.\n" } });
    const out = await tapStudio(w, "studio/Mine.md");
    const { client, address } = w.deps.studio ?? (() => { throw new Error("world"); })();
    const vaultPick = pick({ source: "vault", id: out.id ?? "", path: "studio/Mine.md", name: "Mine" });
    expect(await stubTargetOf(client, address, vaultPick)).toEqual({ ok: true, target: { origin: STUDIO_ORIGIN, id: out.id, version: 1, label: "Label" } });
    const draft = w.studio.seed({ content_md: "d" });
    expect(await stubTargetOf(client, address, pick({ id: draft.id }))).toEqual({ ok: false, message: M.lookupOwnDraft });
  });

  it("a row found by its address already carries everything", async () => {
    const w = makeStudioWorld();
    const { client, address } = w.deps.studio ?? (() => { throw new Error("world"); })();
    const row = pick({ origin: "https://elsewhere.test/", version: 2, quotable: false });
    expect(await stubTargetOf(client, address, row)).toEqual({ ok: true, target: { origin: "https://elsewhere.test/", id: REMOTE, version: 2, label: "Label" } });
  });
});

describe("a reply on a send", () => {
  it("a new thread note with blyg_stub_of is created as a reply; the window says so; the label is not sent", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: thread(stubNote()) } });
    w.studio.importItem({ remote_id: REMOTE, content_md: "x" });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(w.previews.at(-1)?.changes).toContain(M.stubReply("Blog B: a remote fragment"));
    expect(w.studio.items.get(out.id ?? "")?.stub_of).toEqual(target);
    expect(JSON.stringify(w.studio.seen.filter((s) => s.method === "POST" && s.path === "/api/items").map((s) => s.body))).not.toContain("Blog B: a remote");
    expect(fm(w).blyg_stub_of).toMatchObject(target);
  });

  it("a fragment with blyg_stub_of is refused before any request, and so is a property that is not a target", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: `---\n${stubNote()}\n---\nText.\n`, "studio/Bad.md": thread("blyg_stub_of: just words") } });
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "refused", notices: [M.stubNeedsThread] });
    const bad = await tapStudio(w, "studio/Bad.md");
    expect(bad.status).toBe("refused");
    expect(bad.notices[0]).toMatch(/blyg_stub_of must hold origin, id and version/);
    expect(w.studio.seen).toHaveLength(0);
  });

  it("a note without the property leaves an item's reply target alone", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: thread(stubNote()) } });
    const first = await tapStudio(w, NOTE);
    setProps(w, NOTE, (p) => delete p.blyg_stub_of);
    w.local.set(NOTE, (w.local.get(NOTE) ?? "").replace("I disagree.", "I still disagree."));
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    expect(w.studio.items.get(first.id ?? "")?.stub_of).toEqual(target);
  });

  it("naming another item on a published thread is sent as an update, although the text is unchanged", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: thread(stubNote()) } });
    const first = await tapStudio(w, NOTE);
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "noop" });
    setProps(w, NOTE, (p) => (p.blyg_stub_of = { origin: BLOG, id: "r00000000000000000000000b0", version: 2 }));
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", version: 2 });
    expect(w.studio.items.get(first.id ?? "")?.stub_of).toEqual({ origin: BLOG, id: "r00000000000000000000000b0", version: 2 });
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "noop" });
  });

  it("a drafts-only folder sends the reply target with the draft", async () => {
    const w = makeStudioWorld({ vault: { "drafts/Reply.md": thread(stubNote()) } });
    const out = await tapStudio(w, "drafts/Reply.md");
    expect(out.status).toBe("published");
    const item = w.studio.items.get(out.id ?? "");
    expect(item?.status).toBe("draft");
    expect(item?.stub_of).toEqual(target);
  });
});

describe("a reply on the way back", () => {
  it("“Use the Studio's copy” puts the item's reply target into the note, keeping the label of the same target", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: thread(stubNote()) } });
    const first = await tapStudio(w, NOTE);
    setProps(w, NOTE, (p) => delete p.blyg_stub_of);
    w.studio.editThere(first.id ?? "", "Edited over there.");
    await tapStudioPull(w, NOTE);
    expect(fm(w).blyg_stub_of).toMatchObject(target);
    // the same target keeps its label
    setProps(w, NOTE, (p) => (p.blyg_stub_of = { ...target, label: "Mine" }));
    w.studio.editThere(first.id ?? "", "Edited again.");
    await tapStudioPull(w, NOTE);
    expect(fm(w).blyg_stub_of).toMatchObject({ ...target, label: "Mine" });
  });

  it("the import writes it too, so a reply written on the web is still a reply", async () => {
    const w = makeStudioWorld();
    const item = w.studio.seed({
      kind: "thread",
      content_md: "Written on the web.",
      stub_of: target,
      status: "public",
      version: 1,
      versions: [{ version: 1, content_md: "Written on the web.", content_html: "<p>Written on the web.</p>", content_hash: "sha256:x", published_at: w.studio.now, note: null }],
    });
    const studio = w.deps.studio;
    const edit = w.deps.edit;
    if (!studio || !edit) throw new Error("world");
    const exists = (p: string): boolean => w.local.has(p);
    const deps = { client: studio.client, address: studio.address, routes: STUDIO_ROUTES, importFolder: "", fragmentCharCap: 1000, vault: w.deps.vault, edit, yaml: jsYaml, files: { exists, ensureFolder: () => Promise.resolve(), create: (p: string, t: string) => (w.local.set(p, t), Promise.resolve({ path: p, name: p.split("/").pop() ?? p, extension: "md" })) } };
    const scan = await scanStudioImport(deps, new Set());
    if (!scan.ok) throw new Error("scan");
    await importStudioItems(deps, scan.scan.candidates, scan.route);
    const props = fm(w, "studio/Written on the web.md");
    expect(props).toMatchObject({ blyg_id: item.id, blyg_kind: "thread", blyg_stub_of: target });
    // and publishing it unchanged has nothing to send
    expect(await tapStudio(w, "studio/Written on the web.md")).toMatchObject({ status: "noop" });
  });
});

describe("an item id alone", () => {
  const ID = "40gscfc6bbx1hry3t769jfk7q4";
  it("is read bare or from the reader's link form; ordinary text is not an id", () => {
    expect(parseItemId(ID)).toBe(ID);
    expect(parseItemId(`  ${ID}\n`)).toBe(ID);
    expect(parseItemId(`[[${ID}]]`)).toBe(ID);
    expect(parseItemId(`[[${ID} | “Thought occurs to me that what makes a city culturally big (…”]]`)).toBe(ID);
    expect(parseItemId("abcdefghijklmnopqrstuvwxyz")).toBeNull(); // 26 letters, no digit: a word, not an id
    expect(parseItemId("short1")).toBeNull();
    expect(parseItemId(`see [[${ID}]] here`)).toBeNull();
    expect(parseItemId("[[First test]]")).toBeNull();
    expect(parseItemAddress(`[[${ID} | “x”]]`, null)).toEqual({ kind: "id", id: ID });
  });
});

describe("looksLikeAddress (decides the picker's \"Looking up…\" line)", () => {
  it("is true for one web address, with or without brackets, query and fragment", () => {
    expect(looksLikeAddress("https://example.com/a/b")).toBe(true);
    expect(looksLikeAddress("<https://example.com/a?x=1#top>")).toBe(true);
    expect(looksLikeAddress("[[40gscfc6bbx1hry3t769jfk7q4 | “x”]]")).toBe(true);
  });
  it("is false for words, a note name, or an address with more text", () => {
    expect(looksLikeAddress("quiet mornings")).toBe(false);
    expect(looksLikeAddress("see https://example.com/a")).toBe(false);
    expect(looksLikeAddress("")).toBe(false);
  });
});
