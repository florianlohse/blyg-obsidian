// V1-C: publishing a thread that has `![[+ …]]` spans and `[[+ …]]` placeholders. One confirmation, `tangle: true`, the Studio makes the
// items before the thread, the note is rewritten to point at them, and nothing is ever made twice. The fake Studio behaves as a real 0.69.0
// did in the probe (see the pull request): 409 `tangle-confirmation-required` with `details.count` and `details.parts`, 200 with `parts`.
import { describe, expect, it } from "vitest";
import { M } from "../../src/publish/messages";
import { studioTextHash } from "../../src/studio/media";
import { frontmatterOf } from "../world";
import { idOf } from "./fake-studio";
import { makeStudioWorld, tapStudio } from "./world";

const NOTE = "studio/Thread.md";
const THREAD = (body: string): string => `---\nblyg_kind: thread\n---\n${body}`;
const BODY = "Intro line.\n\n![[+ The cheapest way to find out what I think is to write it down]]\n\nAnd about [[+ slow reading]] later.\n";
const publishes = (w: ReturnType<typeof makeStudioWorld>): Array<{ path: string; body: unknown }> => w.studio.seen.filter((s) => s.method === "POST" && /\/publish$/.test(s.path)).map((s) => ({ path: s.path, body: s.body }));

describe("a thread with spans and placeholders (feature on, contract 6)", () => {
  it("asks once with the count and the list, publishes with tangle: true, rewrites the note, stamps what the Studio holds", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: THREAD(BODY) } });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    // one window, with the new items listed
    expect(w.previews).toHaveLength(1);
    expect(w.previews[0]?.studio?.tangle?.rows).toEqual([
      { kind: "span", line: 3, words: "The cheapest way to find out what I think is to write it down" },
      { kind: "placeholder", line: 5, words: "slow reading" },
    ]);
    expect(w.previews[0]?.changes.join(" ")).toMatch(/2 new items will be made and published first, then the thread/);
    // the wire: one publish, with tangle: true
    expect(publishes(w)).toHaveLength(1);
    expect(publishes(w)[0]?.body).toMatchObject({ tangle: true });
    expect(w.studio.tangledItems).toHaveLength(2);
    // the Studio's working copy was rewritten; so is the note, the same way
    const threadId = out.id ?? "";
    const working = w.studio.items.get(threadId)?.content_md ?? "";
    const [a, b] = w.studio.tangledItems;
    expect(working).toBe(`Intro line.\n\n![[${a} | The cheapest way to find out what I…]]\n\nAnd about [[${b} | slow reading]] later.`);
    const local = w.local.get(NOTE) ?? "";
    expect(local).toContain(`![[${a} | The cheapest way to find out what I…]]\n\nAnd about [[${b} | slow reading]] later.`);
    expect(local).not.toContain("![[+");
    expect(local).not.toContain("[[+");
    // blyg_sent is the hash of what the Studio holds, so "edited in the Studio" does not fire on the rewrite
    expect(frontmatterOf(local).blyg_sent).toBe(await studioTextHash(working));
    expect(out.notices.join("\n")).toMatch(/2 new items made and published before the thread/);
    expect(out.notices.join("\n")).toMatch(/Your note now points at them/);
  });

  it("a second publish of the rewritten note makes no new items", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: THREAD(BODY) } });
    await tapStudio(w, NOTE);
    const made = w.studio.tangledItems.length;
    const again = await tapStudio(w, NOTE);
    expect(w.studio.tangledItems).toHaveLength(made);
    expect(["noop", "published"]).toContain(again.status);
    expect(w.previews).toHaveLength(1); // nothing to confirm the second time: no window, or a plain one
  });

  it("cancel sends nothing that changes the Studio and leaves the note as it was", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: THREAD(BODY) } });
    w.answer = false;
    const before = w.local.get(NOTE);
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("cancelled");
    expect(w.studio.seen.filter((s) => s.method !== "GET" && !s.path.startsWith("/api/preview"))).toEqual([]);
    expect(w.studio.tangledItems).toHaveLength(0);
    expect(w.local.get(NOTE)).toBe(before);
  });

  it("a publish that fails keeps the draft; the retry makes the items once, not twice", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: THREAD(BODY) } });
    w.studio.forced.set(`POST /api/items/${idOf(1)}/publish`, new Error("offline"));
    const first = await tapStudio(w, NOTE);
    expect(first.status).toBe("failed");
    expect(w.studio.tangledItems).toHaveLength(0);
    expect(w.local.get(NOTE)).toContain("![[+ The cheapest");
    const second = await tapStudio(w, NOTE);
    expect(second.status).toBe("published");
    expect(w.studio.tangledItems).toHaveLength(2);
    expect([...w.studio.items.values()].filter((i) => i.kind === "thread" && i.status === "public")).toHaveLength(3);
  });

  it("if the Studio counts differently, nothing is published, the note is untouched and the person is told why", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: THREAD(BODY) } });
    w.studio.forced.set(`POST /api/items/${idOf(1)}/publish`, { status: 409, text: JSON.stringify({ code: "tangle-confirmation-required", message: "publishing this thread also publishes 3 new items; send tangle: true to confirm", details: { count: 3, parts: ["a", "b", "c"] } }) });
    const before = w.local.get(NOTE);
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toBe(M.tangleCountDiffers(2, 3));
    expect(w.studio.tangledItems).toHaveLength(0);
    expect(w.local.get(NOTE)).toBe(before);
  });
});

