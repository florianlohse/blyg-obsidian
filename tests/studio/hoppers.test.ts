// Hoppers from the plugin (roadmap S13): `blyg_hoppers` names the hoppers; a send applies the note's own changes since the last send (D3),
// a wrong name refuses the send before anything is written, and a hopper change never makes a new version.
import { describe, expect, it } from "vitest";
import { M } from "../../src/publish/messages";
import { hopperChanges, readHopperNames, readSentIds, resolveHoppers } from "../../src/studio/hoppers";
import type { StudioHopper } from "../../src/studio/types";
import { frontmatterOf } from "../world";
import { makeStudioWorld, tapStudio, type StudioWorld } from "./world";

const NOTE = "studio/Note.md";
const DRAFT = "drafts/Draft.md";
const fm = (w: StudioWorld, path = NOTE): Record<string, unknown> => frontmatterOf(w.local.get(path) ?? "");
const withProps = (props: string, body = "Hello world.\n"): string => `---\n${props}\n---\n${body}`;
const setProps = (w: StudioWorld, path: string, change: (fm: Record<string, unknown>) => void): void => {
  const text = w.local.get(path) ?? "";
  const props = frontmatterOf(text);
  change(props);
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  w.local.set(path, `---\n${Object.entries(props).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}`);
};
const hopperWrites = (w: StudioWorld) => w.studio.writes().filter((s) => s.path.startsWith("/api/hoppers/"));

const H = (id: string, name: string, slug: string | null = null): StudioHopper => ({ id, name, slug, public: false });

describe("hoppers: a hopper whose members could not all be read (review P6)", () => {
  const all = [H("a", "A"), H("u", "U")];
  it("is neither added to nor removed from, and stays in the record the note keeps", () => {
    expect(hopperChanges({ wanted: ["a", "u"], sent: null, inStudio: [], all, unknown: ["u"] })).toEqual({ add: ["a"], remove: [], result: ["a", "u"] });
    expect(hopperChanges({ wanted: ["a"], sent: ["a", "u"], inStudio: ["a"], all, unknown: ["u"] })).toEqual({ add: [], remove: [], result: ["a", "u"] });
    // without `unknown` the same input would drop it
    expect(hopperChanges({ wanted: ["a"], sent: ["a", "u"], inStudio: ["a"], all }).result).toEqual(["a"]);
  });
  it("a send says so and does not touch that hopper; the note keeps its words", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello world.\n" } });
    const big = w.studio.addHopper("Big");
    for (let i = 0; i < 1005; i++) big.members.add(`m${i}`);
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    setProps(w, NOTE, (f) => void (f.blyg_hoppers = ["Big"]));
    const out = await tapStudio(w, NOTE);
    expect(hopperWrites(w)).toEqual([]);
    expect(out.notices.join("\n")).toContain(M.hoppersIncomplete(["Big"]));
    expect(fm(w).blyg_hoppers).toEqual(["Big"]);
  });
});

