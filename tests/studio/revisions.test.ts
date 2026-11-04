// Contract 5 revisions in the write flows (docs/plans/S16-contract-5.md §3.3): the revision read travels into every command, which closes
// the window between "read the Studio's copy" and "write"; a stale one is retried once only when the text is still the text that was
// compared, and otherwise stops without overwriting anything. Plus the contract gate in front of every write.
import { describe, expect, it } from "vitest";
import { M } from "../../src/publish/messages";
import { frontmatterOf } from "../world";
import { STUDIO_ORIGIN } from "./fake-studio";
import { makeStudioWorld, tapStudio, tapStudioDeleteDraft, tapStudioWithdraw, type StudioWorld } from "./world";

const NOTE = "studio/Note.md";
const DRAFT = "drafts/Note.md";
const fm = (w: StudioWorld, path = NOTE): Record<string, unknown> => frontmatterOf(w.local.get(path) ?? "");

async function published(body = "Hello world.\n"): Promise<{ w: StudioWorld; id: string }> {
  const w = makeStudioWorld({ vault: { [NOTE]: body } });
  const out = await tapStudio(w, NOTE);
  expect(out.status).toBe("published");
  return { w, id: out.id ?? "" };
}
const edit = (w: StudioWorld, text: string): void => void w.local.set(NOTE, `${w.local.get(NOTE)?.split("---\n").slice(0, 2).join("---\n")}---\n${text}\n`);
const writes = (w: StudioWorld): string[] => w.studio.seen.filter((s) => s.method !== "GET" && s.path !== "/api/preview").map((s) => `${s.method} ${s.path} ${s.status}`);

describe("the revision read travels into every write", () => {
  it("a new item: create, then publish with the revision create answered", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" } });
    await tapStudio(w, NOTE);
    expect(w.studio.writes().map((s) => s.body)).toEqual([{ mode: "blank", kind: "fragment", contentMd: "Hello." }, { expectedRevision: 1 }]);
  });

  it("an edit: the PATCH names the revision that was read, the publish the one the PATCH answered", async () => {
    const { w, id } = await published();
    const before = w.studio.items.get(id)?.revision ?? 0;
    edit(w, "Hello again.");
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    expect(w.studio.writes().slice(-2).map((s) => s.body)).toEqual([{ contentMd: "Hello again.", expectedRevision: before }, { expectedRevision: before + 1 }]);
  });

  it("an unchanged text publishes nothing, so no command is sent at all", async () => {
    const { w } = await published();
    const count = w.studio.writes().length;
    expect((await tapStudio(w, NOTE)).status).toBe("noop");
    expect(w.studio.writes()).toHaveLength(count);
  });
});

describe("the Studio changes between our read and our write", () => {
  it("the TEXT changed in the Studio's editor: nothing is overwritten, nothing is published, the note is untouched", async () => {
    const { w, id } = await published();
    edit(w, "Mine, edited.");
    const noteBefore = w.local.get(NOTE);
    w.studio.onNext("PATCH", new RegExp(`/api/items/${id}$`), () => w.studio.editThere(id, "Theirs, typed meanwhile."));
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "failed", notices: [M.studioChangedWhilePublishing(id)] });
    expect(w.studio.items.get(id)).toMatchObject({ content_md: "Theirs, typed meanwhile.", version: 1 });
    expect(w.local.get(NOTE)).toBe(noteBefore);
    expect(writes(w).filter((l) => l.includes("200"))).toHaveLength(1); // only the first publish ever succeeded
  });

  it("only unrelated state moved (same text): the PATCH is repeated once with the new revision, then it publishes", async () => {
    const { w, id } = await published();
    edit(w, "Mine, edited.");
    w.studio.onNext("PATCH", new RegExp(`/api/items/${id}$`), () => w.studio.touch(id));
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(out.version).toBe(2);
    expect(writes(w).slice(-3)).toEqual([`PATCH /api/items/${id} 409`, `PATCH /api/items/${id} 200`, `POST /api/items/${id}/publish 200`]);
    expect(fm(w)).toMatchObject({ blyg_version: 2 });
  });

  it("the text changed between our PATCH and our publish: stops, says so, and the Studio keeps what was typed there", async () => {
    const { w, id } = await published();
    edit(w, "Mine, edited.");
    w.studio.onNext("POST", new RegExp(`/api/items/${id}/publish$`), () => w.studio.editThere(id, "Theirs, typed meanwhile."));
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "failed", notices: [M.studioChangedWhilePublishing(id)] });
    expect(w.studio.items.get(id)).toMatchObject({ content_md: "Theirs, typed meanwhile.", version: 1 });
    expect(fm(w)).toMatchObject({ blyg_version: 1 }); // the note was not re-stamped
  });

  it("only unrelated state moved between PATCH and publish: the publish is repeated once with the new revision", async () => {
    const { w, id } = await published();
    edit(w, "Mine, edited.");
    w.studio.onNext("POST", new RegExp(`/api/items/${id}/publish$`), () => w.studio.touch(id));
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    expect(writes(w).slice(-3)).toEqual([`PATCH /api/items/${id} 200`, `POST /api/items/${id}/publish 409`, `POST /api/items/${id}/publish 200`]);
  });

  it("a second conflict in a row is not retried again", async () => {
    const { w, id } = await published();
    edit(w, "Mine, edited.");
    const bump = (): void => w.studio.touch(id);
    w.studio.onNext("POST", new RegExp(`/api/items/${id}/publish$`), bump);
    // the retry's own GET happens inside the same hook window: move the revision again just before the retried publish
    w.studio.onNext("GET", new RegExp(`/api/items/${id}$`), () => undefined);
    w.studio.onNext("POST", new RegExp(`/api/items/${id}/publish$`), bump);
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toBe(M.studioChangedWhilePublishing(id));
  });

  it("a drafts-only send uses the revision too", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Draft one.\n" } });
    expect((await tapStudio(w, DRAFT)).status).toBe("published");
    const id = [...w.studio.items.keys()][0] ?? "";
    w.local.set(DRAFT, `${w.local.get(DRAFT)?.split("---\n").slice(0, 2).join("---\n")}---\nDraft two.\n`);
    w.studio.onNext("PATCH", new RegExp(`/api/items/${id}$`), () => w.studio.touch(id));
    expect((await tapStudio(w, DRAFT)).status).toBe("published");
    expect(w.studio.items.get(id)).toMatchObject({ content_md: "Draft two.", version: 0 });
  });
});

