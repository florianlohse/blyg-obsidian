// R3 services: threads (frozen snapshots of own items), item links in fragments, kind rules, withdrawal that keeps the kind.
// Everything runs through the real publish service, the real GitHub client and the real YAML writer; the repository and the
// site are fakes (tests/world.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readLinks, readSources } from "../../src/core/sources";
import { quoteFromSelection } from "../../src/core/quote";
import { fetchQuotable } from "../../src/publish/items";
import { contentHash } from "../../src/core/hash";
import { frontmatterOf, makeWorld, repoText, tap, tapWithdraw, deploy, type World } from "../world";

const FA = "website/blyg/A.md";
const FB = "website/blyg/B.md";
const FC = "website/blyg/C.md";
const TH = "website/blyg/T.md";
const ORIGIN = "https://example.com/blyg/";

const A_HTML = "<p>Time moves down the stack, and <em>everything</em> keeps its own clock.</p>";
const B_HTML = "<p>Coordination is hard.</p>\n<p>Stigmergy is what a protocol looks like from inside. And more.</p>";
const C_HTML = "<p>Micro Time seems to be the emerging regime of the whole thing, really and truly.</p>";

const thread = (body: string): string => `---\nblyg_kind: thread\n---\n${body}`;
const itemPath = (id: string): string => `src/content/notes/${id}.md`;
/** Replace a note's text but keep its frontmatter (what typing in the editor does). */
const setBody = (w: World, path: string, body: string): void => {
  const current = w.local.get(path) ?? "";
  const front = /^---\n[\s\S]*?\n---\n/.exec(current)?.[0] ?? "";
  w.local.set(path, front + body);
};
const sourcesOf = (w: World, id: string) => readSources(frontmatterOf(repoText(w, itemPath(id)) ?? "").blyg_sources);

interface Fixture {
  w: World;
  a: string;
  b: string;
  c: string;
}

/** Three published and deployed fragments, and a thread note T (not published yet) that quotes two of them and links the third. */
async function fixture(threadBody?: (ids: { a: string; b: string; c: string }) => string): Promise<Fixture> {
  const w = makeWorld({
    vault: {
      [FA]: "Time moves down the stack, and everything keeps its own clock.\n",
      [FB]: "Coordination is hard. Stigmergy is what a protocol looks like from inside. And more.\n",
      [FC]: "Micro Time seems to be the emerging regime of the whole thing, really and truly.\n",
    },
  });
  const a = (await tap(w, FA)).id ?? "";
  const b = (await tap(w, FB)).id ?? "";
  const c = (await tap(w, FC)).id ?? "";
  deploy(w, a, A_HTML);
  deploy(w, b, B_HTML);
  deploy(w, c, C_HTML);
  const ids = { a, b, c };
  w.local.set(
    TH,
    thread(
      threadBody
        ? threadBody(ids)
        : `Opening, with a link to [[${c}]].\n\n![[${a}]]\n\nMiddle.\n\n![[${b}]]\n> Stigmergy is what a protocol looks like from inside.\n\nClosing.\n`,
    ),
  );
  w.previews.length = 0;
  return { w, ...ids };
}