describe("hoppers: the pure rules", () => {
  it("reads one name or a list; refuses anything else", () => {
    expect(readHopperNames(undefined)).toEqual({ ok: true, names: [] });
    expect(readHopperNames("Salon")).toEqual({ ok: true, names: ["Salon"] });
    expect(readHopperNames([" A ", "a", "", "B"])).toEqual({ ok: true, names: ["A", "B"] });
    expect(readHopperNames([1, 2]).ok).toBe(false);
    expect(readHopperNames({ a: 1 }).ok).toBe(false);
    expect(readSentIds(["h1", "h1"])).toEqual(["h1"]);
    expect(readSentIds("h1")).toBeNull();
  });

  it("finds a hopper by name ignoring case, else by slug; refuses unknown and doubled names, and names a rename", () => {
    const all = [H("h1", "Salon", "salon"), H("h2", "Reading list", "reading"), H("h3", "Twice"), H("h4", "twice")];
    expect(resolveHoppers(["salon", "reading"], all, null)).toEqual({ ok: true, ids: ["h1", "h2"] });
    const unknown = resolveHoppers(["Nope"], all, null);
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toMatch(/no hopper “Nope”.*Salon/);
    expect(!resolveHoppers(["Twice"], all, null).ok && (resolveHoppers(["Twice"], all, null) as { message: string }).message).toMatch(/2 hoppers/);
    const renamed = resolveHoppers(["Old name"], all, ["h2"]);
    expect(!renamed.ok && renamed.message).toMatch(/renamed to “Reading list”/);
  });

  it("applies only the note's own changes since the last send (D3)", () => {
    const all = [H("a", "A"), H("b", "B"), H("c", "C")];
    // first send: add what is named, take nothing out
    expect(hopperChanges({ wanted: ["a"], sent: null, inStudio: ["c"], all })).toEqual({ add: ["a"], remove: [], result: ["a", "c"] });
    // taken off the note → taken out; added in the Studio meanwhile (c) → stays
    expect(hopperChanges({ wanted: [], sent: ["a"], inStudio: ["a", "c"], all })).toEqual({ add: [], remove: ["a"], result: ["c"] });
    // taken out in the Studio meanwhile, still in the note as last sent → the Studio's removal stands
    expect(hopperChanges({ wanted: ["a"], sent: ["a"], inStudio: [], all })).toEqual({ add: [], remove: [], result: [] });
    // added to the note → added
    expect(hopperChanges({ wanted: ["a", "b"], sent: ["a"], inStudio: ["a"], all })).toEqual({ add: ["b"], remove: [], result: ["a", "b"] });
  });
});

describe("hoppers on a send", () => {
  it("a new note's hoppers are applied after its first publish; the window lists them; the note then holds names and ids", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: withProps("blyg_hoppers: [Salon]") } });
    const h = w.studio.addHopper("Salon");
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(out.notices).toContain(M.hoppersDone(["Salon"], []));
    expect(w.previews.at(-1)?.changes).toContain(M.hoppersChange(["Salon"], []));
    expect([...h.members]).toEqual([out.id]);
    expect(fm(w)).toMatchObject({ blyg_hoppers: ["Salon"], blyg_hoppers_sent: ["h1"] });
  });

  it("a hopper added to an unchanged published note is applied without a new version", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello world.\n" } });
    w.studio.addHopper("Salon");
    const first = await tapStudio(w, NOTE);
    setProps(w, NOTE, (p) => (p.blyg_hoppers = ["Salon"]));
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", notices: [M.hoppersOnlyText, M.hoppersDone(["Salon"], [])] });
    expect(w.studio.items.get(first.id ?? "")?.version).toBe(1);
    expect(fm(w).blyg_hoppers_sent).toEqual(["h1"]);
    // and again: nothing to do
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "noop", notices: [M.noChanges] });
  });

  it("taking a hopper off the note takes the item out; one added in the Studio meanwhile stays and shows in the note", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: withProps("blyg_hoppers: [A]") } });
    const a = w.studio.addHopper("A");
    const b = w.studio.addHopper("B");
    const first = await tapStudio(w, NOTE);
    b.members.add(first.id ?? ""); // added in the Studio's own UI
    setProps(w, NOTE, (p) => (p.blyg_hoppers = []));
    const out = await tapStudio(w, NOTE);
    expect(out.notices).toContain(M.hoppersDone([], ["A"]));
    expect(a.members.size).toBe(0);
    expect(b.members.has(first.id ?? "")).toBe(true);
    expect(fm(w)).toMatchObject({ blyg_hoppers: ["B"], blyg_hoppers_sent: ["h2"] });
  });

  it("a removal made in the Studio is not undone by the next send (D3)", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: withProps("blyg_hoppers: [A]") } });
    const a = w.studio.addHopper("A");
    await tapStudio(w, NOTE);
    a.members.clear(); // taken out in the Studio
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "noop" });
    expect(a.members.size).toBe(0);
    expect(fm(w).blyg_hoppers).toEqual([]);
  });

  it("an unknown hopper name refuses the send before anything is written", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: withProps("blyg_hoppers: [Nope]") } });
    w.studio.addHopper("Salon");
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/no hopper “Nope”/);
    expect(w.studio.writes()).toHaveLength(0);
  });

  it("without owner:manage the text is sent, the hoppers are not, and the note keeps asking for them", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: withProps("blyg_hoppers: [A]") } });
    const a = w.studio.addHopper("A");
    w.studio.manage = false;
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(out.notices).toContain(M.hoppersNoPermission);
    expect(a.members.size).toBe(0);
    expect(fm(w).blyg_hoppers_sent).toBeUndefined();
    w.studio.manage = true;
    expect(await tapStudio(w, NOTE)).toMatchObject({ status: "published", notices: [M.hoppersOnlyText, M.hoppersDone(["A"], [])] });
  });

  it("a drafts-only folder puts the draft into its hoppers too (a draft in a hopper is not public)", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: withProps("blyg_hoppers: [A]") } });
    const a = w.studio.addHopper("A");
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("published");
    expect(a.members.has(out.id ?? "")).toBe(true);
    expect(w.studio.items.get(out.id ?? "")?.status).toBe("draft");
  });

  it("a note without hopper properties costs no hopper request", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello world.\n" } });
    w.studio.addHopper("A");
    await tapStudio(w, NOTE);
    expect(w.studio.seen.filter((s) => s.path.startsWith("/api/hoppers"))).toHaveLength(0);
    expect(hopperWrites(w)).toHaveLength(0);
  });
});