describe("withdraw and delete draft", () => {
  it("withdraw: a moved revision with the same text is repeated once", async () => {
    const { w, id } = await published();
    w.studio.onNext("POST", new RegExp(`/api/items/${id}/withdraw$`), () => w.studio.touch(id));
    expect((await tapStudioWithdraw(w, NOTE)).status).toBe("published");
    expect(w.studio.items.get(id)?.status).toBe("withdrawn");
    expect(writes(w).slice(-2)).toEqual([`POST /api/items/${id}/withdraw 409`, `POST /api/items/${id}/withdraw 200`]);
  });

  it("withdraw: text typed in the Studio meanwhile stops it, the item stays public", async () => {
    const { w, id } = await published();
    w.studio.onNext("POST", new RegExp(`/api/items/${id}/withdraw$`), () => w.studio.editThere(id, "Changed there."));
    const out = await tapStudioWithdraw(w, NOTE);
    expect(out).toMatchObject({ status: "failed", notices: [M.studioChangedWhilePublishing(id)] });
    expect(w.studio.items.get(id)?.status).toBe("public");
    expect(fm(w).blyg_withdrawn).toBeUndefined();
  });

  it("delete draft: sends the revision in a JSON body, and repeats once when only unrelated state moved", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Draft.\n" } });
    await tapStudio(w, DRAFT);
    const id = [...w.studio.items.keys()][0] ?? "";
    w.studio.onNext("DELETE", new RegExp(`/api/items/${id}$`), () => w.studio.touch(id));
    const out = await tapStudioDeleteDraft(w, DRAFT);
    expect(out.status).toBe("published");
    expect(w.studio.items.has(id)).toBe(false);
    const deletes = w.studio.seen.filter((s) => s.method === "DELETE");
    expect(deletes.map((s) => [s.status, s.body])).toEqual([[409, { expectedRevision: 1 }], [200, { expectedRevision: 2 }]]);
  });
});

describe("the gate in front of every write", () => {
  it("a Studio of an older contract: nothing is written, the note is untouched, the message says what to update", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" }, coldGate: true });
    w.studio.contractVersion = "4.0.0";
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/older API\. Update the Studio \(it needs 0\.51\.0 or later\)/);
    expect(w.studio.seen.map((s) => s.path)).toEqual(["/api/capabilities"]);
    expect(w.local.get(NOTE)).toBe("Hello.\n");
    expect(w.pendingMap.size).toBe(0);
  });

  it("withdraw and delete draft are refused the same way", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: `---\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_id: a0000000000000000000000001\nblyg_version: 1\n---\nx\n` }, coldGate: true });
    w.studio.contractVersion = null;
    expect((await tapStudioWithdraw(w, NOTE)).notices[0]).toMatch(/older API/);
    expect((await tapStudioDeleteDraft(w, NOTE)).notices[0]).toMatch(/older API/);
    expect(w.studio.writes()).toEqual([]);
  });

  it("a Studio announcing contract 5.9 is used", async () => {
    const w = makeStudioWorld({ vault: { [NOTE]: "Hello.\n" }, coldGate: true });
    w.studio.contractVersion = "5.9.0";
    expect((await tapStudio(w, NOTE)).status).toBe("published");
  });
});