describe("publishing a thread", () => {
  it("commits a thread file: kind, frozen snapshots in order, a selector for the passage, a frozen link label", async () => {
    const { w, a, b, c } = await fixture();
    w.now = "2026-10-10T07:59:00.000Z";
    const out = await tap(w, TH);
    expect(out).toMatchObject({ status: "committed", version: 1 });
    const id = out.id ?? "";
    expect(w.commits.at(-1)).toMatchObject({ path: itemPath(id), message: `content: publish thread ${id}` });

    const text = repoText(w, itemPath(id)) ?? "";
    const fm = frontmatterOf(text);
    expect(Object.keys(fm)).toEqual(["blyg", "blyg_id", "blyg_kind", "blyg_version", "blyg_created", "blyg_updated", "blyg_hash", "blyg_changelog", "blyg_sources", "blyg_links"]);
    expect(fm).toMatchObject({ blyg_id: id, blyg_kind: "thread", blyg_version: 1 });
    expect(fm.blyg_hash).toBe(await contentHash(text.split("\n---\n\n")[1]?.trimEnd() ?? ""));

    expect(sourcesOf(w, id)).toEqual([
      { id: a, version: 1, origin: ORIGIN, kind: "fragment", html: A_HTML, page: `${ORIGIN}f/${a}/`, retrieved: "2026-10-10T07:59:00.000Z" },
      {
        id: b,
        version: 1,
        origin: ORIGIN,
        kind: "fragment",
        html: B_HTML,
        page: `${ORIGIN}f/${b}/`,
        retrieved: "2026-10-10T07:59:00.000Z",
        selector: { exact: "Stigmergy is what a protocol looks like from inside.", prefix: "Coordination is hard.\n", suffix: " And more." },
      },
    ]);
    expect(readLinks(fm.blyg_links)).toEqual([
      { id: c, origin: ORIGIN, page: `${ORIGIN}f/${c}/`, label: "“Micro Time seems to be the emerging regime of the whole thin…”" },
    ]);
  });

  it("stamps the note with identity and version only: the snapshots stay in the committed copy", async () => {
    const { w } = await fixture();
    const body = (w.local.get(TH) ?? "").replace(/^---\n[\s\S]*?\n---\n/, "");
    const out = await tap(w, TH);
    const local = w.local.get(TH) ?? "";
    const fm = frontmatterOf(local);
    expect(fm).toMatchObject({ blyg_id: out.id, blyg_kind: "thread", blyg_version: 1 });
    expect(fm).not.toHaveProperty("blyg_sources");
    expect(fm).not.toHaveProperty("blyg_links");
    expect(local.endsWith(body)).toBe(true);
    expect(local).not.toContain(A_HTML);
  });

  it("shows the quotes and links in the write preview before anything is committed", async () => {
    const { w, a, b, c } = await fixture();
    await tap(w, TH);
    const preview = w.previews.at(-1);
    expect(preview).toMatchObject({ action: "create", label: "thread", toVersion: 1 });
    expect(preview?.thread?.quotes).toEqual([
      { id: a, version: 1, kind: "fragment", passage: null, excerpt: "Time moves down the stack, and everything keeps its own clock.", change: "new" },
      { id: b, version: 1, kind: "fragment", passage: "Stigmergy is what a protocol looks like from inside.", excerpt: "Coordination is hard. Stigmergy is what a protocol looks like from inside. And m…", change: "new" },
    ]);
    expect(preview?.thread?.itemLinks).toEqual([{ id: c, label: "“Micro Time seems to be the emerging regime of the whole thin…”", isNew: true }]);
    expect(preview?.changes.some((line) => line.includes("new"))).toBe(true);
  });

  it("answering no commits nothing", async () => {
    const { w } = await fixture();
    w.answer = false;
    const before = w.commits.length;
    expect((await tap(w, TH)).status).toBe("cancelled");
    expect(w.commits).toHaveLength(before);
  });

  it("matches the site's golden file: the same structure the site's reader parses", async () => {
    const goldenText = readFileSync(new URL("../fixtures/site/threads/thread-two-sources.md", import.meta.url), "utf8");
    const golden = frontmatterOf(goldenText);
    const ids = ["7c9wk2mhq0v3xj8tn5rzfd41bg", "1vgtgz0gq5b2c9k7d3m8r4n6xy", "3d7mnhr5g0kq8v2wxb4tjy6fz9"];
    const w = makeWorld({ settings: { origin: "https://example.org/blyg/" } });
    const goldenSources = readSources(golden.blyg_sources) ?? [];
    ids.forEach((id, i) => {
      w.repo.set(itemPath(id), {
        sha: `sha${i}`,
        text: `---\nblyg: "0.2"\nblyg_id: ${id}\nblyg_version: ${i === 0 ? 3 : 1}\nblyg_created: 2026-10-01T00:00:00.000Z\nblyg_updated: 2026-10-01T00:00:00.000Z\nblyg_hash: sha256:00\nblyg_changelog:\n  - version: 1\n    at: 2026-10-01T00:00:00.000Z\n    note:\n---\n\nbody\n`,
      });
    });
    w.settings.origin = "https://example.org/blyg/";
    w.local.set("website/essays/Shitty Castles.md", "---\ntitle: Shitty Castles\n---\nAn essay.\n"); // the golden thread links to it by name
    deploy(w, ids[0] as string, goldenSources[0]?.html ?? "", { author: goldenSources[0]?.author });
    deploy(w, ids[1] as string, goldenSources[1]?.html ?? "");
    deploy(w, ids[2] as string, "<p>Micro Time seems to be the emerging regime…</p>");
    w.now = "2026-10-10T07:59:00.000Z";
    w.local.set(TH, `---\nblyg_kind: thread\n---\n${goldenText.replace(/^---\n[\s\S]*?\n---\n/, "")}`);
    const out = await tap(w, TH);
    expect(out.status, out.notices.join(" ")).toBe("committed");

    const ours = sourcesOf(w, out.id ?? "") ?? [];
    expect(ours).toHaveLength(2);
    for (const [i, theirs] of goldenSources.entries()) {
      const mine = ours[i];
      expect(mine).toMatchObject({ id: theirs.id, version: theirs.version, origin: theirs.origin, kind: theirs.kind, html: theirs.html, page: theirs.page, ...(theirs.author ? { author: theirs.author } : {}) });
      expect(new Date(mine?.retrieved ?? "").toISOString()).toBe(new Date(theirs.retrieved).toISOString());
      expect(mine?.selector?.exact).toBe(theirs.selector?.exact);
    }
    expect(Object.keys(frontmatterOf(repoText(w, itemPath(out.id ?? "")) ?? "")).filter((k) => k.startsWith("blyg") && k !== "blyg_id")).toEqual(Object.keys(golden).filter((k) => k !== "blyg_id"));
  });
});