describe("hoppers: taking the Studio's", () => {
  it("“Use the online hoppers” writes the Studio's set into the note; nothing is sent", async () => {
    const { runTakeHoppersFor } = await helpers();
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello world.\n" } });
    const a = w.studio.addHopper("A");
    const first = await tapStudio(w, NOTE);
    a.members.add(first.id ?? "");
    const writes = w.studio.writes().length;
    const out = await runTakeHoppersFor(w, NOTE);
    expect(out).toMatchObject({ status: "published", notices: [M.hoppersTaken(["A"])] });
    expect(fm(w)).toMatchObject({ blyg_hoppers: ["A"], blyg_hoppers_sent: ["h1"] });
    expect(w.studio.writes()).toHaveLength(writes);
  });

  it("is refused for a note with no item in the Studio yet", async () => {
    const { runTakeHoppersFor } = await helpers();
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello world.\n" } });
    expect(await runTakeHoppersFor(w, NOTE)).toMatchObject({ status: "refused", notices: [M.hoppersNotPublished] });
  });

  it("“Use the Studio's copy” brings the hoppers along", async () => {
    const { tapStudioPull } = await import("./world");
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello world.\n" } });
    const a = w.studio.addHopper("A");
    const first = await tapStudio(w, NOTE);
    a.members.add(first.id ?? "");
    w.studio.editThere(first.id ?? "", "Edited there.");
    const out = await tapStudioPull(w, NOTE);
    expect(out.notices).toContain(M.hoppersTaken(["A"]));
    expect(fm(w).blyg_hoppers).toEqual(["A"]);
  });
});

describe("hoppers in the panel", () => {
  it("shows the note's hoppers and, when the Studio says otherwise, both sides and the button to take the Studio's", async () => {
    const { computePanelState } = await import("../../src/app/panelState");
    const { defaultSettings } = await import("../../src/settings/schema");
    const { STUDIO_HOST, STUDIO_ORIGIN, idOf } = await import("./fake-studio");
    const { STUDIO_ROUTES } = await import("./world");
    const s = defaultSettings();
    s.studio = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "t", importFolder: "" };
    s.routes = [...STUDIO_ROUTES];
    const facts = (hoppers: string[] | null) => ({ item: { status: "public" as const, version: 1, workingHash: "sha256:a" }, mentions: null, hoppers, at: 0 });
    const state = (noteHoppers: unknown, studioHoppers: string[] | null) =>
      computePanelState({ settings: s, note: { path: NOTE, name: "Note.md", extension: "md" }, frontmatter: { id: idOf(1), origin: STUDIO_ORIGIN, version: 1, sent: "sha256:a", hoppers: noteHoppers }, localHash: "sha256:a", studio: { facts: facts(studioHoppers), warnings: [] } }).hoppers;
    expect(state(["A"], ["a"])).toEqual({ note: ["A"], studio: ["a"], differ: false, canTake: true });
    expect(state(["A"], ["B"])).toMatchObject({ differ: true });
    expect(state(undefined, null)).toEqual({ note: [], studio: null, differ: false, canTake: false });
    expect(state(7, ["B"])).toMatchObject({ note: null, differ: false });
  });
});

