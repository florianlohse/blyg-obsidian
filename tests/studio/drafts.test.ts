// "Drafts only" Studio routes (roadmap S12): a note is sent to the Studio as a draft and never published, repost or withdrawn from that folder;
// a draft that was never published can be deleted. Nothing here may reach `/publish` or `/withdraw` from a drafts-only route.
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/core/hash";
import { M } from "../../src/publish/messages";
import { frontmatterOf } from "../world";
import { STUDIO_ORIGIN, idOf } from "./fake-studio";
import { makeStudioWorld, tapStudio, tapStudioDeleteDraft, tapStudioRepost, tapStudioWithdraw, type StudioWorld } from "./world";

const DRAFT = "drafts/Note.md";
const NORMAL = "studio/Note.md";
const fm = (w: StudioWorld, path: string): Record<string, unknown> => frontmatterOf(w.local.get(path) ?? "");
const bodyOf = (w: StudioWorld, path: string): string => (w.local.get(path) ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
const goneLive = (w: StudioWorld): boolean => w.studio.seen.some((s) => /\/(publish|withdraw)$/.test(s.path));

describe("sending a draft", () => {
  it("creates a draft in the Studio, publishes nothing, and stamps the note with version 0 and no web address", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "A thought for later.\n" } });
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("published");
    const id = out.id ?? "";
    expect(out.notices[0]).toBe(M.studioDraftSent(id));
    expect(goneLive(w)).toBe(false);
    expect(w.studio.items.get(id)).toMatchObject({ status: "draft", version: 0, content_md: "A thought for later." });
    expect(w.previews[0]).toMatchObject({ action: "draft", before: null, after: "A thought for later." });
    expect(w.previews[0]?.changes[0]).toMatch(/Nothing goes live/);
    const props = fm(w, DRAFT);
    expect(props).toMatchObject({ blyg_id: id, blyg_origin: STUDIO_ORIGIN, blyg_version: 0, blyg_sent: await contentHash("A thought for later.") });
    expect(props).not.toHaveProperty("blyg_url");
    expect(w.pendingMap.size).toBe(0);
  });

  it("an unchanged note has nothing to send; a changed note updates the same draft, still unpublished", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "First words.\n" } });
    const id = (await tapStudio(w, DRAFT)).id ?? "";
    const writes = w.studio.writes().length;
    expect(await tapStudio(w, DRAFT)).toMatchObject({ status: "noop", notices: [M.studioDraftNoChanges] });
    expect(w.studio.writes()).toHaveLength(writes);
    w.local.set(DRAFT, (w.local.get(DRAFT) ?? "").replace("First words.", "Second words."));
    expect((await tapStudio(w, DRAFT)).status).toBe("published");
    expect(w.studio.items.size).toBe(1);
    expect(w.studio.items.get(id)).toMatchObject({ status: "draft", version: 0, content_md: "Second words." });
    expect(goneLive(w)).toBe(false);
  });

  it("cancelling creates nothing and leaves the note as it was", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Not yet.\n" } });
    w.answerFor = () => false;
    const before = w.local.get(DRAFT);
    expect((await tapStudio(w, DRAFT)).status).toBe("cancelled");
    expect(w.studio.items.size).toBe(0);
    expect(w.local.get(DRAFT)).toBe(before);
  });

  it("another device continues the same draft from the note's stamp (no second item)", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Shared draft.\n" } });
    const id = (await tapStudio(w, DRAFT)).id ?? "";
    w.pendingMap.clear(); // the second device has no memory of its own
    w.local.set(DRAFT, (w.local.get(DRAFT) ?? "").replace("Shared draft.", "Shared draft, edited."));
    expect((await tapStudio(w, DRAFT)).id).toBe(id);
    expect(w.studio.items.size).toBe(1);
  });
});

describe("going live from a draft", () => {
  it("moved to a normal Studio folder, Publish makes the same item version 1, with its web address", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Ready now.\n" } });
    const id = (await tapStudio(w, DRAFT)).id ?? "";
    w.local.set(NORMAL, w.local.get(DRAFT) ?? "");
    const out = await tapStudio(w, NORMAL);
    expect(out).toMatchObject({ status: "published", id, version: 1 });
    expect(w.studio.items.size).toBe(1);
    expect(w.studio.items.get(id)).toMatchObject({ status: "public", version: 1 });
    expect(fm(w, NORMAL)).toMatchObject({ blyg_version: 1 });
    expect(fm(w, NORMAL).blyg_url).toBeTypeOf("string");
  });
});