describe("republishing a thread", () => {
  it("is a no-op when nothing changed, and then reads nothing from the site: the snapshots are already frozen", async () => {
    const { w } = await fixture();
    await tap(w, TH);
    w.siteRequests.length = 0;
    w.previews.length = 0;
    const out = await tap(w, TH);
    expect(out).toMatchObject({ status: "noop" });
    expect(w.siteRequests).toEqual([]);
    expect(w.previews).toEqual([]);
  });

  it("a source that moved to a new version makes a new thread version even though the thread's text did not change", async () => {
    const { w, a, b } = await fixture();
    const first = await tap(w, TH);
    const id = first.id ?? "";
    const before = sourcesOf(w, id) ?? [];

    w.now = "2026-10-11T09:00:00.000Z";
    w.local.set(FA, (w.local.get(FA) ?? "").replace("its own clock", "its own clocks"));
    expect((await tap(w, FA)).version).toBe(2);
    deploy(w, a, "<p>Time moves down the stack, and <em>everything</em> keeps its own clocks.</p>");

    w.previews.length = 0;
    const out = await tap(w, TH);
    expect(out).toMatchObject({ status: "committed", version: 2, id });
    expect(w.commits.at(-1)?.message).toBe(`content: update thread ${id} to v2`);
    const after = sourcesOf(w, id) ?? [];
    expect(after[0]).toMatchObject({ id: a, version: 2, html: "<p>Time moves down the stack, and <em>everything</em> keeps its own clocks.</p>", retrieved: "2026-10-11T09:00:00.000Z" });
    // the untouched quote keeps its snapshot, byte for byte, including when it was taken
    expect(after[1]).toEqual(before[1]);
    expect(after[1]?.id).toBe(b);
    expect(w.previews[0]?.thread?.quotes.map((q) => [q.change, q.fromVersion])).toEqual([["moved", 1], ["unchanged", undefined]]);
    expect(w.previews[0]?.changes.join(" ")).toContain("moves from v1 to v2");
  });

  it("a changed text with the same sources keeps every frozen snapshot and link label", async () => {
    const { w, c } = await fixture();
    const id = (await tap(w, TH)).id ?? "";
    const before = frontmatterOf(repoText(w, itemPath(id)) ?? "");
    w.local.set(TH, (w.local.get(TH) ?? "").replace("Closing.", "A better closing."));
    // the link target changes meanwhile: the label was frozen at publish and stays
    deploy(w, c, "<p>Something else entirely now.</p>");
    expect((await tap(w, TH)).version).toBe(2);
    const after = frontmatterOf(repoText(w, itemPath(id)) ?? "");
    expect(after.blyg_sources).toEqual(before.blyg_sources);
    expect(after.blyg_links).toEqual(before.blyg_links);
  });

  it("survives a snapshot full of quotes, newlines and odd characters: the committed file reads back as the same string", async () => {
    const { w, a } = await fixture();
    const html = `<p>“Curly” and "straight" and 'single', a \\ backslash, a tab\there,</p>\n<p>line sep ${String.fromCharCode(0x2028)} para sep ${String.fromCharCode(0x2029)} nel ${String.fromCharCode(0x85)} & <b>tags</b> ünïcödé 日本語 😀</p>`;
    deploy(w, a, html);
    const id = (await tap(w, TH)).id ?? "";
    expect(sourcesOf(w, id)?.[0]?.html).toBe(html);
    expect((await tap(w, TH)).status).toBe("noop"); // read back and compared: still the same sources
  });

  it("a thread whose quotes were all taken out publishes with an empty source list and needs no site", async () => {
    const { w } = await fixture(() => "Just words now, no quotes.\n");
    delete (w.deps as { site?: unknown }).site;
    const out = await tap(w, TH);
    expect(out.status, out.notices.join(" ")).toBe("committed");
    expect(repoText(w, itemPath(out.id ?? ""))).toContain("blyg_sources: []\n");
  });
});

