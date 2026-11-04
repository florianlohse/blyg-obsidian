// Bringing the Studio's working copy into the note (roadmap S2.7): both texts are shown first, nothing is sent to the Studio, ids become note
// names again where a note of this Studio holds them, and the record says afterwards that the note and the Studio agree.
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import { M } from "../../src/publish/messages";
import { namesFromIds, prepareStudioText } from "../../src/studio/text";
import { frontmatterOf } from "../world";
import { STUDIO_ORIGIN, idOf } from "./fake-studio";
import { makeStudioWorld, tapStudio, tapStudioPull, type StudioWorld } from "./world";

const NOTE = "studio/Note.md";
const fm = (w: StudioWorld, path = NOTE): Record<string, unknown> => frontmatterOf(w.local.get(path) ?? "");
const bodyOf = (w: StudioWorld, path = NOTE): string => (w.local.get(path) ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

async function published(body = "Hello world.\n"): Promise<{ w: StudioWorld; id: string }> {
  const w = makeStudioWorld({ vault: { [NOTE]: body } });
  const out = await tapStudio(w, NOTE);
  expect(out.status).toBe("published");
  return { w, id: out.id ?? "" };
}

describe("use the Studio's copy", () => {
  it("shows both texts, then replaces the note's text and marks the record; nothing is sent to the Studio", async () => {
    const { w, id } = await published();
    w.studio.editThere(id, "Edited over there.");
    const writes = w.studio.writes().length;
    const props = fm(w);
    const out = await tapStudioPull(w, NOTE);
    expect(out.status).toBe("published");
    expect(out.notices[0]).toBe(M.studioPullDone(id, 0, 0));
    expect(w.studio.writes()).toHaveLength(writes);
    expect(bodyOf(w)).toBe("Edited over there.\n");
    expect(w.previews.at(-1)).toMatchObject({ action: "studio-pull", id, before: "Hello world.", after: "Edited over there." });
    // the properties stay; the Studio's copy now counts as sent
    expect(fm(w)).toEqual({ ...props, blyg_sent: await contentHash("Edited over there.") });
  });

  it("afterwards the note and the Studio agree: Update raises no overwrite question, and goes live only when you publish", async () => {
    const { w, id } = await published();
    w.studio.editThere(id, "Edited over there.");
    await tapStudioPull(w, NOTE);
    expect(w.studio.items.get(id)?.version).toBe(1); // pulling publishes nothing
    const again = await tapStudio(w, NOTE);
    expect(again).toMatchObject({ status: "published", version: 2 });
    expect(w.previews.map((p) => p.action)).toEqual(["create", "studio-pull", "update"]);
  });

  it("when the Studio's copy is also what is published, the version is brought up to date and Update has nothing to send", async () => {
    const { w, id } = await published();
    const item = w.studio.items.get(id);
    if (item) item.version = 2; // published again in the Studio's own editor, same words
    w.local.set(NOTE, (w.local.get(NOTE) ?? "").replace("Hello world.", "Changed here only."));
    await tapStudioPull(w, NOTE);
    expect(fm(w).blyg_version).toBe(2);
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "noop", notices: [M.noChanges] });
  });

  it("cancelling leaves the note exactly as it was", async () => {
    const { w, id } = await published();
    w.studio.editThere(id, "Edited over there.");
    const before = w.local.get(NOTE);
    w.answerFor = () => false;
    const out = await tapStudioPull(w, NOTE);
    expect(out).toMatchObject({ status: "cancelled", notices: [M.studioPullCancelled] });
    expect(w.local.get(NOTE)).toBe(before);
  });

  it("says so, and changes nothing, when the note already says what the Studio says", async () => {
    const { w } = await published();
    const before = w.local.get(NOTE);
    const out = await tapStudioPull(w, NOTE);
    expect(out).toMatchObject({ status: "noop", notices: [M.studioPullSame] });
    expect(w.previews).toHaveLength(1); // only the publish's window
    expect(w.local.get(NOTE)).toBe(before);
  });

  it("is offered in the overwrite window as a third choice, which then replaces the note without a second window", async () => {
    const { w, id } = await published();
    w.studio.editThere(id, "Edited over there.");
    w.local.set(NOTE, `${(w.local.get(NOTE) ?? "").replace("Hello world.", "Hello, changed here.")}`);
    w.answerFor = (p) => (p.action === "studio-conflict" ? { note: "", pull: true } : true);
    const writes = w.studio.writes().length;
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(w.previews.map((p) => p.action)).toEqual(["create", "studio-conflict"]);
    expect(w.studio.writes()).toHaveLength(writes);
    expect(bodyOf(w)).toBe("Edited over there.\n");
  });

  it("works for a local edit too: it takes the note back to the Studio's copy", async () => {
    const { w } = await published();
    w.local.set(NOTE, (w.local.get(NOTE) ?? "").replace("Hello world.", "Rewritten."));
    const out = await tapStudioPull(w, NOTE);
    expect(out.status).toBe("published");
    expect(bodyOf(w)).toBe("Hello world.\n");
  });

  it("leaves the note alone when it changed while the window was open", async () => {
    const { w, id } = await published();
    w.studio.editThere(id, "Edited over there.");
    w.answerFor = () => {
      w.local.set(NOTE, `${w.local.get(NOTE) ?? ""}Typed meanwhile.\n`);
      return true;
    };
    const out = await tapStudioPull(w, NOTE);
    expect(out).toMatchObject({ status: "failed", notices: [M.studioPullChangedMeanwhile] });
    expect(bodyOf(w)).toContain("Typed meanwhile.");
  });

  it("warns that comments in the note are lost", async () => {
    const { w, id } = await published("Hello world.\n%% private %%\n");
    w.studio.editThere(id, "Edited over there.");
    await tapStudioPull(w, NOTE);
    expect(w.previews.at(-1)?.changes.join(" ")).toMatch(/1 comment/);
  });

  it("lists the note's block ids in the window; ticked, it writes them to the end of the note in a private comment, and says so", async () => {
    const { w, id } = await published("First thought. ^ab12cd\n\nSecond one. ^ef34gh\n");
    w.studio.editThere(id, "Edited over there.");
    w.answerFor = (p) => (p.action === "studio-pull" ? { note: "", appendIds: true } : true);
    const out = await tapStudioPull(w, NOTE);
    expect(w.previews.at(-1)?.blockIds).toEqual([
      { id: "ab12cd", excerpt: "First thought." },
      { id: "ef34gh", excerpt: "Second one." },
    ]);
    expect(w.previews.at(-1)?.changes.join(" ")).toMatch(/2 block ids/);
    expect(bodyOf(w)).toBe("Edited over there.\n\n%% Block ids removed when this note was replaced with the online text: ^ab12cd (First thought.), ^ef34gh (Second one.) %%\n");
    expect(out.notices[1]).toBe(M.studioPullIds(2, true));
  });

  it("unticked, the ids are only reported as lost", async () => {
    const { w, id } = await published("First thought. ^ab12cd\n");
    w.studio.editThere(id, "Edited over there.");
    w.answerFor = (p) => (p.action === "studio-pull" ? { note: "", appendIds: false } : true);
    const out = await tapStudioPull(w, NOTE);
    expect(bodyOf(w)).toBe("Edited over there.\n");
    expect(out.notices[1]).toBe(M.studioPullIds(1, false));
  });

  it("the overwrite window's third choice has no window of its own, so the ids are always written down", async () => {
    const { w, id } = await published("First thought. ^ab12cd\n");
    w.studio.editThere(id, "Edited over there.");
    w.local.set(NOTE, (w.local.get(NOTE) ?? "").replace("First thought.", "First, changed."));
    w.answerFor = (p) => (p.action === "studio-conflict" ? { note: "", pull: true } : true);
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(bodyOf(w)).toContain("%% Block ids removed");
    expect(bodyOf(w)).toContain("^ab12cd (First, changed.)");
    expect(out.notices).toContain(M.studioPullIds(1, true));
  });

  it("a note without ids gets no id line and no extra notice", async () => {
    const { w, id } = await published();
    w.studio.editThere(id, "Edited over there.");
    const out = await tapStudioPull(w, NOTE);
    expect(w.previews.at(-1)?.blockIds).toBeUndefined();
    expect(out.notices).toHaveLength(1);
  });

  it("refuses a note with no item in this Studio, a note of another blyg, and a missing item", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n", "studio/Old.md": `---\nblyg_id: 7c9wk2n4h6q1x8v0z3m5rjy2ke\nblyg_version: 3\n---\nOld.\n`, "studio/Gone.md": `---\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_id: ${idOf(99)}\nblyg_version: 1\n---\nGone.\n` } });
    expect(await tapStudioPull(w, NOTE)).toMatchObject({ status: "refused", notices: [M.studioPullNoRecord] });
    expect((await tapStudioPull(w, "studio/Old.md")).status).toBe("refused");
    expect((await tapStudioPull(w, "studio/Gone.md")).status).toBe("refused");
    expect(w.local.get(NOTE)).toBe("Hello.\n");
  });

  it("refuses outside a Studio folder", async () => {
    const w = makeStudioWorld({ vault: { "website/essays/E.md": "---\ntitle: T\n---\nText.\n" } });
    expect((await tapStudioPull(w, "website/essays/E.md")).status).toBe("refused");
  });
});