describe("refused before anything is sent", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["a closer in the middle of a line", THREAD("![[+ a]] and more\n"), /line 1: the closing \]\] of a new-item span must end its line.*nothing was sent/i],
    ["a span that never closes", THREAD("![[+ never closes\n"), /never closes with \]\]/],
    ["an opener after other text", THREAD("x ![[+ a b]]\n"), /must start its own line/],
    ["a placeholder inside a span", THREAD("![[+ a [[+ x y]] b]]\n"), /cannot sit inside a new-item span/],
    ["an empty placeholder", THREAD("a [[+  ]] b\n"), /placeholder is empty/],
  ];
  for (const [name, body, words] of cases) {
    it(`${name}`, async () => {
      const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: body } });
      const before = w.local.get(NOTE);
      const out = await tapStudio(w, NOTE);
      expect(out.status).toBe("refused");
      expect(out.notices.join(" ")).toMatch(words);
      expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
      expect(w.local.get(NOTE)).toBe(before);
    });
  }

  it("more new items than one publish may make (10), counting spans and placeholders together", async () => {
    const body = Array.from({ length: 6 }, (_, i) => `![[+ passage number ${i}]]\n\nand [[+ idea ${i}]]\n`).join("\n");
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: THREAD(body) } });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices.join(" ")).toBe(M.tangleCap(12, 10));
    expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
  });

  it("a fragment cannot make new items", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: "Intro.\n\n![[+ a passage]]\n" } });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices.join(" ")).toMatch(/only a thread can do/);
    expect(w.studio.seen.filter((s) => s.path !== "/blyg.json")).toEqual([]);
  });

  it("a Studio of contract 5 cannot, so it is refused and nothing is sent", async () => {
    const w = makeStudioWorld({ tangle: true, contract5: true, vault: { [NOTE]: THREAD(BODY) } });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices.join(" ")).toBe(M.tangleUnsupported);
    expect(w.studio.seen.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("with the feature off the old refusal stands, word for word", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: THREAD(BODY) } });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices.join(" ")).toBe(M.tangleSpans([3, 5]));
  });
});

describe("the note cannot be rewritten", () => {
  it("edited while publishing: the thread is published, the items exist, and the person gets lines to paste; nothing else is made", async () => {
    const w = makeStudioWorld({ tangle: true, vault: { [NOTE]: THREAD(BODY) } });
    // the person removes the placeholder while the window is open
    w.answerFor = () => {
      w.local.set(NOTE, THREAD(BODY.replace("[[+ slow reading]]", "slow reading")));
      return true;
    };
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(w.studio.tangledItems).toHaveLength(2);
    const text = out.notices.join("\n");
    expect(text).toMatch(/could not be updated/);
    expect(text).toMatch(/Do NOT publish it again as it is/);
    expect(text).toContain(`[[${w.studio.tangledItems[1]} | slow reading]]`);
  });
});
