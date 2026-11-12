// Publishing a fragment through a Studio (route mode "studio"): the order of the steps, what is refused before any request, what a
// cancel leaves behind, and the invariants of CLAUDE.md §3 (the note changes only after the Studio confirmed; fail closed).
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import { HttpError } from "../../src/platform/http";
import { M } from "../../src/publish/messages";
import { frontmatterOf, has } from "../world";
import { FakeStudio, STUDIO_ORIGIN, STUDIO_TOKEN, idOf } from "./fake-studio";
import { repostNote } from "../../src/publish/router";
import { repostNoteText } from "../../src/publish/studio";
import { makeStudioWorld, tapStudio, tapStudioWithdraw, type StudioWorld } from "./world";

const NOTE = "studio/Note.md";
const fm = (w: StudioWorld, path = NOTE): Record<string, unknown> => frontmatterOf(w.local.get(path) ?? "");
const stamped = (id: string, over: Record<string, unknown> = {}): string =>
  Object.entries({ blyg_origin: STUDIO_ORIGIN, blyg_id: id, blyg_version: 1, ...over })
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join("\n");

async function firstPublish(body = "Hello world.\n"): Promise<{ w: StudioWorld; id: string }> {
  const w = makeStudioWorld({ vault: { [NOTE]: body } });
  const out = await tapStudio(w, NOTE);
  expect(out.status).toBe("published");
  return { w, id: out.id ?? "" };
}

describe("first publish", () => {
  it("previews, asks, creates the item, publishes it, and only then stamps the note", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello world.\n" } });
    const out = await tapStudio(w, NOTE);
    const id = idOf(1);
    expect(out).toMatchObject({ status: "published", id, version: 1 });
    expect(out.notices).toEqual([`Published to the Studio: new item ${id}, version 1. ${STUDIO_ORIGIN}f/${id}/`]);
    // the order on the wire: preview first (nothing written yet), then create, then publish
    expect(w.studio.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/preview", "POST /api/items", `POST /api/items/${id}/publish`]);
    expect(w.studio.items.get(id)).toMatchObject({ status: "public", version: 1, content_md: "Hello world." });
    const hash = await contentHash("Hello world.");
    expect(fm(w)).toEqual({ blyg_origin: STUDIO_ORIGIN, blyg_id: id, blyg_version: 1, blyg_url: `${STUDIO_ORIGIN}f/${id}/`, blyg_sent: hash });
    expect(w.pendingMap.size).toBe(0);
  });

  it("shows the window the Studio's rendering and names the Studio, not a branch", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello <b>world</b>.\n" } });
    await tapStudio(w, NOTE);
    expect(w.previews).toHaveLength(1);
    expect(w.previews[0]).toMatchObject({ action: "create", toVersion: 1, before: null, after: "Hello <b>world</b>.", label: "fragment" });
    expect(w.previews[0]?.studio).toEqual({ host: "https://studio.test", html: "<p>Hello &lt;b>world&lt;/b>.</p>", askNote: false });
  });

  it("sends the text the way every other publish does: frontmatter off, comments out, normalised", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "---\ntitle: x\n---\r\nKept.\r\n%% private %%\r\nAlso kept.\r\n\r\n" } });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(w.studio.items.get(idOf(1))?.content_md).toBe("Kept.\n\nAlso kept.".replace("\n\n", "\n\n"));
    expect(has(out.notices, /Left out 1 Obsidian comment/)).toBe(true);
  });

  it("never lets the token into a URL or a notice", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    const out = await tapStudio(w, NOTE);
    expect(JSON.stringify(out)).not.toContain(STUDIO_TOKEN);
    expect(w.studio.seen.every((s) => !s.path.includes(STUDIO_TOKEN))).toBe(true);
    expect(w.studio.seen.every((s) => s.authorization === `Bearer ${STUDIO_TOKEN}`)).toBe(true);
  });
});

describe("cancelling", () => {
  it("leaves the Studio exactly as it was: no item, no draft, no record", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.answer = false;
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "cancelled", notices: [M.studioCancelled] });
    expect(w.studio.items.size).toBe(0);
    expect(w.studio.writes()).toEqual([]);
    expect(w.pendingMap.size).toBe(0);
    expect(w.local.get(NOTE)).toBe("Hello.\n");
  });

  it("an update that is cancelled does not touch the Studio's working copy either", async () => {
    const { w, id } = await firstPublish();
    w.local.set(NOTE, w.local.get(NOTE)?.replace("Hello world.", "Hello, changed.") ?? "");
    expect(id).toBe(idOf(1));
    const before = w.studio.writes().length;
    w.answer = false;
    expect((await tapStudio(w, NOTE)).status).toBe("cancelled");
    expect(w.studio.writes()).toHaveLength(before);
    expect(w.studio.items.get(id)?.content_md).toBe("Hello world.");
  });
});