describe("ids back to names", () => {
  async function threadWorld(): Promise<{ w: StudioWorld; id: string }> {
    const w = makeStudioWorld({ vault: { "studio/Fragment one.md": "A first thought.\n", "studio/Thread.md": "---\nblyg_kind: thread\n---\nMy answer.\n" } });
    expect((await tapStudio(w, "studio/Fragment one.md")).status).toBe("published");
    return { w, id: idOf(1) };
  }
  const ctxOf = (w: StudioWorld) => ({ vault: w.deps.vault, routes: w.deps.settings.routes, fromPath: "studio/Thread.md", origin: STUDIO_ORIGIN, fragmentCharCap: 800 });

  it("turns an id of a note of this Studio into its name: embeds, links, links with text; code and other blygs' labels stay", async () => {
    const { w, id } = await threadWorld();
    const other = "7c9wk2n4h6q1x8v0z3m5rjy2ke";
    const text = [`![[${id}]]`, `> a passage`, "", `See [[${id}]] and [[${id} | the first]].`, "", "`[[" + id + "]]`", `![[${other} | Someone: label]]`, `And [[${other}]].`].join("\n");
    const out = namesFromIds(text, ctxOf(w), w.deps.edit!);
    expect(out.text).toBe(
      ["![[Fragment one]]", "> a passage", "", "See [[Fragment one]] and [[Fragment one|the first]].", "", "`[[" + id + "]]`", `![[${other} | Someone: label]]`, `And [[${other}]].`].join("\n"),
    );
    expect(out.named).toBe(3);
    expect(out.left).toBe(1);
  });

  it("is the inverse of the publish: the text goes out again exactly as it came in", async () => {
    const { w, id } = await threadWorld();
    const wire = `Intro.\n\n![[${id}]]\n> a passage\n\nSee [[${id} | the first]].\n`;
    const named = namesFromIds(wire, ctxOf(w), w.deps.edit!).text;
    const back = prepareStudioText(named, "thread", ctxOf(w));
    expect(back.problems).toEqual([]);
    expect(back.contentMd).toBe(wire);
  });

  it("keeps the id when two notes hold it, when the note is withdrawn, or when it belongs to another origin", async () => {
    const { w, id } = await threadWorld();
    w.local.set("studio/Copy.md", w.local.get("studio/Fragment one.md") ?? "");
    expect(namesFromIds(`[[${id}]]`, ctxOf(w), w.deps.edit!).text).toBe(`[[${id}]]`);
    w.local.delete("studio/Copy.md");
    w.local.set("studio/Fragment one.md", (w.local.get("studio/Fragment one.md") ?? "").replace("blyg_version: 1", "blyg_version: 1\nblyg_withdrawn: true"));
    expect(namesFromIds(`[[${id}]]`, ctxOf(w), w.deps.edit!).text).toBe(`[[${id}]]`);
  });

  it("the pull maps ids to names in the note it writes", async () => {
    const { w, id } = await threadWorld();
    const t = await tapStudio(w, "studio/Thread.md");
    expect(t.status).toBe("published");
    w.studio.editThere(idOf(2), `My answer.\n\n![[${id}]]\n> a passage\n`);
    const out = await tapStudioPull(w, "studio/Thread.md");
    expect(out.status).toBe("published");
    expect(bodyOf(w, "studio/Thread.md")).toBe("My answer.\n\n![[Fragment one]]\n> a passage\n");
    expect(out.notices[0]).toBe(M.studioPullDone(idOf(2), 1, 0));
  });
});