async function helpers() {
  const { takeHoppersNote } = await import("../../src/publish/studioHopperNote");
  return {
    runTakeHoppersFor: (w: StudioWorld, path: string) => takeHoppersNote(w.deps, { path, name: path.split("/").pop() ?? path, extension: "md" }),
  };
}

describe("hoppers: a name typed by hand (Florian's device test, 2026-11-02)", () => {
  async function sentOnce() {
    const w = makeStudioWorld({ vault: { [DRAFT]: withProps("blyg_hoppers: [A]") } });
    const a = w.studio.addHopper("A");
    const first = await tapStudio(w, DRAFT);
    expect(first.status).toBe("published");
    // taken out in the Studio, then sent again: the note's set is now empty and recorded
    a.members.clear();
    await tapStudio(w, DRAFT);
    expect(fm(w, DRAFT)).toMatchObject({ blyg_hoppers: [], blyg_hoppers_sent: [] });
    return { w, a };
  }

  it("an unknown name on a note that was sent before refuses the send, and the property is left as typed", async () => {
    const { w } = await sentOnce();
    setProps(w, DRAFT, (p) => (p.blyg_hoppers = "Nope"));
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/no hopper “Nope”/);
    expect(fm(w, DRAFT).blyg_hoppers).toBe("Nope");
  });

  it("the same when the text also changed", async () => {
    const { w } = await sentOnce();
    setProps(w, DRAFT, (p) => (p.blyg_hoppers = ["Nope"]));
    w.local.set(DRAFT, (w.local.get(DRAFT) ?? "").replace("Hello world.", "Hello again."));
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("refused");
    expect(fm(w, DRAFT).blyg_hoppers).toEqual(["Nope"]);
  });

  it("when Obsidian's property cache is behind the file (the edit was just made), the file wins", async () => {
    const { w } = await sentOnce();
    const stale = { blyg_hoppers: [] as unknown, blyg_hoppers_sent: [] as unknown };
    const vault = w.deps.vault;
    const live = (note: Parameters<typeof vault.frontmatterValue>[0], key: string): unknown => vault.frontmatterValue(note, key);
    w.deps.vault = { ...vault, frontmatterValue: (note, key) => (note.path === DRAFT && key in stale ? (stale as Record<string, unknown>)[key] : live(note, key)) };
    setProps(w, DRAFT, (p) => (p.blyg_hoppers = ["Nope"]));
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("refused");
    expect(fm(w, DRAFT).blyg_hoppers).toEqual(["Nope"]);
  });

  it("a property changed while the send was under way is never overwritten", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: withProps("blyg_hoppers: [A]") } });
    w.studio.addHopper("A");
    w.studio.addHopper("B");
    // the owner types another hopper into the note after the send was planned but before its hoppers are written back
    let typed = false;
    const vault = w.deps.vault;
    const update = (note: Parameters<typeof vault.updateFrontmatter>[0], fn: Parameters<typeof vault.updateFrontmatter>[1]): Promise<void> => vault.updateFrontmatter(note, fn);
    w.deps.vault = {
      ...vault,
      updateFrontmatter: async (note, fn) => {
        if (!typed && note.path === NOTE) {
          typed = true;
          await update(note, (p) => void (p.blyg_hoppers = ["B"]));
        }
        return update(note, fn);
      },
    };
    // the first stamp (id, version …) runs first and is when "typing" happens; the hopper write-back must then see ["B"], not its plan
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(fm(w).blyg_hoppers).toEqual(["B"]);
    expect(out.notices.join(" ")).toContain("changed while this was being sent");
    // the Studio's set is still recorded, so the next send applies the typed change on top of it
    expect(fm(w).blyg_hoppers_sent).toEqual(["h1"]);
  });
});