describe("updating", () => {
  it("sends the changed text as the working copy, publishes the next version and restamps", async () => {
    const { w, id } = await firstPublish();
    const body = w.local.get(NOTE)?.replace("Hello world.", "Hello, new world.") ?? "";
    w.local.set(NOTE, body);
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", id, version: 2 });
    expect(out.notices[0]).toBe(`Published to the Studio: version 2. ${STUDIO_ORIGIN}f/${id}/`);
    expect(w.previews[1]).toMatchObject({ action: "update", fromVersion: 1, toVersion: 2, before: "Hello world.", after: "Hello, new world." });
    expect(fm(w)).toMatchObject({ blyg_version: 2, blyg_sent: await contentHash("Hello, new world.") });
    expect(w.studio.latest(id)?.content_md).toBe("Hello, new world.");
  });

  it("says nothing changed, and sends nothing, when the Studio already holds exactly this text", async () => {
    const { w } = await firstPublish();
    const requests = w.studio.seen.length;
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "noop", notices: [M.noChanges] });
    // only the read: Studio would have made a version 2 of the same words
    expect(w.studio.seen.slice(requests).map((s) => s.method)).toEqual(["GET"]);
    expect(w.studio.items.get(idOf(1))?.version).toBe(1);
    expect(w.previews).toHaveLength(1);
  });

  it("repairs a stale record of the note when nothing needs sending (the text was published from somewhere else)", async () => {
    const { w, id } = await firstPublish();
    w.local.set(NOTE, `---\n${stamped(id, { blyg_version: 1, blyg_sent: "sha256:old" })}\n---\nHello world.\n`);
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("noop");
    expect(fm(w).blyg_sent).toBe(await contentHash("Hello world."));
  });

  it("shows the difference and asks before overwriting work done in the Studio; cancelling leaves both sides as they were", async () => {
    const { w, id } = await firstPublish();
    w.studio.editThere(id, "Edited over there.");
    const text = `---\n${stamped(id, { blyg_sent: await contentHash("Hello world.") })}\n---\nHello, changed here.\n`;
    w.local.set(NOTE, text);
    w.answerFor = (p) => p.action !== "studio-conflict";
    const writes = w.studio.writes().length;
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "cancelled", notices: [M.studioChangedThereCancelled(id)] });
    expect(w.studio.writes()).toHaveLength(writes);
    expect(w.studio.items.get(id)?.content_md).toBe("Edited over there.");
    expect(w.local.get(NOTE)).toBe(text);
    // the window compares the Studio's copy (before) with the note (after), and only the conflict window was shown
    expect(w.previews).toHaveLength(2);
    expect(w.previews[1]).toMatchObject({ action: "studio-conflict", id, before: "Edited over there.", after: "Hello, changed here.", studio: { host: "https://studio.test", html: "" } });
  });

  it("overwrites the Studio's copy when the user agrees, then shows the normal preview and publishes", async () => {
    const { w, id } = await firstPublish();
    w.studio.editThere(id, "Edited over there.");
    w.local.set(NOTE, `---\n${stamped(id, { blyg_sent: await contentHash("Hello world.") })}\n---\nHello, changed here.\n`);
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", id, version: 2 });
    expect(w.previews.map((p) => p.action)).toEqual(["create", "studio-conflict", "update"]);
    expect(w.studio.latest(id)?.content_md).toBe("Hello, changed here.");
  });

  it("the preview comes first: a text the Studio refuses never shows the overwrite question", async () => {
    const { w, id } = await firstPublish();
    w.studio.editThere(id, "Edited over there.");
    w.local.set(NOTE, `---\n${stamped(id, { blyg_sent: await contentHash("Hello world.") })}\n---\nHello, changed here.\n`);
    w.studio.previewProblems = [{ reason: "something is wrong" }];
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(w.previews).toHaveLength(1);
  });

  it("a change made in the Studio that equals this note's text is not a conflict", async () => {
    const { w, id } = await firstPublish();
    w.studio.editThere(id, "Same words now.");
    w.local.set(NOTE, `---\n${stamped(id, { blyg_sent: await contentHash("Hello world.") })}\n---\nSame words now.\n`);
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", version: 2 });
  });

  it("an item withdrawn in the Studio comes back with a publish (spec §9), as a new version", async () => {
    const { w, id } = await firstPublish();
    const item = w.studio.items.get(id);
    if (item) {
      item.status = "withdrawn";
      item.version = 2;
    }
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", version: 3 });
    expect(w.previews[1]?.changes).toContain("The item is no longer withdrawn");
    expect(w.studio.items.get(id)?.status).toBe("public");
  });
});

