// V1-C.2: paragraphs of notes as items. "Publish this paragraph", `![[Note#^id]]` in a thread, and the one confirmation for the thread together with the
// paragraphs it quotes that are not published yet. Items first, thread last; a stop in the middle leaves the finished ones and never makes one twice.
import { describe, expect, it } from "vitest";
import { M } from "../../src/publish/messages";
import { publishParagraph } from "../../src/publish/studioBlocks";
import { frontmatterOf } from "../world";
import { STUDIO_ORIGIN, idOf } from "./fake-studio";
import { makeStudioWorld, tapStudio, type StudioWorld } from "./world";

const DAILY = "studio/Daily note.md";
const THREAD = "studio/Reading list.md";
const P1 = "Most of what I call thinking is rereading my own sentences until one of them holds.";
const P2 = "A good note is one I can quote without apologising for the context around it.";
const DAILY_TEXT = `---\ntags: [daily]\n---\nCoffee, then the long walk.\n\n${P1}\n\n${P2} ^cd34\n`;
const ref = (path: string) => ({ path, name: path.split("/").pop() ?? path, extension: "md" });
/** The line the cursor is on: found by the paragraph's words, because the properties above grow when a paragraph is marked. */
const lineOf = (w: StudioWorld, words: string): number => (w.local.get(DAILY) ?? "").split("\n").findIndex((l) => l.startsWith(words.slice(0, 12))) + 1;
const para = (w: StudioWorld, which: number) => publishParagraph(w.deps, ref(DAILY), lineOf(w, which === 6 ? P1 : P2));
const thread = (body: string): string => `---\nblyg_kind: thread\n---\n${body}`;
const writes = (w: StudioWorld): string[] => w.studio.seen.filter((s) => s.method !== "GET" && !s.path.startsWith("/api/preview")).map((s) => `${s.method} ${s.path.replace(/[0-9a-z]{26}/g, "ID")}`);