describe("what stops a thread before anything is committed", () => {
  const stops = async (f: Fixture, expected: RegExp): Promise<void> => {
    const commits = f.w.commits.length;
    const previews = f.w.previews.length;
    const out = await tap(f.w, TH);
    expect(out.status).toBe("refused");
    expect(out.notices.join("\n")).toMatch(expected);
    expect(f.w.commits).toHaveLength(commits);
    expect(f.w.previews).toHaveLength(previews);
  };

  it("an id that is not one of your published items", async () => {
    const f = await fixture(() => "![[0123456789abcdefghjkmnpqrs]]\n");
    await stops(f, /line 1: no published item 0123456789abcdefghjkmnpqrs on main/);
  });

  it("a source that is withdrawn", async () => {
    const f = await fixture();
    await tapWithdraw(f.w, FA);
    await stops(f, /is withdrawn/);
  });

  it("a source whose new version is committed but not yet deployed", async () => {
    const f = await fixture();
    f.w.local.set(FA, (f.w.local.get(FA) ?? "") + "More.\n");
    await tap(f.w, FA);
    await stops(f, /v2 is committed but the site still serves v1/);
  });

  it("a source that is committed but the site does not know at all yet", async () => {
    const f = await fixture();
    f.w.site.clear();
    await stops(f, /is committed but the site does not serve it yet/);
  });

  it("a passage that is not in the source, and the curly-quote hint when it has a straight quote", async () => {
    const f = await fixture();
    deploy(f.w, f.b, "<p>She said “yes” and it’s done.</p>");
    f.w.local.set(TH, thread(`![[${f.b}]]\n> She said "yes"\n`));
    await stops(f, /not in .* v1.*curly characters/s);
    f.w.local.set(TH, thread(`![[${f.b}]]\n> Something else entirely\n`));
    await stops(f, /not in .* v1\. The source may have changed/);
  });

  it("a passage written with Markdown the plugin does not cover, with what to do about it", async () => {
    const f = await fixture();
    f.w.local.set(TH, thread(`![[${f.a}]]\n> everything keeps *its own* clock\n`));
    await stops(f, /Line 1: this passage cannot be published as written.*emphasis.*Insert quote/s);
  });

  it("an empty quote", async () => {
    const f = await fixture();
    f.w.local.set(TH, thread(`![[${f.a}]]\n>\n`));
    await stops(f, /Line 1: the quote under this directive is empty/);
  });

  it("an explicit version, and an id that might be inside code", async () => {
    const f = await fixture();
    f.w.local.set(TH, thread(`![[${f.a}@v1]]\n`));
    await stops(f, /explicit versions/);
    f.w.local.set(TH, thread("```\ncode\n```\n\n![[" + f.a + "]]\n"));
    await stops(f, /code block/);
  });

  it("collects every problem, not just the first", async () => {
    const f = await fixture(() => "![[0123456789abcdefghjkmnpqrs]]\n\n![[0123456789abcdefghjkmnpqrt]]\n");
    await stops(f, /2 problems/);
  });

  it("a note without a blyg address or without a way to read the site", async () => {
    const f = await fixture();
    f.w.settings.origin = "";
    await stops(f, /needs the blyg address/);
    f.w.settings.origin = "http://example.com/blyg/";
    await stops(f, /needs the blyg address/);
    f.w.settings.origin = ORIGIN;
    delete (f.w.deps as { site?: unknown }).site;
    await stops(f, /no way to read the site/);
  });

  it("an unknown blyg_kind", async () => {
    const f = await fixture();
    f.w.local.set(TH, "---\nblyg_kind: essay\n---\nWords\n");
    await stops(f, /blyg_kind is “essay”/);
  });

  it("a network failure reading the site is a failure, not a refusal, and commits nothing", async () => {
    const f = await fixture();
    (f.w.deps.site as { getJson: () => Promise<never> }).getJson = () => Promise.reject(new Error("offline"));
    const out = await tap(f.w, TH);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/Network/);
  });

  it("a thread cannot quote a thread that quotes it, nor itself", async () => {
    const { w } = await fixture();
    w.local.set("website/blyg/Y.md", thread("Y says words.\n"));
    const y = (await tap(w, "website/blyg/Y.md")).id ?? "";
    deploy(w, y, "<p>Y says words.</p>");
    w.local.set(TH, thread(`![[${y}]]\n\nT adds a word.\n`));
    const t = (await tap(w, TH)).id ?? "";
    deploy(w, t, `<blockquote class="blyg-transclusion" data-blyg-id="${y}" data-blyg-version="1"><p>Y says words.</p></blockquote>`);

    w.local.set("website/blyg/Y.md", (w.local.get("website/blyg/Y.md") ?? "") + `\n![[${t}]]\n`);
    const cycle = await tap(w, "website/blyg/Y.md");
    expect(cycle.status).toBe("refused");
    expect(cycle.notices[0]).toMatch(/would quote itself through/);

    w.local.set("website/blyg/Y.md", (w.local.get("website/blyg/Y.md") ?? "").replace(`![[${t}]]`, `![[${y}]]`));
    expect((await tap(w, "website/blyg/Y.md")).notices[0]).toMatch(/would quote itself/);
  });

  it("a thread may quote a thread that does not quote it (nesting)", async () => {
    const { w } = await fixture();
    const first = (await tap(w, TH)).id ?? "";
    deploy(w, first, "<blockquote class=\"blyg-transclusion\"><p>nested</p></blockquote>");
    w.local.set("website/blyg/U.md", thread(`![[${first}]]\n`));
    const out = await tap(w, "website/blyg/U.md");
    expect(out.status, out.notices.join(" ")).toBe("committed");
    expect(sourcesOf(w, out.id ?? "")?.[0]).toMatchObject({ id: first, kind: "thread", page: `${ORIGIN}t/${first}/` });
  });
});