describe("refused before any request", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["an empty note", "---\nx: 1\n---\n\n", /body is empty/],
    ["a fragment over the cap", `${"a".repeat(1001)}\n`, /1001 chars, over the 1000-char fragment cap/],
    ["an unclosed %% comment", "Fine.\n%% never closed\n", /never closes/],
    ["a [[wikilink]] to another note (the Studio would show literal brackets)", "See [[Other note]].\n", /links the Studio would show as plain text: \[\[Other note\]\]/],
    ["an image embed", "![[photo.png]]\n", /image “photo\.png” is not in the vault/],
    ["an unknown blyg_kind", "---\nblyg_kind: essay\n---\nText.\n", /blyg_kind is “essay”/],
    ["a quote line in a fragment", "x\n\n![[7000000000000000000000000a]]\n", /quotes another item|embed/],
  ];
  for (const [name, text, expected] of cases) {
    it(`${name}`, async () => {
      const w = makeStudioWorld({ vault: { [NOTE]: text } });
      const out = await tapStudio(w, NOTE);
      expect(out.status).toBe("refused");
      expect(out.notices.join(" ")).toMatch(expected);
      expect(w.studio.seen).toEqual([]);
      expect(w.local.get(NOTE)).toBe(text);
    });
  }

  it("a non-Markdown file", async () => {
    const w = makeStudioWorld({ vault: { "studio/pic.png": "x" } });
    const out = await tapStudio(w, "studio/pic.png", "png");
    expect(out).toMatchObject({ status: "refused", notices: ["Refusing: \"pic.png\" is not a Markdown file."] });
    expect(w.studio.seen).toEqual([]);
  });

  it("a path in no route, and a Studio route with no usable Studio, say so", async () => {
    const w = makeStudioWorld({ vault: { "elsewhere/N.md": "x\n", [NOTE]: "x\n" } });
    expect((await tapStudio(w, "elsewhere/N.md")).status).toBe("refused");
    delete w.deps.studio;
    w.deps.studioProblem = "No Studio token chosen yet. In the plugin settings, pick or create a keychain entry.";
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "refused", notices: [w.deps.studioProblem] });
    delete w.deps.studioProblem;
    expect((await tapStudio(w, NOTE)).notices).toEqual([M.studioNotConfigured]);
  });
});

describe("whose item is it", () => {
  it("refuses a note that carries an id from the old GitHub blyg (no origin): publishing would not update that item", async () => {
    const id = "a0000000000000000000000001";
    const w = makeStudioWorld({ vault: { [NOTE]: `---\nblyg_id: ${id}\nblyg_version: 2\n---\nOld note.\n` } });
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "refused", notices: [M.studioOtherRecord(id, null)] });
    expect(w.studio.seen).toEqual([]);
  });

  it("refuses a note stamped for another blyg", async () => {
    const id = "a0000000000000000000000001";
    const w = makeStudioWorld({ vault: { [NOTE]: `---\nblyg_id: ${id}\nblyg_origin: https://other.example/\n---\nText.\n` } });
    const out = await tapStudio(w, NOTE);
    expect(out.notices).toEqual([M.studioOtherRecord(id, "https://other.example/")]);
    expect(w.studio.seen).toEqual([]);
  });

  it("refuses a damaged record: an origin without an id, or an id that is not an id", async () => {
    const a = makeStudioWorld({ vault: { [NOTE]: `---\nblyg_origin: ${STUDIO_ORIGIN}\n---\nText.\n` } });
    expect((await tapStudio(a, NOTE)).notices[0]).toMatch(/blyg_origin but no blyg_id/);
    const b = makeStudioWorld({ vault: { [NOTE]: `---\nblyg_id: ../../x\nblyg_origin: ${STUDIO_ORIGIN}\n---\nText.\n` } });
    expect((await tapStudio(b, NOTE)).notices[0]).toMatch(/not a valid Blyg id/);
    expect(a.studio.seen).toEqual([]);
    expect(b.studio.seen).toEqual([]);
  });

  it("does not make a new item when the recorded one is gone from the Studio", async () => {
    const id = "a0000000000000000000000009";
    const w = makeStudioWorld({ vault: { [NOTE]: `---\n${stamped(id)}\n---\nText.\n` } });
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "refused", notices: [M.studioItemMissing(id, "https://studio.test")] });
    expect(w.studio.writes()).toEqual([]);
  });

  it("refuses when the kind differs from the item's", async () => {
    const { w, id } = await firstPublish();
    const item = w.studio.items.get(id);
    if (item) item.kind = "thread";
    w.local.set(NOTE, `---\n${stamped(id)}\n---\nText.\n`);
    expect((await tapStudio(w, NOTE)).notices).toEqual([M.studioKindFixed(id, "fragment", "thread")]);
  });
});