describe("Publish this paragraph", () => {
  it("makes a fragment, puts the block id at the end of the paragraph first, then the record in the properties", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT } });
    const out = await para(w, 6);
    expect(out.status).toBe("published");
    expect(w.previews).toHaveLength(1);
    expect(w.previews[0]).toMatchObject({ action: "create", label: "fragment", after: P1 });
    expect(w.previews[0]?.changes.join(" ")).toMatch(/Adds a block id/);
    const id = idOf(1);
    expect(w.studio.items.get(id)).toMatchObject({ kind: "fragment", status: "public", version: 1, content_md: P1 });
    const text = w.local.get(DAILY) ?? "";
    const blockId = /\n\n[^\n]+ \^([a-z0-9]{6})\n/.exec(text)?.[1];
    expect(blockId).toMatch(/^[a-z0-9]{6}$/);
    expect(text).toContain(`${P1} ^${blockId}\n`);
    const fm = frontmatterOf(text);
    expect(fm.blyg_blocks).toEqual({ [blockId as string]: id });
    expect(fm.blyg_blocks_origin).toBe(STUDIO_ORIGIN);
    expect(fm.tags).toEqual(["daily"]); // the other properties are untouched
    expect(out.notices[0]).toContain(`![[Daily note#^${blockId}]]`);
    expect(w.pendingMap.size).toBe(0);
  });

  it("uses the paragraph's own id when it has one, and says nothing is added", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT } });
    const out = await para(w, 8);
    expect(out.status).toBe("published");
    expect(frontmatterOf(w.local.get(DAILY) ?? "").blyg_blocks).toEqual({ cd34: idOf(1) });
    expect(w.previews[0]?.changes.join(" ")).not.toMatch(/Adds a block id/);
    expect(w.local.get(DAILY)).toContain(`${P2} ^cd34\n`);
  });

  it("a second tap on an unchanged paragraph does nothing; an edited paragraph is a new version of the same item", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT } });
    await para(w, 8);
    const again = await para(w, 8);
    expect(again.status).toBe("noop");
    expect(w.studio.items.size).toBe(1);
    w.local.set(DAILY, (w.local.get(DAILY) ?? "").replace("quote without", "quote it without"));
    const upd = await para(w, 8);
    expect(upd.status).toBe("published");
    expect(w.studio.items.size).toBe(1);
    expect(w.previews.at(-1)).toMatchObject({ action: "update", fromVersion: 1, toVersion: 2 });
    expect(w.studio.items.get(idOf(1))).toMatchObject({ version: 2 });
  });

  it("refuses what is not a plain paragraph, a note outside the Studio folders, and the feature switched off, before any request", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: "# Heading\n\n- a list\n\nWords.\n", "website/essays/E.md": "Words.\n" } });
    expect((await publishParagraph(w.deps, ref(DAILY), 1)).notices.join()).toBe(M.blockNotParagraph("heading"));
    expect((await publishParagraph(w.deps, ref(DAILY), 3)).notices.join()).toBe(M.blockNotParagraph("list"));
    const essay = await publishParagraph(w.deps, ref("website/essays/E.md"), 1);
    expect(essay.notices.join()).toBe(M.blockNotInRoute);
    const off = makeStudioWorld({ vault: { [DAILY]: DAILY_TEXT } });
    expect((await publishParagraph(off.deps, ref(DAILY), 6)).notices.join()).toBe(M.blockSwitchedOff);
    expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
  });

  it("cancel at the window leaves the Studio and the note as they were", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT } });
    w.answer = false;
    const before = w.local.get(DAILY);
    expect((await para(w, 6)).status).toBe("cancelled");
    expect(writes(w)).toEqual([]);
    expect(w.local.get(DAILY)).toBe(before);
  });

  it("a publish that fails leaves a draft that the retry finishes: one item, not two", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT } });
    w.studio.forced.set(`POST /api/items/${idOf(1)}/publish`, new Error("offline"));
    expect((await para(w, 6)).status).toBe("failed");
    expect(w.local.get(DAILY)).toBe(DAILY_TEXT);
    expect((await para(w, 6)).status).toBe("published");
    expect([...w.studio.items.values()].filter((i) => i.kind === "fragment")).toHaveLength(1);
  });

  it("the item is live but the paragraph changed under the tap: the note says so, and the retry only marks the note (no second item)", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT } });
    const original = w.local.get(DAILY) ?? "";
    w.answerFor = () => {
      w.local.set(DAILY, original.replace(P1, `${P1} Edited.`)); // the paragraph no longer matches what was published
      return true;
    };
    const first = await para(w, 6);
    expect(first.status).toBe("failed");
    expect(first.notices.join()).toBe(M.blockStampFailed(idOf(1)));
    expect(w.studio.items.get(idOf(1))).toMatchObject({ status: "public", content_md: P1 });
    w.answerFor = undefined;
    w.local.set(DAILY, original); // the person undoes the edit
    expect((await para(w, 6)).status).toBe("published");
    expect([...w.studio.items.values()].filter((i) => i.kind === "fragment")).toHaveLength(1);
    expect(Object.values(frontmatterOf(w.local.get(DAILY) ?? "").blyg_blocks as Record<string, string>)).toEqual([idOf(1)]);
  });
});