describe("partial quotes", () => {
  it("a passage inserted the way the picker writes it is accepted, curly quotes and all", async () => {
    const f = await fixture();
    deploy(f.w, f.b, "<p>She said “yes” and it’s *done* [sic].</p>");
    const selected = "“yes” and it’s *done* [sic]";
    const quote = quoteFromSelection(selected) ?? "";
    f.w.local.set(TH, thread(`![[${f.b}]]\n${quote}\n`));
    const out = await tap(f.w, TH);
    expect(out.status, out.notices.join(" ")).toBe("committed");
    expect(sourcesOf(f.w, out.id ?? "")?.[0]?.selector?.exact).toBe(selected);
  });

  it("a passage across two paragraphs keeps one line break", async () => {
    const f = await fixture();
    f.w.local.set(TH, thread(`![[${f.b}]]\n> hard.\n>\n> Stigmergy is what\n`));
    const out = await tap(f.w, TH);
    expect(out.status, out.notices.join(" ")).toBe("committed");
    expect(sourcesOf(f.w, out.id ?? "")?.[0]?.selector?.exact).toBe("hard.\nStigmergy is what");
  });
});

describe("fragments and item links", () => {
  it("a fragment may carry item links: blyg_links, no blyg_kind, no sources", async () => {
    const { w, c } = await fixture();
    setBody(w, FA, `See [[${c}]] too.\n`);
    const out = await tap(w, FA);
    expect(out).toMatchObject({ status: "committed", version: 2 });
    const fm = frontmatterOf(repoText(w, itemPath(out.id ?? "")) ?? "");
    expect(fm).not.toHaveProperty("blyg_kind");
    expect(fm).not.toHaveProperty("blyg_sources");
    expect(readLinks(fm.blyg_links)).toEqual([{ id: c, origin: ORIGIN, page: `${ORIGIN}f/${c}/`, label: "“Micro Time seems to be the emerging regime of the whole thin…”" }]);
    expect(w.previews.at(-1)?.thread?.itemLinks).toHaveLength(1);
    expect((await tap(w, FA)).status).toBe("noop");
  });

  it("a fragment cannot quote", async () => {
    const { w, a } = await fixture();
    setBody(w, FB, `Intro\n\n![[${a}]]\n`);
    const out = await tap(w, FB);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/line 3 quotes another item, which only a thread can do/);
  });

  it("a link to something that is not published stops the publish", async () => {
    const { w } = await fixture();
    w.local.set(FA, "See [[0123456789abcdefghjkmnpqrs]].\n");
    const out = await tap(w, FA);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/The link \[\[01234567…\]\]: no published item/);
  });

  it("a fragment without item links is committed exactly as before: no site read, no extra keys", async () => {
    const w = makeWorld({ vault: { [FA]: "Plain words.\n" } });
    const out = await tap(w, FA);
    expect(w.siteRequests).toEqual([]);
    expect(Object.keys(frontmatterOf(repoText(w, itemPath(out.id ?? "")) ?? ""))).toEqual(["blyg", "blyg_id", "blyg_version", "blyg_created", "blyg_updated", "blyg_hash", "blyg_changelog"]);
  });

  it("an essay-style wikilink is not an item link and is judged as before", async () => {
    const w = makeWorld({ vault: { [FA]: "See [[Shitty Castles]].\n" } });
    const out = await tap(w, FA);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/Shitty Castles/);
    expect(w.siteRequests).toEqual([]);
  });
});

describe("the kind never changes", () => {
  it("a published fragment turned into a thread is refused before any read of the quoted items", async () => {
    const { w, a } = await fixture();
    w.local.set(FB, (w.local.get(FB) ?? "").replace(/^---\n/, "---\nblyg_kind: thread\n"));
    setBody(w, FB, `Now quoting.\n\n![[${a}]]\n`);
    w.calls.length = 0;
    const out = await tap(w, FB);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/this note is a thread, but .* already published as a fragment/);
    // refused on what the repository says about its own item, before the quoted item is read from anywhere
    const ownId = String(frontmatterOf(w.local.get(FB) ?? "").blyg_id);
    expect(w.calls).toEqual([`GET ${itemPath(ownId)}`]);
    expect(w.siteRequests).toEqual([]);
  });

  it("a published thread with its blyg_kind removed is refused", async () => {
    const { w } = await fixture(() => "A thread with no quotes yet.\n");
    await tap(w, TH);
    w.local.set(TH, (w.local.get(TH) ?? "").replace("blyg_kind: thread\n", ""));
    const out = await tap(w, TH);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/this note is a fragment, but .* already published as a thread/);
  });

  it("a published thread with its blyg_kind removed and quotes in it is told the same, not just 'a fragment cannot quote'", async () => {
    const { w } = await fixture();
    await tap(w, TH);
    w.local.set(TH, (w.local.get(TH) ?? "").replace("blyg_kind: thread\n", ""));
    const out = await tap(w, TH);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/only a thread can do.*kind of a published item never changes/s);
  });
});