describe("what the Studio says", () => {
  it("refuses, with the Studio's words, when its preview names a problem", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.studio.previewProblems = [{ directive: "[[aaaaaaaaaaaaaaaaaaaaaaaaaa]]", reason: "unknown item" }];
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/the Studio's preview names a problem:\n• \[\[aaaaaaaaaaaaaaaaaaaaaaaaaa\]\]: unknown item/);
    expect(w.studio.writes()).toEqual([]);
    expect(w.previews).toHaveLength(0);
  });

  it("a rejected token is explained, and nothing is stamped", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.studio.token = "a-different-token";
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "failed", notices: [M.studioUnauthorized] });
    expect(w.local.get(NOTE)).toBe("Hello.\n");
  });

  it("a refused publish keeps the draft the plugin made and says so; the note stays untouched", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.studio.forced.set(`POST /api/items/${idOf(1)}/publish`, { status: 400, text: JSON.stringify({ code: "invalid-input", message: "fragment exceeds 1000 characters" }) });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/the Studio refused — “fragment exceeds 1000 characters”/);
    expect(out.notices[1]).toMatch(/saved as a draft of a\d+ in the Studio; the note is untouched/);
    expect(w.local.get(NOTE)).toBe("Hello.\n");
    expect(w.pendingMap.get(NOTE)).toMatchObject({ id: idOf(1), origin: STUDIO_ORIGIN, kind: "fragment" });
  });

  it("a server error on the read stops everything before any write", async () => {
    const { w, id } = await firstPublish();
    w.local.set(NOTE, `---\n${stamped(id)}\n---\nChanged.\n`);
    w.studio.forced.set(`GET /api/items/${id}`, { status: 503, text: JSON.stringify({ code: "internal", message: "overloaded" }) });
    const writes = w.studio.writes().length;
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "failed" });
    expect(out.notices[0]).toMatch(/answered 503 — “overloaded”/);
    expect(w.studio.writes()).toHaveLength(writes);
  });

  it("a network failure before anything was written is safe to retry", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.studio.forced.set("POST /api/preview", new Error("offline"));
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/Network error: offline/);
    expect(w.studio.writes()).toEqual([]);
  });

  it("surfaces a warning Studio attaches to a publish", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.studio.forced.set(`POST /api/items/${idOf(1)}/publish`, { status: 200, text: JSON.stringify({ ok: true, version: 1, revision: 3, warning: "mentions could not be sent" }) });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(has(out.notices, /The Studio says: mentions could not be sent/)).toBe(true);
  });
});

