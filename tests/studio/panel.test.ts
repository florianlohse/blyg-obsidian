import { describe, expect, it } from "vitest";
import { computePanelState, loadPanelState, studioTextSummary, type LocalBlygFrontmatter } from "../../src/app/panelState";
import type { StudioFacts } from "../../src/studio/live";
import { contentHash } from "../../src/core/hash";
import type { NoteRef } from "../../src/platform/ports";
import { defaultSettings, type BlygSettings } from "../../src/settings/schema";
import { makeWorld } from "../world";
import { STUDIO_HOST, STUDIO_ORIGIN } from "./fake-studio";
import { STUDIO_ROUTES } from "./world";

const ID = "a0000000000000000000000001";
const NOTE: NoteRef = { path: "studio/Note.md", name: "Note.md", extension: "md" };

function settings(studio = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "studio-token", importFolder: "" }): BlygSettings {
  const s = defaultSettings();
  s.github = { ...s.github, owner: "o", repo: "r" };
  s.studio = studio;
  s.routes = [...STUDIO_ROUTES];
  return s;
}
const state = (fm: LocalBlygFrontmatter, over: { localHash?: string | null; problems?: string[]; s?: BlygSettings } = {}) =>
  computePanelState({
    settings: over.s ?? settings(),
    note: NOTE,
    frontmatter: fm,
    localHash: over.localHash === undefined ? "sha256:now" : over.localHash,
    thread: { quotes: 0, passages: 0, links: 0, problems: over.problems ?? [] },
  });
const record = (over: LocalBlygFrontmatter = {}): LocalBlygFrontmatter => ({ id: ID, origin: STUDIO_ORIGIN, version: 3, sent: "sha256:now", ...over });

describe("panel for a drafts-only Studio folder and for drafts", () => {
  const DRAFT_NOTE: NoteRef = { path: "drafts/Note.md", name: "Note.md", extension: "md" };
  const stateAt = (note: NoteRef, fm: LocalBlygFrontmatter, localHash = "sha256:now") =>
    computePanelState({ settings: settings(), note, frontmatter: fm, localHash, thread: { quotes: 0, passages: 0, links: 0, problems: [] } });
  const draft = (over: LocalBlygFrontmatter = {}): LocalBlygFrontmatter => ({ id: ID, origin: STUDIO_ORIGIN, version: 0, sent: "sha256:now", ...over });

  it("a new note says Send draft, says nothing goes live, and has no Withdraw", () => {
    const s = stateAt(DRAFT_NOTE, {});
    expect(s).toMatchObject({ status: "not-published", publishLabel: "Send draft", canPublish: true, showWithdraw: false, canWithdraw: false, draftsOnly: true, showDelete: false });
    expect(s.headline).toBe("Not sent yet.");
    expect(s.notes.join(" ")).toMatch(/Nothing goes live/);
  });

  it("a sent draft (version 0): a draft status, no web address, Delete draft offered, Publish is the way to make it version 1 in a normal folder", () => {
    const here = stateAt(DRAFT_NOTE, draft());
    expect(here).toMatchObject({ status: "draft", publishLabel: "Send draft", showDelete: true, canDelete: true, canOpenWeb: false, ok: false });
    expect(here.webUrl).toBeUndefined();
    expect(here.headline).toBe("Draft in the Studio (not published).");
    const normal = stateAt(NOTE, draft());
    expect(normal).toMatchObject({ status: "draft", publishLabel: "Publish", emphasizePublish: true, showDelete: true, showWithdraw: true, draftsOnly: false });
    expect(normal.notes.join(" ")).toMatch(/version 1/);
  });

  it("a draft with changes not sent yet says so", () => {
    expect(stateAt(DRAFT_NOTE, draft({ sent: "sha256:older" })).headline).toBe("Draft in the Studio, with changes not sent yet.");
  });

  it("a published note in a drafts-only folder can send drafts but never withdraw, and Delete draft is not offered", () => {
    const s = stateAt(DRAFT_NOTE, record({ sent: "sha256:older" }));
    expect(s).toMatchObject({ status: "local-changes", publishLabel: "Send draft", showWithdraw: false, canWithdraw: false, showDelete: false, draftsOnly: true });
    expect(s.notes.join(" ")).toMatch(/published version stays/);
    expect(stateAt(DRAFT_NOTE, record()).notes.join(" ")).toMatch(/only drafts are sent/);
  });

  it("a normal Studio folder is unchanged: Publish, Withdraw, no Delete draft for published items", () => {
    expect(state({})).toMatchObject({ draftsOnly: false, showDelete: false, publishLabel: "Publish", showWithdraw: true });
    expect(state(record())).toMatchObject({ showDelete: false, draftsOnly: false });
  });
});