describe("withdrawing a thread", () => {
  it("keeps the kind, empties the sources, never touches the local text — and a later publish brings it back", async () => {
    const { w } = await fixture();
    const first = await tap(w, TH);
    const id = first.id ?? "";
    const localBefore = w.local.get(TH) ?? "";
    w.now = "2026-10-12T09:00:00.000Z";
    const out = await tapWithdraw(w, TH);
    expect(out).toMatchObject({ status: "committed", version: 2 });
    expect(w.commits.at(-1)?.message).toBe(`content: withdraw thread ${id} (v2)`);
    const text = repoText(w, itemPath(id)) ?? "";
    expect(text.endsWith("blyg_sources: []\n---\n")).toBe(true);
    expect(text).not.toContain("blyg_links");
    expect(frontmatterOf(text)).toMatchObject({ blyg_kind: "thread", blyg_withdrawn: true, blyg_version: 2, blyg_sources: [] });
    expect(w.previews.at(-1)?.changes.join(" ")).toMatch(/quotes in the thread are removed/);
    const local = w.local.get(TH) ?? "";
    expect(local.replace(/^---\n[\s\S]*?\n---\n/, "")).toBe(localBefore.replace(/^---\n[\s\S]*?\n---\n/, ""));
    expect(frontmatterOf(local)).toMatchObject({ blyg_kind: "thread", blyg_withdrawn: true });
    expect(frontmatterOf(local)).not.toHaveProperty("blyg_sources");

    w.now = "2026-10-13T09:00:00.000Z";
    const again = await tap(w, TH);
    expect(again).toMatchObject({ status: "committed", version: 3 });
    const back = frontmatterOf(repoText(w, itemPath(id)) ?? "");
    expect(back).not.toHaveProperty("blyg_withdrawn");
    expect(back.blyg_kind).toBe("thread");
    expect(sourcesOf(w, id)).toHaveLength(2);
  });
});

describe("the test channel", () => {
  it("reads and stamps with the preview branch and the preview address", async () => {
    const w = makeWorld({ settings: { channel: "preview", branch: "preview", origin: "https://preview.example.pages.dev/blyg/" } });
    w.local.set(FA, "Words.\n");
    const a = (await tap(w, FA)).id ?? "";
    deploy(w, a, "<p>Words.</p>");
    w.local.set(TH, thread(`![[${a}]]\n`));
    w.refs.length = 0;
    const out = await tap(w, TH);
    expect(out.status, out.notices.join(" ")).toBe("committed");
    expect(new Set(w.refs)).toEqual(new Set(["preview"]));
    expect(sourcesOf(w, out.id ?? "")?.[0]).toMatchObject({ origin: "https://preview.example.pages.dev/blyg/", page: `https://preview.example.pages.dev/blyg/f/${a}/` });
    expect(w.siteRequests).toEqual([`https://preview.example.pages.dev/blyg/items/${a}.json`]);
  });
});

describe("the soft limit", () => {
  it("warns above it, never refuses", async () => {
    const w = makeWorld({ settings: { threadSoftCap: 20 }, vault: { [TH]: thread("A thread of more than twenty characters.\n") } });
    const out = await tap(w, TH);
    expect(out.status).toBe("committed");
    expect(out.notices.join(" ")).toMatch(/over the soft limit of 20/);
  });

  it("threads have no length cap of the fragment kind", async () => {
    const w = makeWorld({ vault: { [TH]: thread("x".repeat(5000)) } });
    expect((await tap(w, TH)).status).toBe("committed");
  });
});