describe("a publish that is interrupted halfway", () => {
  it("remembers the draft it made, and the retry finishes that item instead of creating a second one", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.studio.forced.set(`POST /api/items/${idOf(1)}/publish`, new HttpError("The Studio did not answer within 20 seconds."));
    const first = await tapStudio(w, NOTE);
    expect(first.status).toBe("failed");
    expect(w.pendingMap.get(NOTE)?.id).toBe(idOf(1));
    expect(w.local.get(NOTE)).toBe("Hello.\n");

    const second = await tapStudio(w, NOTE);
    expect(second).toMatchObject({ status: "published", id: idOf(1), version: 1 });
    expect(w.studio.items.size).toBe(1);
    expect(w.pendingMap.size).toBe(0);
  });

  it("when the draft vanished from the Studio, the retry starts clean", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.pendingMap.set(NOTE, { origin: STUDIO_ORIGIN, id: "a0000000000000000000000077", kind: "fragment", at: "2026-10-22T08:00:00Z" });
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", id: idOf(1) });
    expect(w.pendingMap.size).toBe(0);
  });

  it("a draft that belongs to another Studio is ignored", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.pendingMap.set(NOTE, { origin: "https://other.example/", id: "a0000000000000000000000077", kind: "fragment", at: "2026-10-22T08:00:00Z" });
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    expect(w.studio.seen.some((s) => s.path.includes("a0000000000000000000000077"))).toBe(false);
  });

  it("if the note could not be stamped after a successful publish, says so with the id and keeps the draft record", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.failStamp = true;
    const out = await tapStudio(w, NOTE);
    const id = idOf(1);
    expect(out).toMatchObject({ status: "published", localStampFailed: true, notices: [M.studioStampFailed(id, 1, STUDIO_ORIGIN)] });
    expect(w.pendingMap.get(NOTE)?.id).toBe(id);

    // the retry finds the item, sees it holds exactly this text, and only marks the note: no second item, no second version
    w.failStamp = false;
    const again = await tapStudio(w, NOTE);
    expect(again).toMatchObject({ status: "noop", id, version: 1, notices: [M.studioRecovered(id, 1)] });
    expect(w.studio.items.size).toBe(1);
    expect(w.studio.items.get(id)?.version).toBe(1);
    expect(fm(w)).toMatchObject({ blyg_id: id, blyg_origin: STUDIO_ORIGIN, blyg_version: 1 });
    expect(w.pendingMap.size).toBe(0);
  });

  it("if the unstamped item no longer matches this text, it refuses rather than guess", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.failStamp = true;
    await tapStudio(w, NOTE);
    w.failStamp = false;
    w.local.set(NOTE, "Hello, changed.\n");
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "refused", notices: [M.studioPendingPublished(idOf(1))] });
    expect(w.studio.items.size).toBe(1);
  });

  it("a failure to remember the draft does not stop the publish", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    w.failPending.set = true;
    expect((await tapStudio(w, NOTE)).status).toBe("published");
  });
});

