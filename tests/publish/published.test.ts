// The panel's record of plain publishes (essays, pages): what gets recorded, when, and what the panel then says.
import { describe, expect, it } from "vitest";
import { loadPanelState } from "../../src/app/panelState";
import { createPublishedRecorder, createPublishedStore, parseRecords, type PublishedFileIo } from "../../src/app/publishedStore";
import { defaultSettings, type BlygSettings } from "../../src/settings/schema";
import { MACRO_ROUTES, makeWorld, tap, type World } from "../world";

const ESSAY = "website/essays/Essay.md";
const DEST = "src/content/essays/Essay.md";
const BODY = "---\ntitle: T\n---\nBody text\n";

function memoryIo(initial: string | null = null): PublishedFileIo & { text: string | null; writes: number } {
  const io = {
    text: initial,
    writes: 0,
    read: () => Promise.resolve(io.text),
    write: (t: string) => {
      io.text = t;
      io.writes++;
      return Promise.resolve();
    },
  };
  return io;
}

function userSettings(over: Partial<BlygSettings["github"]> = {}): BlygSettings {
  const s = defaultSettings();
  s.github = { ...s.github, owner: "o", repo: "r", ...over };
  s.routes = MACRO_ROUTES;
  return s;
}

function wired(w: World) {
  const io = memoryIo();
  const store = createPublishedStore(io);
  w.deps.rememberPublished = createPublishedRecorder(store, w.deps.clock);
  const panel = (settings = userSettings(), path = ESSAY) =>
    loadPanelState({ settings, vault: w.deps.vault, published: store }, { path, name: path.split("/").pop() ?? path, extension: "md" });
  return { io, store, panel };
}

describe("recording what a plain publish sent", () => {
  it("a commit is recorded for its branch and path", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY } });
    const { store } = wired(w);
    expect((await tap(w, ESSAY)).status).toBe("committed");
    const rec = await store.get("main", DEST);
    expect(rec?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rec?.at).toBe(w.now);
    expect(await store.get("preview", DEST)).toBeNull();
  });

  it("'No changes' is recorded too: the repo already holds the text, so an essay the macro sent becomes known", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY }, repo: { [DEST]: BODY } });
    const { panel } = wired(w);
    expect((await panel()).status).toBe("plain-unknown");
    expect((await tap(w, ESSAY)).status).toBe("noop");
    expect((await panel()).status).toBe("plain-in-sync");
  });

  it("nothing is recorded for a cancelled, refused or failed publish", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY, "website/essays/Bad.md": "text %% never closed" } });
    const { io } = wired(w);
    w.answer = false;
    expect((await tap(w, ESSAY)).status).toBe("cancelled");
    expect((await tap(w, "website/essays/Bad.md")).status).toBe("refused");
    w.answer = true;
    w.fail.set(`PUT ${DEST}`, { status: 500 });
    expect((await tap(w, ESSAY)).status).toBe("failed");
    expect(io.writes).toBe(0);
  });

  it("a Blyg note leaves no record", async () => {
    const w = makeWorld({ vault: { "website/blyg/Note.md": "Hello world\n" } });
    const { io } = wired(w);
    expect((await tap(w, "website/blyg/Note.md")).status).toBe("committed");
    expect(io.writes).toBe(0);
  });

  it("a record that cannot be written never fails the publish", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY } });
    w.deps.rememberPublished = () => Promise.reject(new Error("disk full"));
    const out = await tap(w, ESSAY);
    expect(out.status).toBe("committed");
    expect(w.commits).toHaveLength(1);
  });
});