describe("panel for a Studio note (from the note's own record, no network)", () => {
  it("not published yet: Publish is offered", () => {
    expect(state({})).toMatchObject({ status: "not-published", canPublish: true, canWithdraw: false, showWithdraw: true, route: { mode: "studio" }, ok: false, publishLabel: "Publish" });
  });

  it("published and unchanged: green, with a link to the item's page in the Studio", () => {
    const s = state(record());
    expect(s).toMatchObject({ status: "in-sync", ok: true, publishLabel: "Update", emphasizePublish: false, webUrl: `${STUDIO_ORIGIN}f/${ID}/`, canOpenWeb: true, showOpenWeb: true });
    expect(s.headline).toBe("Published (v3) and up to date.");
    expect(s.item).toMatchObject({ id: ID, version: 3 });
  });

  it("uses the stamped address, but only when it belongs to this Studio", () => {
    expect(state(record({ url: `${STUDIO_ORIGIN}f/${ID}/` })).webUrl).toBe(`${STUDIO_ORIGIN}f/${ID}/`);
    expect(state(record({ url: "https://evil.example/f/x/" })).webUrl).toBe(`${STUDIO_ORIGIN}f/${ID}/`);
  });

  it("changed since the last send: Update is emphasised", () => {
    expect(state(record({ sent: "sha256:older" }))).toMatchObject({ status: "local-changes", ok: false, emphasizePublish: true, canPublish: true });
  });

  it("withdrawn: Publish again", () => {
    expect(state(record({ withdrawn: true }))).toMatchObject({ status: "withdrawn", publishLabel: "Publish again", canPublish: true });
  });

  it("an id from the old blyg, or from another Studio, cannot be published here", () => {
    const old = state({ id: ID, version: 2 });
    expect(old).toMatchObject({ status: "other-blyg", canPublish: false });
    expect(old.headline).toMatch(/old blyg, not in the Studio/);
    const other = state(record({ origin: "https://other.example/" }));
    expect(other).toMatchObject({ status: "other-blyg", canPublish: false });
    expect(other.notes[0]).toMatch(/belongs to https:\/\/other\.example\//);
  });

  it("explains what stops it before the user taps: an unclosed comment, local problems, a bad id or kind, no Studio set up", () => {
    expect(state({}, { localHash: null }).status).toBe("unreadable-text");
    expect(state({}, { problems: ["Too long for a fragment: 1200 characters, the limit is 1000."] })).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(state({ kind: "thread" })).toMatchObject({ status: "not-published", canPublish: true, kind: "thread" });
    expect(state(record({ id: "../x" })).status).toBe("invalid-id");
    expect(state({ kind: "essay" }).status).toBe("invalid-kind");
    expect(state({}, { s: settings({ baseUrl: "", mount: "", tokenSecretName: "", importFolder: "" }) })).toMatchObject({ status: "studio-missing", canPublish: false });
  });

  it("a thread shows what it quotes, and which quotes come from other blygs", () => {
    const s = computePanelState({
      settings: settings(),
      note: NOTE,
      frontmatter: { kind: "thread" },
      localHash: "sha256:now",
      thread: { quotes: 3, passages: 1, links: 2, remote: ["Blog B: Remote fragment"], problems: [] },
    });
    expect(s.thread).toEqual({ quotes: 3, passages: 1, links: 2, remote: ["Blog B: Remote fragment"] });
    expect(s.write).toMatchObject({ canQuoteInThread: true, canContinue: true, canInsertQuote: true, canInsertLink: true });
    expect(s).toMatchObject({ showWithdraw: true, canWithdraw: false });
  });

  it("Withdraw is live once there is a published item to withdraw, and not for one already withdrawn or from another blyg", () => {
    expect(state(record())).toMatchObject({ showWithdraw: true, canWithdraw: true });
    expect(state(record({ sent: "sha256:older" })).canWithdraw).toBe(true);
    expect(state(record({ withdrawn: true })).canWithdraw).toBe(false);
    expect(state({ id: ID, version: 2 }).canWithdraw).toBe(false);
  });

  it("the writing buttons work on a fragment of a Studio folder too, and make-thread only before the first publish", () => {
    expect(state({}).write).toMatchObject({ canQuoteInThread: true, canContinue: false, canMakeThread: true, canInsertQuote: false, canInsertLink: true });
    expect(state(record()).write).toMatchObject({ canMakeThread: false });
  });

  it("Studio routes count as a place to create new notes", () => {
    expect(state({}).write.canCreate).toBe(true);
    const onlyStudio = settings();
    onlyStudio.routes = [{ vaultPrefix: "studio/", mode: "studio", label: "Blyg item" }];
    expect(state({}, { s: onlyStudio }).write.canCreate).toBe(true);
  });
});

describe("loading it from the vault", () => {
  const load = (text: string, s = settings()) => {
    const w = makeWorld({ vault: { [NOTE.path]: text } });
    return loadPanelState({ settings: s, vault: w.deps.vault }, NOTE);
  };

  it("compares the text with the hash that was sent", async () => {
    const hash = await contentHash("Hello.");
    const synced = await load(`---\nblyg_id: ${ID}\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_version: 1\nblyg_sent: ${JSON.stringify(hash)}\n---\nHello.\n`);
    expect(synced).toMatchObject({ status: "in-sync", ok: true });
    const edited = await load(`---\nblyg_id: ${ID}\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_version: 1\nblyg_sent: ${JSON.stringify(hash)}\n---\nHello, edited.\n`);
    expect(edited.status).toBe("local-changes");
  });

  it("reports the same local problems the publish would refuse", async () => {
    expect((await load(`${"a".repeat(1100)}\n`)).notes[0]).toMatch(/Too long for a fragment: 1100 characters/);
    expect((await load("See [[Another note]].\n")).notes[0]).toMatch(/Links to notes the Studio does not have: \[\[Another note\]\]/);
    expect((await load("\n")).notes[0]).toMatch(/note is empty/);
  });

  it("a thread that quotes by name is up to date when the stamped hash is of the resolved text", async () => {
    const quoted = "studio/Quoted.md";
    const qid = "b0000000000000000000000002";
    const text = `---\nblyg_kind: thread\nblyg_id: ${ID}\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_version: 1\nblyg_sent: HASH\n---\n![[Quoted]]\n\nMine.\n`;
    const w = makeWorld({ vault: { [NOTE.path]: text, [quoted]: `---\nblyg_id: ${qid}\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_version: 1\n---\nx\n` } });
    w.local.set(NOTE.path, text.replace("HASH", JSON.stringify(await contentHash(`![[${qid}]]\n\nMine.`))));
    const s = await loadPanelState({ settings: settings(), vault: w.deps.vault }, NOTE);
    expect(s).toMatchObject({ status: "in-sync", ok: true, kind: "thread", thread: { quotes: 1, passages: 0, links: 0 } });
  });

  it("lists the labels of quotes from other blygs", async () => {
    const s = await load(`---\nblyg_kind: thread\n---\n![[${"c".repeat(26)} | Blog B: A remote thought]]\n> a passage\n\nText.\n`);
    expect(s.thread).toEqual({ quotes: 1, passages: 1, links: 0, remote: ["Blog B: A remote thought"] });
  });

  it("studioTextSummary is empty for an ordinary fragment", () => {
    const w = makeWorld({ vault: {} });
    expect(studioTextSummary("Hello `[[code]]` world", "fragment", { settings: settings(), vault: w.deps.vault, note: NOTE }).problems).toEqual([]);
  });
});

describe("what the Studio itself said (cached answers; the panel never waits for them)", () => {
  const facts = (item: StudioFacts["item"], mentions: StudioFacts["mentions"] = null): StudioFacts => ({ item, mentions, at: 0 });
  const live = (fm: LocalBlygFrontmatter, studio: { facts?: StudioFacts; warnings?: string[] }, localHash = "sha256:now") =>
    computePanelState({ settings: settings(), note: NOTE, frontmatter: fm, localHash, studio: { warnings: studio.warnings ?? [], ...(studio.facts ? { facts: studio.facts } : {}) } });
  const item = (over: Partial<Extract<StudioFacts["item"], object>> = {}): StudioFacts["item"] => ({ status: "public", version: 3, workingHash: "sha256:now", ...over });

  it("nothing known yet (no answer so far): exactly what the note's own record says, and no extra box", () => {
    const s = live(record(), {});
    expect(s).toMatchObject({ status: "in-sync", ok: true });
    expect(s.studio).toEqual({ warnings: [] });
  });

  it("shows how many other blygs point at the item, or that none do yet", () => {
    expect(live(record(), { facts: facts(item(), { count: 4, complete: true }) }).studio?.mentions).toEqual({ count: 4, complete: true });
    expect(live(record(), { facts: facts(item(), { count: 0, complete: true }) }).studio?.mentions).toEqual({ count: 0, complete: true });
    expect(live(record(), { facts: facts(item()) }).studio?.mentions).toBeUndefined();
  });

  it("an item the Studio does not have is its own state; Publish is closed", () => {
    expect(live(record(), { facts: facts("missing") })).toMatchObject({ status: "studio-item-missing", canPublish: false, canWithdraw: false, ok: false });
  });

  it("work done in the Studio's editor is said before the user taps, and Update is the way to look at it", () => {
    const s = live(record(), { facts: facts(item({ workingHash: "sha256:typed-there" })) });
    expect(s).toMatchObject({ status: "edited-there", ok: false, canPublish: true, canWithdraw: true, publishLabel: "Update", emphasizePublish: true });
    expect(s.headline).toMatch(/Published \(v3\); its working copy in the Studio was changed there/);
    expect(s).toMatchObject({ showPull: true, canPull: true });
    expect(live(record(), { facts: facts(item({ workingHash: "sha256:now" })) })).toMatchObject({ showPull: false, canPull: false });
    // what the note last sent, or what it says now, is not 'edited there'
    expect(live(record(), { facts: facts(item({ workingHash: "sha256:now" })) }).status).toBe("in-sync");
    expect(live(record({ sent: "sha256:older" }), { facts: facts(item({ workingHash: "sha256:older" })) }).status).toBe("local-changes");
  });

  it("withdrawn in the Studio while the note does not know: says so with the Studio's version, and offers Publish again", () => {
    const s = live(record(), { facts: facts(item({ status: "withdrawn", version: 4 })) });
    expect(s).toMatchObject({ status: "withdrawn", canPublish: true, publishLabel: "Publish again", item: { version: 4 } });
    expect(s.headline).toBe("Withdrawn in the Studio (v4).");
  });

  it("an unreachable Studio is 'unknown', never a changed verdict: the note's own record stands and one line says so", () => {
    const s = live(record(), { facts: facts("unreachable") });
    expect(s).toMatchObject({ status: "in-sync", ok: true });
    expect(s.studio).toEqual({ warnings: [], unreachable: true });
  });

  it("warnings about the whole Studio travel with the state, also for a note that is not published yet", () => {
    const warnings = ["The Studio token expires in 3 days."];
    expect(live({}, { warnings }).studio?.warnings).toEqual(warnings);
    expect(live(record(), { warnings }).studio?.warnings).toEqual(warnings);
  });

  it("a note of another blyg is never judged by the Studio's answer about an id that is not its own", () => {
    expect(live({ id: ID, version: 2 }, { facts: facts("missing") }).status).toBe("other-blyg");
  });

  it("other routes get no Studio box", () => {
    const s = computePanelState({ settings: { ...settings(), routes: [{ vaultPrefix: "studio/", mode: "plain", dest: "x/", label: "essay" }] }, note: NOTE, frontmatter: {}, localHash: "h", studio: { warnings: ["x"] } });
    expect(s.studio).toBeUndefined();
  });

  it("loading asks the callback only for a note of this Studio, with its id", async () => {
    const w = makeWorld({ vault: { [NOTE.path]: `---\nblyg_id: ${ID}\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_version: 1\n---\nHello.\n`, "studio/Other.md": `---\nblyg_id: ${ID}\nblyg_origin: https://elsewhere.test/\n---\nHi.\n`, "studio/Fresh.md": "New.\n" } });
    const asked: Array<[string, string | null]> = [];
    const studioLive = (n: NoteRef, id: string | null) => (asked.push([n.path, id]), { warnings: ["w"], ...(id ? { facts: facts(item(), { count: 1, complete: true }) } : {}) });
    const mine = await loadPanelState({ settings: settings(), vault: w.deps.vault, studioLive }, NOTE);
    expect(mine.studio).toEqual({ warnings: ["w"], mentions: { count: 1, complete: true } });
    await loadPanelState({ settings: settings(), vault: w.deps.vault, studioLive }, { path: "studio/Other.md", name: "Other.md", extension: "md" });
    await loadPanelState({ settings: settings(), vault: w.deps.vault, studioLive }, { path: "studio/Fresh.md", name: "Fresh.md", extension: "md" });
    expect(asked).toEqual([[NOTE.path, ID], ["studio/Other.md", null], ["studio/Fresh.md", null]]);
  });
});

describe("Import from Studio in the panel", () => {
  it("is offered when a Studio is set up and a folder publishes to it, and not otherwise", () => {
    expect(state({}).write.canImport).toBe(true);
    expect(state({}, { s: settings({ baseUrl: "", mount: "", tokenSecretName: "", importFolder: "" }) }).write.canImport).toBe(false);
  });
});