describe("withdrawing", () => {
  it("asks first, sends the withdrawal, and only then marks the note; the note keeps its text", async () => {
    const { w, id } = await firstPublish("Hello world.\n");
    const before = w.local.get(NOTE) ?? "";
    const out = await tapStudioWithdraw(w, NOTE);
    expect(out).toMatchObject({ status: "published", id, version: 2, notices: [M.studioWithdrawn(2, `${STUDIO_ORIGIN}f/${id}/`)] });
    expect(w.studio.items.get(id)?.status).toBe("withdrawn");
    expect(fm(w)).toMatchObject({ blyg_id: id, blyg_version: 2, blyg_withdrawn: true });
    expect(w.local.get(NOTE)).toContain("Hello world.");
    expect(before).not.toContain("blyg_withdrawn");
    const window = w.previews.at(-1);
    expect(window).toMatchObject({ action: "withdraw", id, fromVersion: 1, toVersion: 2, before: "Hello world.", studio: { host: "https://studio.test", askNote: true } });
    expect(window?.changes.join(" ")).toMatch(/stays up as “withdrawn”/);
  });

  it("sends the change note, trimmed, and none when it is empty", async () => {
    const { w, id } = await firstPublish();
    w.answer = { note: "  retracted  " };
    await tapStudioWithdraw(w, NOTE);
    expect(w.studio.seen.at(-1)).toMatchObject({ method: "POST", path: `/api/items/${id}/withdraw`, body: { note: "retracted", expectedRevision: 2 } });
    const second = await firstPublish();
    second.w.answer = { note: " " };
    await tapStudioWithdraw(second.w, NOTE);
    expect(second.w.studio.seen.at(-1)?.body).toEqual({ expectedRevision: 2 });
  });

  it("cancelling changes nothing, in the Studio or in the note", async () => {
    const { w, id } = await firstPublish();
    const text = w.local.get(NOTE);
    const writes = w.studio.writes().length;
    w.answer = false;
    expect(await tapStudioWithdraw(w, NOTE)).toMatchObject({ status: "cancelled", notices: [M.studioWithdrawCancelled] });
    expect(w.studio.writes()).toHaveLength(writes);
    expect(w.studio.items.get(id)?.status).toBe("public");
    expect(w.local.get(NOTE)).toBe(text);
  });

  it("is a no-op for an item that is withdrawn already; it only repairs a note that does not say so", async () => {
    const { w, id } = await firstPublish();
    await tapStudioWithdraw(w, NOTE);
    const writes = w.studio.writes().length;
    expect(await tapStudioWithdraw(w, NOTE)).toMatchObject({ status: "noop", notices: [M.alreadyWithdrawn] });
    expect(w.studio.writes()).toHaveLength(writes);
    // withdrawn in the Studio's own editor; the note was never told
    const other = await firstPublish();
    const item = other.w.studio.items.get(other.id);
    if (item) {
      item.status = "withdrawn";
      item.version = 2;
    }
    expect(await tapStudioWithdraw(other.w, NOTE)).toMatchObject({ status: "noop" });
    expect(fm(other.w, NOTE)).toMatchObject({ blyg_withdrawn: true, blyg_version: 2 });
    expect(id).toBe(idOf(1));
  });

  it("publishing again brings it back (spec §9), as the next version", async () => {
    const { w, id } = await firstPublish();
    await tapStudioWithdraw(w, NOTE);
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "published", id, version: 3 });
    expect(fm(w).blyg_withdrawn).toBeUndefined();
  });

  it("refuses what has nothing to withdraw, with no request that changes anything", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Draft.\n" } });
    expect(await tapStudioWithdraw(w, NOTE)).toMatchObject({ status: "refused", notices: [M.noIdToWithdraw] });
    const draft = w.studio.seed({ content_md: "Only a draft." });
    w.local.set(NOTE, `---\n${stamped(draft.id)}\n---\nOnly a draft.\n`);
    expect(await tapStudioWithdraw(w, NOTE)).toMatchObject({ status: "refused", notices: [M.studioNothingToWithdraw(draft.id)] });
    expect(w.studio.writes()).toEqual([]);
    w.local.set(NOTE, `---\nblyg_id: a0000000000000000000000001\n---\nOld.\n`);
    expect((await tapStudioWithdraw(w, NOTE)).notices).toEqual([M.studioOtherRecord("a0000000000000000000000001", null)]);
    w.local.set(NOTE, `---\n${stamped(idOf(99))}\n---\nGone.\n`);
    expect((await tapStudioWithdraw(w, NOTE)).notices).toEqual([M.studioItemMissing(idOf(99), "https://studio.test")]);
  });

  it("a failed withdrawal leaves the note alone and says what the Studio said", async () => {
    const { w, id } = await firstPublish();
    w.studio.forced.set(`POST /api/items/${id}/withdraw`, { status: 403, text: '{"error":"missing scope owner:publish"}' });
    const out = await tapStudioWithdraw(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/owner:publish/);
    expect(fm(w).blyg_withdrawn).toBeUndefined();
    w.studio.forced.set(`POST /api/items/${id}/withdraw`, new HttpError("Network error"));
    expect((await tapStudioWithdraw(w, NOTE)).status).toBe("failed");
  });

  it("if the note cannot be marked afterwards, says so; the withdrawal stands", async () => {
    const { w, id } = await firstPublish();
    w.failStamp = true;
    const out = await tapStudioWithdraw(w, NOTE);
    expect(out).toMatchObject({ status: "published", localStampFailed: true, notices: [M.studioWithdrawStampFailed(id, 2)] });
    expect(w.studio.items.get(id)?.status).toBe("withdrawn");
  });

  it("a thread is withdrawn the same way", async () => {
    const w = makeStudioWorld({ vault: { "studio/T.md": "---\nblyg_kind: thread\n---\nA thread.\n" } });
    const first = await tapStudio(w, "studio/T.md");
    expect(await tapStudioWithdraw(w, "studio/T.md")).toMatchObject({ status: "published", version: 2, notices: [M.studioWithdrawn(2, `${STUDIO_ORIGIN}t/${first.id}/`)] });
  });
});

describe("the other routes are untouched", () => {
  it("an essay still goes to GitHub and never to the Studio", async () => {
    const w = makeStudioWorld({ vault: { "website/essays/E.md": "---\ntitle: T\n---\nBody.\n" } });
    const out = await tapStudio(w, "website/essays/E.md");
    expect(out.status).toBe("committed");
    expect(w.studio.seen).toEqual([]);
  });
});

describe("test fake sanity", () => {
  it("the fake knows what the real Studio does with an unchanged item: a new version (why the plugin decides no-ops itself)", () => {
    const s = new FakeStudio();
    const item = s.seed({ content_md: "x" });
    const publish = (revision: number): Promise<unknown> => s.transport({ url: `https://studio.test/api/items/${item.id}/publish`, method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ expectedRevision: revision }) });
    void publish(1);
    void publish(2);
    expect(s.items.get(item.id)?.version).toBe(2);
  });
});