// The files the plugin commits, written out so they can be dropped into a scratch checkout of the site and run through its own
// `npm run build` and `npm test` (docs/TESTING.md layer 4; the recipe is in docs/R3-SITE-CHECK.md). Two passes, because a thread
// quotes the HTML the site really serves: pass 1 writes the fragments, the site builds them, `html.json` (label → content_html)
// is written from the built item documents, and pass 2 publishes threads that quote exactly that HTML.
describe("contract fixtures for the site's own build", () => {
  it("writes the fragments, threads and a withdrawn thread to tests/fixtures/out/threads/", async () => {
    const out = new URL("../fixtures/out/threads/", import.meta.url);
    mkdirSync(new URL("notes/", out), { recursive: true });
    const real: Record<string, string> = existsSync(new URL("html.json", out)) ? (JSON.parse(readFileSync(new URL("html.json", out), "utf8")) as Record<string, string>) : {};

    const w = makeWorld({
      settings: { origin: "https://example.org/blyg/" }, // the site's own origin, so its checks treat the sources as its own
      vault: {
        [FA]: "Time moves down the stack, and *everything* keeps its own clock. It's \"relative\" & weird.\n",
        [FB]: "Coordination is hard.\n\nStigmergy is what a protocol looks like from inside. And more.\n",
        [FC]: "Micro Time seems to be the emerging regime of the whole thing, really and truly.\n",
      },
    });
    w.now = "2026-10-10T07:00:00.000Z";
    const a = (await tap(w, FA)).id ?? "";
    const b = (await tap(w, FB)).id ?? "";
    const c = (await tap(w, FC)).id ?? "";
    const fallback: Record<string, string> = {
      A: "<p>Time moves down the stack, and <em>everything</em> keeps its own clock. It’s “relative” &amp; weird.</p>",
      B: "<p>Coordination is hard.</p>\n<p>Stigmergy is what a protocol looks like from inside. And more.</p>",
      C: "<p>Micro Time seems to be the emerging regime of the whole thing, really and truly.</p>",
    };
    deploy(w, a, real.A ?? fallback.A ?? "");
    deploy(w, b, real.B ?? fallback.B ?? "");
    deploy(w, c, real.C ?? fallback.C ?? "");

    // The passage is selected from the RENDERED text, as the picker does.
    const passage = quoteFromSelection("It’s “relative” & weird.") ?? "";
    expect(passage).not.toBe("");
    w.local.set(
      TH,
      thread(`Opening, with a link to [[${c}]].\n\n![[${a}]]\n\nA passage, taken from the rendered text:\n\n![[${a}]]\n${passage}\n\n![[${b}]]\n> Coordination is hard.\n>\n> Stigmergy is what a protocol looks like from inside.\n\nClosing.\n`),
    );
    w.now = "2026-10-10T08:00:00.000Z";
    const t = await tap(w, TH);
    expect(t.status, t.notices.join(" ")).toBe("committed");
    const tid = t.id ?? "";

    const ids: Record<string, string> = { A: a, B: b, C: c, T: tid };
    const files: Record<string, string> = { [a]: "", [b]: "", [c]: "", [tid]: "" };

    // A thread of threads, once the site has built the first thread (pass 2 has its HTML).
    if (real.T) {
      deploy(w, tid, real.T);
      w.local.set("website/blyg/U.md", thread(`Nesting: a thread inside a thread.\n\n![[${tid}]]\n`));
      w.now = "2026-10-10T09:00:00.000Z";
      const u = await tap(w, "website/blyg/U.md");
      expect(u.status, u.notices.join(" ")).toBe("committed");
      ids.U = u.id ?? "";
      files[u.id ?? ""] = "";
    }

    // A withdrawn thread keeps its page.
    w.local.set("website/blyg/W.md", thread(`Soon withdrawn.\n\n![[${b}]]\n`));
    w.now = "2026-10-10T10:00:00.000Z";
    const wd = await tap(w, "website/blyg/W.md");
    w.now = "2026-10-10T11:00:00.000Z";
    expect((await tapWithdraw(w, "website/blyg/W.md")).status).toBe("committed");
    ids.W = wd.id ?? "";
    files[wd.id ?? ""] = "";

    for (const id of Object.keys(files)) writeFileSync(new URL(`notes/${id}.md`, out), repoText(w, itemPath(id)) ?? "");
    writeFileSync(new URL("ids.json", out), JSON.stringify(ids, null, 2));
  });
});

describe("fetchQuotable (what the quote picker reads)", () => {
  it("returns the text a reader sees, one line per block, for a published and deployed item", async () => {
    const { w, b } = await fixture();
    const got = await fetchQuotable(w.deps, b);
    expect(got).toEqual({
      ok: true,
      id: b,
      version: 1,
      kind: "fragment",
      html: B_HTML,
      text: "Coordination is hard.\nStigmergy is what a protocol looks like from inside. And more.",
    });
    expect(w.commits.length).toBe(3); // reading writes nothing
  });

  it("says why not: unknown id, withdrawn, not deployed yet, no address, a malformed id", async () => {
    const { w, a, b } = await fixture();
    const refusal = async (id: string): Promise<string> => {
      const got = await fetchQuotable(w.deps, id);
      return got.ok ? "OK" : got.outcome.notices.join(" ");
    };
    expect(await refusal("0123456789abcdefghjkmnpqrs")).toMatch(/no published item/);
    expect(await refusal("../../etc")).toMatch(/not a valid Blyg id/);
    await tapWithdraw(w, FA);
    expect(await refusal(a)).toMatch(/withdrawn/);
    w.site.delete(`${ORIGIN}items/${b}.json`);
    expect(await refusal(b)).toMatch(/does not serve it yet/);
    w.settings.origin = "";
    expect(await refusal(b)).toMatch(/needs the blyg address/);
  });
});