describe("what the panel says about an essay", () => {
  it("published → in sync; an edit → changed; undoing the edit → in sync again", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY } });
    const { panel } = wired(w);
    await tap(w, ESSAY);
    const done = await panel();
    expect([done.status, done.published?.at, done.canPublish]).toEqual(["plain-in-sync", w.now, true]);
    w.local.set(ESSAY, BODY.replace("Body", "Longer body"));
    expect((await panel()).status).toBe("plain-changed");
    w.local.set(ESSAY, BODY);
    expect((await panel()).status).toBe("plain-in-sync");
  });

  it("changes a publish would ignore do not count: trailing whitespace, line endings, %% comments", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY } });
    const { panel } = wired(w);
    await tap(w, ESSAY);
    w.local.set(ESSAY, "---\ntitle: T\n---\r\nBody text   \r\n\r\n");
    expect((await panel()).status).toBe("plain-in-sync");
    w.local.set(ESSAY, "---\ntitle: T\n---\nBody text\n%% a private note %%\n");
    expect((await panel()).status).toBe("plain-in-sync");
    w.local.set(ESSAY, "---\ntitle: T2\n---\nBody text\n");
    expect((await panel()).status).toBe("plain-changed");
  });

  it("each branch has its own record: published to production says nothing about preview", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY } });
    const { panel } = wired(w);
    await tap(w, ESSAY);
    expect((await panel(userSettings({ useBranch: "production" }))).status).toBe("plain-in-sync");
    expect((await panel(userSettings({ useBranch: "preview" }))).status).toBe("plain-unknown");
  });

  it("an unclosed comment is flagged, whatever the record says", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY } });
    const { panel } = wired(w);
    await tap(w, ESSAY);
    w.local.set(ESSAY, "Body %% open");
    const s = await panel();
    expect([s.status, s.canPublish]).toEqual(["unreadable-text", false]);
  });

  it("without a store, an essay is simply 'not known'", async () => {
    const w = makeWorld({ vault: { [ESSAY]: BODY } });
    const s = await loadPanelState({ settings: userSettings(), vault: w.deps.vault }, { path: ESSAY, name: "Essay.md", extension: "md" });
    expect(s.status).toBe("plain-unknown");
  });
});

describe("the record file", () => {
  it("a missing, damaged or newer-format file reads as empty, never as an error", () => {
    expect(parseRecords(null)).toEqual({});
    expect(parseRecords("not json")).toEqual({});
    expect(parseRecords('{"version":2,"records":{"main":{"a":{"hash":"h","at":"t"}}}}')).toEqual({});
    expect(parseRecords('{"version":1,"records":{"main":{"a":{"hash":1,"at":"t"},"b":{"hash":"h","at":"t"}}}}')).toEqual({ main: { b: { hash: "h", at: "t" } } });
  });

  it("a new record joins the others already in the file (another device's records survive)", async () => {
    const io = memoryIo(JSON.stringify({ version: 1, records: { main: { "other.md": { hash: "h1", at: "t1" } } } }));
    const store = createPublishedStore(io);
    await store.set("main", "mine.md", { hash: "h2", at: "t2" });
    expect(parseRecords(io.text)).toEqual({ main: { "other.md": { hash: "h1", at: "t1" }, "mine.md": { hash: "h2", at: "t2" } } });
  });

  it("a record that arrived from another device shows without a restart (the file is read every time)", async () => {
    const io = memoryIo();
    const store = createPublishedStore(io);
    expect(await store.get("main", "a.md")).toBeNull();
    io.text = JSON.stringify({ version: 1, records: { main: { "a.md": { hash: "h", at: "t" } } } });
    expect(await store.get("main", "a.md")).toEqual({ hash: "h", at: "t" });
  });

  it("two quick writes both survive", async () => {
    const io = memoryIo();
    const store = createPublishedStore(io);
    await Promise.all([store.set("main", "a.md", { hash: "1", at: "t" }), store.set("main", "b.md", { hash: "2", at: "t" })]);
    expect(Object.keys(parseRecords(io.text).main ?? {}).sort()).toEqual(["a.md", "b.md"]);
  });

  it("the file holds paths and fingerprints, never the text", async () => {
    const w = makeWorld({ vault: { [ESSAY]: "---\ntitle: T\n---\nA very private sentence\n" } });
    const { io } = wired(w);
    await tap(w, ESSAY);
    expect(io.text).not.toContain("private");
    expect(io.text).toContain(DEST);
  });
});
