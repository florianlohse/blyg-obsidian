// Threads, quotes and links through a Studio (S2.2): names in the vault become ids on the wire, items of other blygs are quoted as
// `![[id | label]]`, the Studio's preview is shown with what it resolved, and the optional change note travels with a new version.
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import { M } from "../../src/publish/messages";
import { cleanLabel, panelLines, prepareStudioText, scanStudioQuotes } from "../../src/studio/text";
import { frontmatterOf } from "../world";
import { STUDIO_ORIGIN, idOf } from "./fake-studio";
import { makeStudioWorld, tapStudio, type StudioWorld } from "./world";

const FRAG = "studio/Fragment one.md";
const THREAD = "studio/Thread one.md";
const REMOTE = "095s4h48j67mnbf6hq8vatc2d4";
const thread = (body: string, extra = ""): string => `---\nblyg_kind: thread\n${extra}---\n${body}`;
const fm = (w: StudioWorld, path: string): Record<string, unknown> => frontmatterOf(w.local.get(path) ?? "");

/** A world with one published fragment, "Fragment one", whose id is the first the fake Studio hands out. */
async function withFragment(extra: Record<string, string> = {}): Promise<{ w: StudioWorld; fragId: string }> {
  const w = makeStudioWorld({ vault: { [FRAG]: "First fragment. It has two sentences.\n", ...extra } });
  const out = await tapStudio(w, FRAG);
  expect(out.status).toBe("published");
  return { w, fragId: out.id ?? "" };
}

describe("names become ids", () => {
  it("a thread that quotes a note of this Studio by name is sent with the id, and kept as a thread", async () => {
    const { w, fragId } = await withFragment({ [THREAD]: thread("My thought.\n\n![[Fragment one]]\n\nMore.\n") });
    const out = await tapStudio(w, THREAD);
    expect(out).toMatchObject({ status: "published", version: 1 });
    const sent = w.studio.items.get(out.id ?? "");
    expect(sent).toMatchObject({ kind: "thread", content_md: `My thought.\n\n![[${fragId}]]\n\nMore.` });
    expect(fm(w, THREAD)).toMatchObject({ blyg_kind: "thread", blyg_origin: STUDIO_ORIGIN, blyg_id: out.id, blyg_version: 1, blyg_url: `${STUDIO_ORIGIN}t/${out.id}/` });
    // the note itself still says the name: the vault reads it, Obsidian follows renames
    expect(w.local.get(THREAD)).toContain("![[Fragment one]]");
    // the stamp hashes what was sent
    expect(fm(w, THREAD).blyg_sent).toBe(await contentHash(`My thought.\n\n![[${fragId}]]\n\nMore.`));
  });

  it("keeps the passage lines of a partial quote and shows the Studio's reading of them in the window", async () => {
    const { w, fragId } = await withFragment({ [THREAD]: thread("![[Fragment one]]\n> It has two sentences.\n\nAnd I say so.\n") });
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("published");
    expect(w.studio.items.get(out.id ?? "")?.content_md).toBe(`![[${fragId}]]\n> It has two sentences.\n\nAnd I say so.`);
    const quotes = w.previews.at(-1)?.studio?.quotes;
    expect(quotes).toEqual([{ id: fragId, version: 1, passage: "It has two sentences.", remote: false, label: null }]);
  });

  it("turns [[Name]] and [[Name|text]] into item links, in a thread and in a fragment", async () => {
    const { w, fragId } = await withFragment({ [THREAD]: thread("See [[Fragment one]] and [[Fragment one|that one]].\n"), "studio/Linker.md": "Compare [[Fragment one]].\n" });
    expect((await tapStudio(w, THREAD)).status).toBe("published");
    expect(w.studio.items.get(idOf(2))?.content_md).toBe(`See [[${fragId}]] and [[${fragId} | that one]].`);
    expect((await tapStudio(w, "studio/Linker.md")).status).toBe("published");
    expect(w.studio.items.get(idOf(3))?.content_md).toBe(`Compare [[${fragId}]].`);
  });

  it("leaves code alone: a name in a code span or fence is not a link", async () => {
    const { w } = await withFragment({ [THREAD]: thread("Write `[[Fragment one]]` like this.\n\n```\n[[Fragment one]]\n![[Fragment one]]\n```\n") });
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("published");
    expect(w.studio.items.get(out.id ?? "")?.content_md).toBe("Write `[[Fragment one]]` like this.\n\n```\n[[Fragment one]]\n![[Fragment one]]\n```");
  });

  it("passes through ids, with or without a label, exactly as written", async () => {
    const w = makeStudioWorld({ vault: { [THREAD]: thread(`![[${REMOTE} | Blog B: Remote fragment]]\n\nand [[${REMOTE} | that]] and [[${REMOTE}]]\n`) } });
    w.studio.importItem({ remote_id: REMOTE, content_md: "Remote fragment text." });
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("published");
    expect(w.studio.items.get(out.id ?? "")?.content_md).toBe(`![[${REMOTE} | Blog B: Remote fragment]]\n\nand [[${REMOTE} | that]] and [[${REMOTE}]]`);
    expect(w.previews.at(-1)?.studio?.quotes).toEqual([{ id: REMOTE, version: 1, passage: null, remote: true, label: "Blog B: Remote fragment" }]);
  });
});