describe("names in the vault, ids on the wire", () => {
  it("a thread written with note names commits the same file as one written with ids, and the vault note keeps its names", async () => {
    const byName = await fixture(() => "Opening, with a link to [[C]].\n\n![[A]]\n\nMiddle.\n\n![[B]]\n> Stigmergy is what a protocol looks like from inside.\n\nClosing.\n");
    const byId = await fixture();
    byName.w.now = byId.w.now = "2026-10-10T07:59:00.000Z";
    const named = await tap(byName.w, TH);
    const ided = await tap(byId.w, TH);
    expect(named.status, named.notices.join(" ")).toBe("committed");
    const normalise = (text: string, id: string): string => text.replaceAll(id, "THREAD");
    expect(normalise(repoText(byName.w, itemPath(named.id ?? "")) ?? "", named.id ?? "")).toBe(normalise(repoText(byId.w, itemPath(ided.id ?? "")) ?? "", ided.id ?? ""));
    const committed = repoText(byName.w, itemPath(named.id ?? "")) ?? "";
    expect(committed).toContain(`![[${byName.a}]]`);
    expect(committed).not.toContain("![[A]]");
    const local = byName.w.local.get(TH) ?? "";
    expect(local).toContain("![[A]]");
    expect(local).toContain("[[C]]");
    expect(local).not.toContain(byName.a);
  });

  it("republishing is a no-op: the translated text is what is compared", async () => {
    const f = await fixture(() => "![[A]]\n\nWords.\n");
    await tap(f.w, TH);
    expect((await tap(f.w, TH)).status).toBe("noop");
  });

  it("an item link to a Blyg note by name becomes an id link in a fragment too; an essay link stays an essay link", async () => {
    const { w, c } = await fixture();
    w.local.set("website/essays/Castles.md", "---\ntitle: Castles\n---\nText.\n");
    setBody(w, FA, "See [[C]] and [[Castles]].\n");
    const out = await tap(w, FA);
    expect(out.status, out.notices.join(" ")).toBe("committed");
    const text = repoText(w, itemPath(out.id ?? "")) ?? "";
    expect(text).toContain(`[[${c}]] and [[Castles]]`);
    expect(readLinks(frontmatterOf(text).blyg_links)?.map((l) => l.id)).toEqual([c]);
  });

  const stops = async (f: Fixture, expected: RegExp): Promise<void> => {
    const commits = f.w.commits.length;
    const out = await tap(f.w, TH);
    expect(out.status).toBe("refused");
    expect(out.notices.join("\n")).toMatch(expected);
    expect(f.w.commits).toHaveLength(commits);
  };

  it("a quoted note that is not published yet: refused, saying which line and what to do", async () => {
    const f = await fixture(() => "Intro.\n\n![[Draft]]\n");
    f.w.local.set("website/blyg/Draft.md", "Not published.\n");
    await stops(f, /line 3: “Draft” is not published yet\. Publish it first/);
  });

  it("a withdrawn note, an essay and a heading embed are refused with their own reasons", async () => {
    const f = await fixture(() => "![[A]]\n");
    await tapWithdraw(f.w, FA);
    await stops(f, /line 1: “A” is withdrawn/);
    f.w.local.set("website/essays/Castles.md", "---\ntitle: Castles\n---\nText.\n");
    f.w.local.set(TH, thread("![[Castles]]\n"));
    await stops(f, /“Castles” is an essay or a page/);
    f.w.local.set(TH, thread("![[B#Heading]]\n"));
    await stops(f, /embeds a heading, a block or a size/);
  });

  it("a name embed in a fragment is refused like an id one: only a thread can quote", async () => {
    const { w } = await fixture();
    setBody(w, FB, "Intro\n\n![[A]]\n");
    const out = await tap(w, FB);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/line 3 quotes another item, which only a thread can do/);
  });

  it("code still blocks: a translated embed inside a code block is refused, never published as a quote", async () => {
    const f = await fixture(() => "```\n![[A]]\n```\n");
    await stops(f, /code block/);
  });

  it("an embed that is not a whole-line quote of a Blyg note is refused: the site shows it as literal brackets and its build check refuses to deploy it", async () => {
    const f = await fixture(() => "Text ![[A]] inline.\n");
    await stops(f, /line 1: !\[\[A\]\] inline\./);
    for (const body of ["An image ![[pic.png]] here.\n", "![[![[0123456789abcdefghjkmnpqrs]]\n", "![[A]]`\n", "Fine\n\n![[Some essay or image.png]]\n"]) {
      f.w.local.set(TH, thread(body));
      await stops(f, /the site shows notes as plain text/);
    }
  });

  it("an embed inside code is not an embed; a whole-line quote and its passage are not left over", async () => {
    const f = await fixture(() => "Code `![[A]]` is fine.\n\n![[A]]\n\n![[B]]\n> Stigmergy is what a protocol looks like from inside.\n");
    const out = await tap(f.w, TH);
    expect(out.status, out.notices.join(" ")).toBe("committed");
  });

  it("a fragment with an image embed is refused too (it would break the deploy), with the line", async () => {
    const w = makeWorld({ vault: { [FA]: "Words.\n\n![[pic.png]]\n" } });
    const out = await tap(w, FA);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/line 3: !\[\[pic\.png\]\]/);
    expect(w.commits).toHaveLength(0);
  });
});