describe("a published note in a drafts-only folder", () => {
  async function movedPublished(): Promise<{ w: StudioWorld; id: string }> {
    const w = makeStudioWorld({ vault: { [NORMAL]: "Live words.\n" } });
    const id = (await tapStudio(w, NORMAL)).id ?? "";
    w.local.set(DRAFT, w.local.get(NORMAL) ?? "");
    return { w, id };
  }

  it("an edit goes to the working copy only: the published version stays, nothing is published", async () => {
    const { w, id } = await movedPublished();
    const publishes = w.studio.seen.filter((s) => s.path.endsWith("/publish")).length;
    w.local.set(DRAFT, (w.local.get(DRAFT) ?? "").replace("Live words.", "Edited words."));
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("published");
    expect(out.notices[0]).toBe(M.studioDraftUpdated(id, 1));
    expect(w.studio.seen.filter((s) => s.path.endsWith("/publish"))).toHaveLength(publishes);
    expect(w.studio.items.get(id)).toMatchObject({ status: "public", version: 1, content_md: "Edited words." });
    expect(w.studio.latest(id)?.content_md).toBe("Live words.");
    expect(w.previews.at(-1)?.changes.join(" ")).toMatch(/published version 1 stays/);
    expect(fm(w, DRAFT).blyg_version).toBe(1);
  });

  it("withdraw and repost are refused before any request", async () => {
    const { w } = await movedPublished();
    const seen = w.studio.seen.length;
    expect(await tapStudioWithdraw(w, DRAFT)).toMatchObject({ status: "refused", notices: [M.studioDraftsOnlyNoWithdraw] });
    expect(await tapStudioRepost(w, DRAFT)).toMatchObject({ status: "refused", notices: [M.studioDraftsOnlyNoRepost] });
    expect(w.studio.seen).toHaveLength(seen);
  });

  it("a withdrawn item is not brought back from here", async () => {
    const { w, id } = await movedPublished();
    await tapStudioWithdraw(w, NORMAL);
    w.local.set(DRAFT, `${(w.local.get(DRAFT) ?? "").replace("Live words.", "Other words.")}`);
    const out = await tapStudio(w, DRAFT);
    expect(out).toMatchObject({ status: "refused", notices: [M.studioDraftsOnlyWithdrawn(id)] });
    expect(w.studio.items.get(id)?.status).toBe("withdrawn");
  });
});

describe("deleting a draft", () => {
  it("deletes it in the Studio after asking, removes the note's record, and keeps the note's text", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Throw away.\n" } });
    const id = (await tapStudio(w, DRAFT)).id ?? "";
    const out = await tapStudioDeleteDraft(w, DRAFT);
    expect(out).toMatchObject({ status: "published", notices: [M.studioDraftDeleted(id)] });
    expect(w.previews.at(-1)).toMatchObject({ action: "delete-draft", id, before: "Throw away." });
    expect(w.studio.items.has(id)).toBe(false);
    const props = fm(w, DRAFT);
    for (const key of ["blyg_id", "blyg_origin", "blyg_version", "blyg_sent", "blyg_url"]) expect(props, key).not.toHaveProperty(key);
    expect(bodyOf(w, DRAFT)).toBe("Throw away.\n");
    // the note can be sent again as a brand new draft
    expect((await tapStudio(w, DRAFT)).id).not.toBe(id);
  });

  it("cancelling deletes nothing", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Keep me.\n" } });
    const id = (await tapStudio(w, DRAFT)).id ?? "";
    w.answerFor = () => false;
    expect((await tapStudioDeleteDraft(w, DRAFT)).status).toBe("cancelled");
    expect(w.studio.items.has(id)).toBe(true);
    expect(fm(w, DRAFT).blyg_id).toBe(id);
  });

  it("a published item is refused before any delete request: it can only be withdrawn", async () => {
    const w = makeStudioWorld({ vault: { [NORMAL]: "Published.\n" } });
    const id = (await tapStudio(w, NORMAL)).id ?? "";
    expect(await tapStudioDeleteDraft(w, NORMAL)).toMatchObject({ status: "refused", notices: [M.studioDraftPublished(id)] });
    expect(w.studio.seen.some((s) => s.method === "DELETE")).toBe(false);
    expect(w.studio.items.get(id)?.status).toBe("public");
  });

  it("a note with no draft, a note outside Studio folders, and another Studio's record are refused", async () => {
    const w = makeStudioWorld({
      vault: { [DRAFT]: "Nothing here.\n", "website/essays/E.md": "---\ntitle: T\n---\nText.\n", "drafts/Old.md": `---\nblyg_id: 7c9wk2n4h6q1x8v0z3m5rjy2ke\nblyg_origin: https://elsewhere.test/\n---\nOld.\n` },
    });
    expect(await tapStudioDeleteDraft(w, DRAFT)).toMatchObject({ status: "refused", notices: [M.studioNoDraftToDelete] });
    expect((await tapStudioDeleteDraft(w, "website/essays/E.md")).notices[0]).toBe(M.studioDraftNotStudio("website/essays/E.md"));
    expect((await tapStudioDeleteDraft(w, "drafts/Old.md")).status).toBe("refused");
    expect(w.studio.seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("finds a draft the plugin made for a note that was never stamped (the pending record)", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: "Half way.\n" } });
    const item = w.studio.seed({ content_md: "Half way." });
    w.pendingMap.set(DRAFT, { origin: STUDIO_ORIGIN, id: item.id, kind: "fragment", at: "2026-10-26T10:00:00Z" });
    expect((await tapStudioDeleteDraft(w, DRAFT)).status).toBe("published");
    expect(w.studio.items.has(item.id)).toBe(false);
    expect(w.pendingMap.size).toBe(0);
  });

  it("an item the Studio no longer has is reported, not guessed at", async () => {
    const w = makeStudioWorld({ vault: { [DRAFT]: `---\nblyg_id: ${idOf(77)}\nblyg_origin: ${STUDIO_ORIGIN}\nblyg_version: 0\n---\nGone.\n` } });
    expect((await tapStudioDeleteDraft(w, DRAFT)).status).toBe("refused");
  });
});