describe("what is refused before any request", () => {
  const cases: Array<[string, Record<string, string>, string, RegExp]> = [
    ["a note that is not published yet", { "studio/Draft.md": "Unpublished.\n" }, "![[Draft]]", /“Draft” is not published yet/],
    ["a withdrawn note", { "studio/Gone.md": "---\nblyg_origin: https://studio.test/\nblyg_id: a0000000000000000000000009\nblyg_withdrawn: true\n---\nx\n" }, "![[Gone]]", /“Gone” is withdrawn/],
    ["a note with the old blyg's id and no origin", { "studio/Old.md": "---\nblyg_id: a0000000000000000000000009\nblyg_version: 3\n---\nx\n" }, "![[Old]]", /“Old” was published to your site's old blyg/],
    ["a note stamped for another blyg", { "studio/Other.md": "---\nblyg_origin: https://elsewhere.test/\nblyg_id: a0000000000000000000000009\n---\nx\n" }, "![[Other]]", /“Other” belongs to another blyg \(https:\/\/elsewhere.test\/\)/],
    ["a note with a damaged record", { "studio/Bad.md": "---\nblyg_origin: https://studio.test/\n---\nx\n" }, "[[Bad]]", /“Bad” has a damaged Studio record/],
    ["a quote of an essay", { "website/essays/Essay.md": "---\ntitle: T\n---\nx\n" }, "![[Essay]]", /“Essay” is an essay or a page/],
    ["an embed with a heading", { "studio/Fragment one.md": "x\n" }, "![[Fragment one#Part]]", /embeds a heading, a block or a size/],
    ["a link to a note the Studio cannot show", { "somewhere/Else.md": "x\n" }, "See [[Else]].", /links the Studio would show as plain text: \[\[Else\]\]/],
    ["an image", {}, "![[photo.png]]", /embed/],
    ["an explicit version", {}, "![[a0000000000000000000000009@v2]]", /embed/],
  ];
  for (const [name, vault, body, expected] of cases) {
    it(`${name}`, async () => {
      const w = makeStudioWorld({ vault: { [THREAD]: thread(`${body}\n`), ...vault } });
      // a published fragment for the heading case to resolve to
      if (name === "an embed with a heading") await tapStudio(w, FRAG);
      const before = w.studio.seen.length;
      const out = await tapStudio(w, THREAD);
      expect(out.status).toBe("refused");
      expect(out.notices.join(" ")).toMatch(expected);
      expect(w.studio.seen).toHaveLength(before);
      expect(w.local.get(THREAD)).toBe(thread(`${body}\n`));
    });
  }

  it("a note in a folder that still publishes to the GitHub blyg", async () => {
    const w = makeStudioWorld({ vault: { [THREAD]: thread("![[Github note]]\n"), "website/blyg/Github note.md": "---\nblyg_id: a0000000000000000000000009\n---\nx\n" } });
    w.settings.routes = [...w.settings.routes, { vaultPrefix: "website/blyg/", mode: "blyg", label: "Blyg note" }];
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("refused");
    expect(out.notices.join(" ")).toMatch(/“Github note” was published to your site's old blyg/);
    expect(w.studio.seen).toEqual([]);
  });

  it("a fragment that quotes, by name or by id", async () => {
    const { w } = await withFragment({ "studio/Quoter.md": "A fragment.\n\n![[Fragment one]]\n" });
    expect((await tapStudio(w, "studio/Quoter.md")).notices.join(" ")).toMatch(/quotes another item, which only a thread can do/);
    w.local.set("studio/Quoter.md", `A fragment.\n\n![[${REMOTE} | label]]\n`);
    expect((await tapStudio(w, "studio/Quoter.md")).status).toBe("refused");
  });

  it("an empty thread", async () => {
    const w = makeStudioWorld({ vault: { [THREAD]: thread("\n") } });
    expect(await tapStudio(w, THREAD)).toMatchObject({ status: "refused", notices: [M.emptyBody] });
  });

  it("reports every name that fails, each with its line", async () => {
    const w = makeStudioWorld({ vault: { [THREAD]: thread("![[Draft]]\n\ntext\n\n![[Draft two]]\n"), "studio/Draft.md": "x\n", "studio/Draft two.md": "y\n" } });
    const out = await tapStudio(w, THREAD);
    expect(out.notices[0]).toMatch(/2 problems/);
    expect(out.notices[0]).toMatch(/line 1: “Draft” is not published yet/);
    expect(out.notices[0]).toMatch(/line 5: “Draft two” is not published yet/);
  });
});

describe("threads are not fragments", () => {
  it("has no 1000-character cap, and an update is a new version", async () => {
    const long = `${"A long thought. ".repeat(200)}\n`;
    const w = makeStudioWorld({ vault: { [THREAD]: thread(long) } });
    const first = await tapStudio(w, THREAD);
    expect(first).toMatchObject({ status: "published", version: 1 });
    w.local.set(THREAD, w.local.get(THREAD)?.replace("A long", "A longer") ?? "");
    expect(await tapStudio(w, THREAD)).toMatchObject({ status: "published", version: 2 });
    expect(w.previews.map((p) => p.label)).toEqual(["thread", "thread"]);
  });

  it("says nothing changed when the thread's resolved text is already there", async () => {
    const { w } = await withFragment({ [THREAD]: thread("![[Fragment one]]\n\nSame.\n") });
    expect((await tapStudio(w, THREAD)).status).toBe("published");
    const writes = w.studio.writes().length;
    expect(await tapStudio(w, THREAD)).toMatchObject({ status: "noop", notices: [M.noChanges] });
    expect(w.studio.writes()).toHaveLength(writes);
  });

  it("refuses with the Studio's words and the directive when its preview cannot resolve a quote", async () => {
    const w = makeStudioWorld({ vault: { [THREAD]: thread(`![[${REMOTE} | Somebody]]\n`) } });
    w.studio.previewProblems = [{ directive: `![[${REMOTE} | Somebody]]`, reason: "unknown item" }];
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toContain(`![[${REMOTE} | Somebody]]: unknown item`);
    expect(w.studio.writes()).toEqual([]);
    expect(w.studio.items.size).toBe(0);
  });

  it("asks the Studio to preview a thread as a thread, with the resolved text", async () => {
    const { w, fragId } = await withFragment({ [THREAD]: thread("![[Fragment one]]\n") });
    await tapStudio(w, THREAD);
    const preview = w.studio.seen.filter((s) => s.path === "/api/preview").at(-1);
    expect(preview?.body).toEqual({ contentMd: `![[${fragId}]]`, kind: "thread" });
  });
});

describe("the change note", () => {
  const second = async (answer: boolean | { note: string }): Promise<{ w: StudioWorld; id: string }> => {
    const w = makeStudioWorld({ vault: { [FRAG]: "First.\n" } });
    const first = await tapStudio(w, FRAG);
    w.local.set(FRAG, w.local.get(FRAG)?.replace("First.", "Second.") ?? "");
    w.answer = answer;
    const out = await tapStudio(w, FRAG);
    expect(out.status).toBe("published");
    return { w, id: first.id ?? "" };
  };

  it("is offered for an update only", async () => {
    const { w } = await second(true);
    expect(w.previews.map((p) => p.studio?.askNote)).toEqual([false, true]);
  });

  it("travels with the new version, trimmed", async () => {
    const { w, id } = await second({ note: "  fixed   a typo \n" });
    expect(w.studio.latest(id)?.note).toBe("fixed a typo");
  });

  it("an empty note, or a plain yes, sends none", async () => {
    expect((await second({ note: "   " })).w.studio.latest(idOf(1))?.note).toBeNull();
    expect((await second(true)).w.studio.latest(idOf(1))?.note).toBeNull();
  });

  it("is ignored for a first version, even when the window returns one", async () => {
    const w = makeStudioWorld({ vault: { [FRAG]: "First.\n" } });
    w.answer = { note: "should not be sent" };
    expect((await tapStudio(w, FRAG)).status).toBe("published");
    expect(w.studio.latest(idOf(1))?.note).toBeNull();
  });
});

describe("the text rules, without a vault", () => {
  const ctx = (vault: Record<string, string> = {}): Parameters<typeof prepareStudioText>[2] => {
    const w = makeStudioWorld({ vault });
    return { vault: w.deps.vault, routes: w.settings.routes, fromPath: THREAD, origin: STUDIO_ORIGIN, fragmentCharCap: 1000 };
  };

  it("scans directives and their quote lines outside code, and counts distinct links", () => {
    const text = `Intro.\n\n![[${REMOTE}]]\n> a passage\n> over two lines\n\n![[${REMOTE} | a label ]]\n\nSee [[${REMOTE}]] and [[${REMOTE} | again]] and [[${idOf(2)}]].\n\n\`\`\`\n![[${idOf(5)}]]\n\`\`\`\n`;
    const { quotes, links } = scanStudioQuotes(text);
    expect(quotes.map((q) => [q.id, q.label, q.line, q.quoteMd])).toEqual([
      [REMOTE, null, 3, "a passage\nover two lines"],
      [REMOTE, "a label", 7, null],
    ]);
    expect(links).toBe(2);
  });

  it("calls a quote 'remote' by its label only; own items written by name have none", () => {
    expect(scanStudioQuotes(`![[${idOf(1)}]]`).quotes[0]?.label).toBeNull();
  });

  it("cleans a label so it can sit between | and ]]", () => {
    expect(cleanLabel("Blog B: “a | b [c]”\n  d")).toBe("Blog B: “a b c ” d");
    expect(cleanLabel("x".repeat(300)).length).toBe(100);
    expect(cleanLabel(" | [] ")).toBe("");
  });

  it("reports the problems in the order a publish refuses them", () => {
    const draft = prepareStudioText(`![[${REMOTE} | l]]\n\n![[photo.png]]\n\n[[Nowhere]]`, "fragment", ctx());
    expect(draft.problems.map((p) => p.kind)).toEqual(["fragment-quote", "embeds", "links"]);
    expect(panelLines(draft.problems).join(" ")).toMatch(/Line 1 quotes another item.*photo.png.*\[\[Nowhere\]\]/);
  });

  it("an empty fragment and an empty thread are both empty; a thread has no cap", () => {
    expect(prepareStudioText("", "fragment", ctx()).problems).toEqual([{ kind: "empty" }]);
    expect(prepareStudioText("", "thread", ctx()).problems).toEqual([{ kind: "empty" }]);
    expect(prepareStudioText("x".repeat(5000), "thread", ctx()).problems).toEqual([]);
    expect(prepareStudioText("x".repeat(1001), "fragment", ctx()).problems).toEqual([{ kind: "too-long", length: 1001, cap: 1000 }]);
  });
});