describe("a thread that embeds paragraphs", () => {
  async function withBlock(): Promise<{ w: StudioWorld; blockId: string }> {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT } });
    expect((await para(w, 8)).status).toBe("published");
    w.previews.length = 0;
    return { w, blockId: "cd34" };
  }

  it("a published paragraph is quoted by its item; nothing is made", async () => {
    const { w } = await withBlock();
    w.local.set(THREAD, thread("Intro.\n\n![[Daily note#^cd34]]\n"));
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("published");
    expect(w.studio.items.get(out.id ?? "")?.content_md).toBe(`Intro.\n\n![[${idOf(1)}]]`);
    expect(w.studio.items.size).toBe(2);
    expect(w.previews[0]?.studio?.tangle).toBeUndefined();
  });

  it("a paragraph that is not published yet: one window with the count, the paragraph first, the thread last, the note marked", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT, [THREAD]: thread("Intro.\n\n![[Daily note#^cd34]]\n\nMiddle.\n") } });
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("published");
    expect(w.previews).toHaveLength(1);
    expect(w.previews[0]?.studio?.tangle?.rows).toEqual([{ kind: "block", line: 3, words: `${P2.slice(0, 69)}…`, block: { host: "Daily note", id: "cd34" } }]);
    expect(writes(w)).toEqual(["POST /api/items", "POST /api/items/ID/publish", "POST /api/items", "POST /api/items/ID/publish"]);
    const blockItem = idOf(1);
    expect(w.studio.items.get(blockItem)).toMatchObject({ kind: "fragment", content_md: P2 });
    expect(w.studio.items.get(out.id ?? "")?.content_md).toBe(`Intro.\n\n![[${blockItem}]]\n\nMiddle.`);
    expect(frontmatterOf(w.local.get(DAILY) ?? "").blyg_blocks).toEqual({ cd34: blockItem });
    expect(w.local.get(THREAD)).toContain("![[Daily note#^cd34]]"); // nothing is rewritten in the thread
  });

  it("paragraphs and the Studio's spans share one count and one window", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT, [THREAD]: thread("![[Daily note#^cd34]]\n\n![[+ a new passage]]\n\nand [[+ an idea]]\n") } });
    expect((await tapStudio(w, THREAD)).status).toBe("published");
    expect(w.previews).toHaveLength(1);
    expect(w.previews[0]?.studio?.tangle?.rows.map((r) => r.kind)).toEqual(["block", "span", "placeholder"]);
    expect(w.previews[0]?.changes.join(" ")).toMatch(/3 new items will be made/);
  });

  it("over the limit of one publish: refused before anything is sent", async () => {
    const spans = Array.from({ length: 10 }, (_, i) => `![[+ passage ${i}]]`).join("\n\n");
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT, [THREAD]: thread(`![[Daily note#^cd34]]\n\n${spans}\n`) } });
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("refused");
    expect(out.notices.join()).toBe(M.tangleCap(11, 10));
    expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
  });

  it("a heading's section, a paragraph of the same note, a missing note and a missing paragraph are refused with a reason", async () => {
    const cases: Array<[string, RegExp]> = [
      ["![[Daily note#Coffee]]\n", /embeds a heading's section.*Embed one paragraph instead/],
      ["![[#^cd34]]\n", /embeds a paragraph of this same note/],
      ["![[Nowhere#^cd34]]\n", /“Nowhere” is not a note in your vault/],
      ["![[Daily note#^zz99]]\n", /no plain paragraph in “Daily note” ends with \^zz99/],
    ];
    for (const [text, words] of cases) {
      const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT, [THREAD]: thread(text) } });
      const out = await tapStudio(w, THREAD);
      expect(out.status).toBe("refused");
      expect(out.notices.join(" ")).toMatch(words);
      expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
    }
  });

  it("a stop in the middle keeps the finished paragraph; the retry makes only the rest, and the thread once", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT.replace(`${P1}\n`, `${P1} ^ab12\n`), [THREAD]: thread("![[Daily note#^ab12]]\n\n![[Daily note#^cd34]]\n") } });
    // the second paragraph's publish fails
    w.studio.forced.set(`POST /api/items/${idOf(2)}/publish`, new Error("offline"));
    const first = await tapStudio(w, THREAD);
    expect(first.status).toBe("failed");
    expect(first.notices.join(" ")).toMatch(/1 of 2 new items were published; the thread was not/);
    expect(frontmatterOf(w.local.get(DAILY) ?? "").blyg_blocks).toEqual({ ab12: idOf(1) });
    expect([...w.studio.items.values()].some((i) => i.kind === "thread")).toBe(false);
    const second = await tapStudio(w, THREAD);
    expect(second.status).toBe("published");
    expect(w.previews.at(-1)?.studio?.tangle?.rows).toHaveLength(1); // only the one not yet made
    expect([...w.studio.items.values()].filter((i) => i.kind === "fragment")).toHaveLength(2);
    expect(w.studio.items.get(second.id ?? "")?.content_md).toBe(`![[${idOf(1)}]]\n\n![[${idOf(2)}]]`);
  });

  it("a passage cannot be quoted from a paragraph that is not published yet", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [DAILY]: DAILY_TEXT, [THREAD]: thread("![[Daily note#^cd34]]\n> a passage\n") } });
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("refused");
    expect(out.notices.join(" ")).toMatch(/passage cannot be quoted from a paragraph that is not published yet/);
  });

  it("with the feature off the embed is refused as before", async () => {
    const w = makeStudioWorld({ vault: { [DAILY]: DAILY_TEXT, [THREAD]: thread("![[Daily note#^cd34]]\n") } });
    const out = await tapStudio(w, THREAD);
    expect(out.status).toBe("refused");
    expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
  });
});