describe("reposting a note that carries another blyg's record", () => {
  const OLD = "a0000000000000000000000077";
  const oldNote = (extra = ""): string =>
    `---\nblyg_id: ${OLD}\nblyg_version: 3\nblyg_created: 2026-10-01T10:27:15.976Z\nblyg_updated: 2026-10-02T10:00:00.000Z\nblyg_hash: sha256:abc\n${extra}---\nWords from the old blyg.\n`;
  const world = (text = oldNote()): StudioWorld => {
    const w = makeStudioWorld({ vault: { [NOTE]: text } });
    w.settings.origin = "https://old.example/blyg/";
    return w;
  };
  const repost = (w: StudioWorld) => repostNote(w.deps, { path: NOTE, name: "Note.md", extension: "md" });

  it("publishes the text as a NEW item and only then moves the old record into blyg_previous", async () => {
    const w = world();
    const out = await repost(w);
    const id = idOf(1);
    expect(out).toMatchObject({ status: "published", id, version: 1, notices: [M.studioReposted(id, 1, `${STUDIO_ORIGIN}f/${id}/`, OLD)] });
    expect(w.studio.items.get(id)).toMatchObject({ status: "public", content_md: "Words from the old blyg." });
    expect(fm(w)).toEqual({
      blyg_origin: STUDIO_ORIGIN,
      blyg_id: id,
      blyg_version: 1,
      blyg_url: `${STUDIO_ORIGIN}f/${id}/`,
      blyg_sent: await contentHash("Words from the old blyg."),
      blyg_previous: { origin: "https://old.example/blyg/", id: OLD, version: 3, url: `https://old.example/blyg/f/${OLD}/` },
    });
  });

  it("says in the window that this is a new item and what happens to the old one", async () => {
    const w = world();
    await repost(w);
    const window = w.previews[0];
    expect(window).toMatchObject({ action: "create", studio: { repost: { id: OLD, origin: "https://old.example/blyg/", version: 3 } } });
    expect(window?.changes[0]).toMatch(/A NEW item with a new id and today's date.*a0000000000000000000000077, version 3 at https:\/\/old.example\/blyg\//);
    expect(window?.changes[1]).toMatch(/blyg_previous/);
  });

  it("a note that is withdrawn on the old blyg keeps that fact in blyg_previous and is not withdrawn in the Studio", async () => {
    const w = world(oldNote("blyg_withdrawn: true\n"));
    expect((await repost(w)).status).toBe("published");
    expect(fm(w).blyg_previous).toMatchObject({ id: OLD, withdrawn: true });
    expect(fm(w).blyg_withdrawn).toBeUndefined();
  });

  it("uses the old record's own origin when it has one (a note of another Studio), and its own url", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: `---\nblyg_origin: https://other.studio/\nblyg_id: ${OLD}\nblyg_version: 2\nblyg_url: https://other.studio/t/${OLD}/\nblyg_kind: thread\n---\nA thread.\n` } });
    expect((await repost(w)).status).toBe("published");
    expect(fm(w)).toMatchObject({ blyg_kind: "thread", blyg_previous: { origin: "https://other.studio/", id: OLD, version: 2, url: `https://other.studio/t/${OLD}/` } });
  });

  it("cancelling leaves the Studio and the note exactly as they were", async () => {
    const w = world();
    const text = w.local.get(NOTE);
    w.answer = false;
    expect((await repost(w)).status).toBe("cancelled");
    expect(w.studio.items.size).toBe(0);
    expect(w.local.get(NOTE)).toBe(text);
  });

  it("refuses what is not a repost: a note of this Studio, a note with no record, a path outside a Studio folder", async () => {
    const { w, id } = await firstPublish();
    expect(await repost(w)).toMatchObject({ status: "refused", notices: [M.studioRepostNotNeeded(id)] });
    const fresh = makeStudioWorld({ vault: { [NOTE]: "Plain.\n", "website/essays/E.md": "---\ntitle: T\n---\nx\n" } });
    expect(await repost(fresh)).toMatchObject({ status: "refused", notices: [M.studioRepostNothing] });
    expect(await repostNote(fresh.deps, { path: "website/essays/E.md", name: "E.md", extension: "md" })).toMatchObject({ status: "refused", notices: [M.studioRepostNotStudio("website/essays/E.md")] });
    expect(fresh.studio.seen).toEqual([]);
  });

  it("an ordinary Publish still refuses such a note and points at Repost", async () => {
    const w = world();
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/Repost to Studio button/);
  });

  it("if the note cannot be marked afterwards, the old record stays and the retry finds the new item instead of making a second", async () => {
    const w = world();
    w.failStamp = true;
    const first = await repost(w);
    expect(first).toMatchObject({ status: "published", localStampFailed: true });
    expect(fm(w).blyg_id).toBe(OLD);
    w.failStamp = false;
    const again = await repost(w);
    expect(again).toMatchObject({ status: "noop", id: idOf(1) });
    expect(w.studio.items.size).toBe(1);
    expect(fm(w)).toMatchObject({ blyg_id: idOf(1), blyg_previous: { id: OLD, version: 3 } });
    expect(fm(w).blyg_hash).toBeUndefined();
  });

  it("a thread is reposted after the notes it quotes: their NEW ids are used, and an unreposted quote is refused with the way forward", async () => {
    const FRAG = "studio/Frag.md";
    const w = makeStudioWorld({
      vault: {
        [FRAG]: `---\nblyg_id: ${OLD}\nblyg_version: 1\n---\nQuoted words.\n`,
        [NOTE]: `---\nblyg_id: a0000000000000000000000078\nblyg_version: 4\nblyg_kind: thread\n---\n![[Frag]]\n\nMy answer.\n`,
      },
    });
    const early = await repost(w);
    expect(early.status).toBe("refused");
    expect(early.notices[0]).toMatch(/“Frag” was published to your site's old blyg.*Repost to Studio/);
    const frag = await repostNote(w.deps, { path: FRAG, name: "Frag.md", extension: "md" });
    expect(frag.status).toBe("published");
    const thread = await repost(w);
    expect(thread).toMatchObject({ status: "published", version: 1 });
    expect(w.studio.items.get(thread.id ?? "")?.content_md).toBe(`![[${frag.id}]]\n\nMy answer.`);
    expect(fm(w)).toMatchObject({ blyg_kind: "thread", blyg_previous: { id: "a0000000000000000000000078", version: 4 } });
  });

  describe("the provenance note on the first version (S2.5)", () => {
    it("the window offers the note, pre-filled with where the item came from and when it was first published", async () => {
      const w = world();
      await repost(w);
      expect(w.previews[0]?.studio).toMatchObject({ askNote: true, noteDefault: "Reposted from old.example/blyg/ — first published 2026-10-01" });
    });

    it("what the user leaves in the field travels as the version's changelog line; an emptied field sends none", async () => {
      const kept = world();
      kept.answer = { note: "Reposted from old.example/blyg/ — first published 2026-10-01" };
      const out = await repost(kept);
      expect(kept.studio.latest(out.id ?? "")?.note).toBe("Reposted from old.example/blyg/ — first published 2026-10-01");
      const emptied = world();
      emptied.answer = { note: "  " };
      const second = await repost(emptied);
      expect(emptied.studio.latest(second.id ?? "")?.note).toBeNull();
    });

    it("an ordinary first publish still offers no note and ignores one", async () => {
      const w = makeStudioWorld({ vault: { [NOTE]: "Plain.\n" } });
      w.answer = { note: "should not be sent" };
      const out = await tapStudio(w, NOTE);
      expect(w.previews[0]?.studio).toMatchObject({ askNote: false });
      expect(w.previews[0]?.studio?.noteDefault).toBeUndefined();
      expect(w.studio.latest(out.id ?? "")?.note).toBeNull();
    });

    it("says what it can: no date on the old record, no old address, a date that arrives as text", () => {
      expect(repostNoteText("https://example.org/blyg/", "2026-10-17T20:44:25.464Z")).toBe("Reposted from example.org/blyg/ — first published 2026-10-17");
      expect(repostNoteText("https://example.org/blyg/", new Date("2026-10-19T20:38:02.792Z"))).toBe("Reposted from example.org/blyg/ — first published 2026-10-19");
      expect(repostNoteText("http://old.example/", undefined)).toBe("Reposted from old.example/");
      expect(repostNoteText(null, "not a date")).toBe("Reposted from the old blyg");
      expect(repostNoteText(null, "2026-10-01")).toBe("Reposted from the old blyg — first published 2026-10-01");
    });
  });
});
