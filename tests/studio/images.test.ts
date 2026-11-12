// Images in a Studio publish (roadmap S6): what is found, what is refused before any request, the order on the wire, and the rule that a
// note and the Studio's copy of it stay comparable (so "nothing to send" and "edited in the Studio" keep meaning what they meant).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { localStudioHash } from "../../src/studio/media";
import { loadPanelState } from "../../src/app/panelState";
import { defaultSettings } from "../../src/settings/schema";
import { M } from "../../src/publish/messages";
import { has } from "../world";
import { STUDIO_HOST } from "./fake-studio";
import { makeStudioWorld, tapStudio, type StudioWorld } from "./world";

const NOTE = "studio/Note.md";
const DRAFT = "drafts/Note.md";
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const PNG2 = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);
const digest = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const urlOf = (b: Uint8Array, id: string): string => `${STUDIO_HOST}/media/${id}/${digest(b)}.png`;
const writes = (w: StudioWorld): string[] => w.studio.writes().map((s) => `${s.method} ${s.path.replace(/[0-9a-z]{26}/, "<id>")}`);

/** `files` are named relative to the note's route folder (where an image has to be); `outside` are vault paths as given. */
function world(body: string, files: Record<string, Uint8Array> = { "photos/door.png": PNG }, path = NOTE, outside: Record<string, Uint8Array> = {}): StudioWorld {
  const w = makeStudioWorld({ vault: { [path]: body } });
  const folder = path.slice(0, path.indexOf("/") + 1);
  for (const [p, bytes] of Object.entries(files)) w.addImage(`${folder}${p}`, bytes);
  for (const [p, bytes] of Object.entries(outside)) w.addImage(p, bytes);
  return w;
}

describe("publishing a note with an image", () => {
  it("uploads the file to the item, then sends the text with the address the Studio gave it", async () => {
    const w = world("A red door.\n\n![[door.png|a red door]]\n");
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    // create (with the picture still in its canonical form), upload, text with the address, publish
    expect(writes(w)).toEqual(["POST /api/items", "POST /api/media", "PATCH /api/items/<id>", "POST /api/items/<id>/publish"]);
    const item = [...w.studio.items.values()][0];
    expect(w.studio.uploads).toEqual([expect.objectContaining({ itemId: item?.id, alt: "a red door", inline: "true", mime: "image/png", size: PNG.length, duplicate: false })]);
    expect(item?.content_md).toMatch(new RegExp(`^A red door\\.\\n\\n!\\[a red door\\]\\(${STUDIO_HOST}/media/[0-9a-z]+/${digest(PNG)}\\.png\\)$`));
    // the published version retains the picture
    expect(item?.versions.at(-1)?.media).toHaveLength(1);
  });

  it("shows what will be uploaded in the window, with the picture in its canonical form on both sides", async () => {
    const w = world("![[door.png]]\n");
    await tapStudio(w, NOTE);
    expect(w.previews[0]?.changes.some((c) => /1 image uploaded with this version: door\.png \(1 KB\)/.test(c))).toBe(true);
    expect(w.previews[0]?.after).toBe(`![](blyg-media:${digest(PNG)})`);
  });

  it("asks the Studio for a preview with stand-in addresses and writes nothing until the user confirms", async () => {
    const w = world("![[door.png|x]]\n");
    w.answer = false;
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("cancelled");
    expect(w.studio.writes()).toEqual([]);
    expect(w.studio.uploads).toEqual([]);
    const preview = w.studio.seen.find((s) => s.path === "/api/preview");
    expect(JSON.stringify(preview?.body)).toContain(`${STUDIO_HOST}/media/pending/${digest(PNG)}.png`);
  });

  it("uploads one file once however often the note embeds it, and keeps each use's own description", async () => {
    const w = world("![[door.png|front]]\n\ntext\n\n![the door again](studio/photos/door.png)\n");
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    expect(w.studio.uploads).toHaveLength(1);
    const md = [...w.studio.items.values()][0]?.content_md ?? "";
    expect(md).toContain("![front](");
    expect(md).toContain("![the door again](");
  });

  it("says 'no changes' the second time, and asks the Studio nothing to write", async () => {
    const w = world("![[door.png|a]]\n");
    const first = await tapStudio(w, NOTE);
    expect(first.status).toBe("published");
    const before = w.studio.writes().length;
    const again = await tapStudio(w, NOTE);
    expect(again.status).toBe("noop");
    expect(w.studio.writes().length).toBe(before);
  });

  it("does not take the Studio's own address of the same picture for an edit made there", async () => {
    const w = world("Words.\n\n![[door.png|a]]\n");
    const out = await tapStudio(w, NOTE);
    // The owner saves the item in the Studio's editor: the text is the same words and the same file, under another upload's address.
    w.studio.editThere(out.id ?? "", `Words.\n\n![a](${urlOf(PNG, "zzz")})`);
    const again = await tapStudio(w, NOTE);
    // No "changed in the Studio" window: the two texts are the same text. (The Studio's working copy differs from the published bytes, so it makes a version.)
    expect(w.previews.filter((p) => p.action === "studio-conflict")).toEqual([]);
    expect(again.status).toBe("published");
  });

  it("does take a real edit made in the Studio for one (the picture is not a way past the window)", async () => {
    const w = world("Words.\n\n![[door.png|a]]\n");
    const out = await tapStudio(w, NOTE);
    w.studio.editThere(out.id ?? "", `Other words.\n\n![a](${urlOf(PNG, "zzz")})`);
    w.answer = false;
    await tapStudio(w, NOTE);
    expect(w.previews.some((p) => p.action === "studio-conflict")).toBe(true);
  });

  it("a changed file is a new upload and a new version; the old picture stays with the item", async () => {
    const w = world("![[door.png|a]]\n");
    const first = await tapStudio(w, NOTE);
    w.addImage("studio/photos/door.png", PNG2);
    const second = await tapStudio(w, NOTE);
    expect(second).toMatchObject({ status: "published", version: 2 });
    const item = w.studio.items.get(first.id ?? "");
    expect(item?.media).toHaveLength(2);
    expect(item?.content_md).toContain(digest(PNG2));
  });

  it("an edit of the words only uploads nothing new (the Studio recognises the file it holds)", async () => {
    const w = world("One.\n\n![[door.png|a]]\n");
    await tapStudio(w, NOTE);
    w.local.set(NOTE, w.local.get(NOTE)?.replace("One.", "Two.") ?? "");
    const second = await tapStudio(w, NOTE);
    expect(second).toMatchObject({ status: "published", version: 2 });
    expect(w.studio.uploads.map((u) => u.duplicate)).toEqual([false, true]);
    expect([...w.studio.items.values()][0]?.media).toHaveLength(1);
  });

  it("works for a drafts-only route: the images are uploaded, nothing goes live", async () => {
    const w = world("![[door.png|a]]\n", { "photos/door.png": PNG }, DRAFT);
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("published");
    expect(writes(w)).toEqual(["POST /api/items", "POST /api/media", "PATCH /api/items/<id>"]);
    expect([...w.studio.items.values()][0]).toMatchObject({ status: "draft", version: 0 });
  });

  it("leaves a web image alone: no upload, the address is sent as written", async () => {
    const w = world("![x](https://example.com/a.png)\n", {});
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    expect(w.studio.uploads).toEqual([]);
    expect([...w.studio.items.values()][0]?.content_md).toBe("![x](https://example.com/a.png)");
  });

  it("stamps the note with the hash of the canonical text", async () => {
    const w = world("![[door.png|a]]\n");
    await tapStudio(w, NOTE);
    expect(w.local.get(NOTE)).toContain(await localStudioHash(`![a](blyg-media:${digest(PNG)})`));
  });
});

describe("only images inside the note's route folder are sent", () => {
  it("refuses an image elsewhere in the vault, naming the folder, and never reads it", async () => {
    const w = world("![[elsewhere.png]]\n", {}, NOTE, { "attachments/elsewhere.png": PNG });
    let reads = 0;
    const images = w.deps.images;
    if (!images) throw new Error("images");
    w.deps.images = { fileInfo: (p) => images.fileInfo(p), readBinary: (p) => (reads++, images.readBinary(p)) };
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(has(out.notices, /Line 1: “elsewhere\.png” is outside the folder this note is published from \(studio\/\)/)).toBe(true);
    expect(reads).toBe(0);
    expect(w.studio.seen).toEqual([]);
  });

  it("takes an image in a folder below the route folder", async () => {
    const w = world("![[deep.png|d]]\n", { "a/b/deep.png": PNG });
    expect((await tapStudio(w, NOTE)).status).toBe("published");
    expect(w.studio.uploads).toHaveLength(1);
  });

  it("goes by the note's own route: a draft note cannot send an image that lives in the other route's folder", async () => {
    const w = world("![[door.png]]\n", {}, DRAFT, { "studio/door.png": PNG });
    const out = await tapStudio(w, DRAFT);
    expect(out.status).toBe("refused");
    expect(has(out.notices, /outside the folder this note is published from \(drafts\/\)/)).toBe(true);
  });

  it("a folder whose name only starts the same is not inside it", async () => {
    const w = world("![[x.png]]\n", {}, NOTE, { "studio-extra/x.png": PNG });
    expect((await tapStudio(w, NOTE)).status).toBe("refused");
  });

  it("the panel says so before the user taps", async () => {
    const w = world("![[elsewhere.png]]\n", {}, NOTE, { "attachments/elsewhere.png": PNG });
    const base = defaultSettings();
    const state = await loadPanelState({ settings: { ...base, routes: w.settings.routes, studio: { ...base.studio, baseUrl: STUDIO_HOST } }, vault: w.deps.vault, ...(w.deps.images ? { images: w.deps.images } : {}) }, { path: NOTE, name: "Note.md", extension: "md" });
    expect(JSON.stringify(state)).toContain("is outside the folder this note is published from");
    expect(state.canPublish).toBe(false);
  });
});

describe("what is refused before any request", () => {
  it("an image that is not in the vault", async () => {
    const w = world("![[missing.png]]\n", {});
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(has(out.notices, /Line 1: the image “missing\.png” is not in the vault/)).toBe(true);
    expect(w.studio.seen).toEqual([]);
  });

  it("a kind the Studio does not take (HEIC), with the reason", async () => {
    const w = world("x\n\n![[IMG_1.HEIC]]\n", { "IMG_1.HEIC": PNG });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(has(out.notices, /Line 3: “IMG_1\.HEIC” is a \.heic file; the Studio takes png, jpg, gif, webp and svg/)).toBe(true);
    expect(w.studio.seen).toEqual([]);
  });

  it("a file over 5 MB", async () => {
    const w = world("![[big.png]]\n", { "big.png": new Uint8Array(5 * 1024 * 1024 + 1) });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(has(out.notices, /“big\.png” is 5\.0 MB; the Studio takes at most 5 MB/)).toBe(true);
    expect(w.studio.seen).toEqual([]);
  });

  it("every problem at once, naming the lines", async () => {
    const w = world("![[a.png]]\n\n![[b.bmp]]\n", { "b.bmp": PNG });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/Line 1:.*Line 3:/);
  });

  it("when the plugin cannot read files here", async () => {
    const w = world("![[door.png]]\n");
    delete w.deps.images;
    const out = await tapStudio(w, NOTE);
    expect(out).toMatchObject({ status: "refused", notices: [M.imagesProblems([M.imagesUnavailable])] });
  });

  it("an image in a code block is code, not an image", async () => {
    const w = world("```\n![[missing.png]]\n```\n", {});
    expect((await tapStudio(w, NOTE)).status).toBe("published");
  });
});

describe("when something goes wrong in the middle", () => {
  it("a failed upload stops before anything is published and says where the draft is", async () => {
    const w = world("![[door.png|a]]\n");
    w.studio.forced.set("POST /api/media", { status: 500, text: JSON.stringify({ code: "internal", message: "boom" }) });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(has(out.notices, /Stopped while uploading images: nothing was published/)).toBe(true);
    expect(writes(w)).toEqual(["POST /api/items", "POST /api/media"]);
    expect(w.local.get(NOTE)).not.toContain("blyg_id");
    // the draft is remembered, so the next tap continues with it instead of making a second item
    expect(w.pendingMap.size).toBe(1);
    const retry = await tapStudio(w, NOTE);
    expect(retry.status).toBe("published");
    expect(w.studio.items.size).toBe(1);
  });

  it("a rejection by the Studio (a file type its rules do not know) is reported, nothing published", async () => {
    const w = world("![[logo.svg]]\n", { "logo.svg": PNG });
    // svg is allowed by the Studio; make the fake refuse as a newer rule might
    w.studio.forced.set("POST /api/media", { status: 415, text: JSON.stringify({ code: "unsupported-media", message: "unsupported type" }) });
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(w.studio.items.size).toBe(1);
    expect([...w.studio.items.values()][0]?.status).toBe("draft");
  });

  it("a file that changed between the window and the upload is not sent", async () => {
    const w = world("![[door.png]]\n");
    const answer = w.answer;
    w.answerFor = (): boolean => {
      w.addImage("studio/photos/door.png", PNG2);
      return answer as boolean;
    };
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(has(out.notices, /changed while the note was being sent/)).toBe(true);
    expect(w.studio.uploads).toEqual([]);
  });

  it("a revision that moved in the Studio during the upload ends it as 'changed there'", async () => {
    const w = world("![[door.png]]\n");
    const first = await tapStudio(w, NOTE);
    w.addImage("studio/photos/door.png", PNG2);
    w.studio.onNext("POST", /\/api\/media$/, () => w.studio.touch(first.id ?? ""));
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("failed");
    expect(has(out.notices, new RegExp(M.studioChangedWhilePublishing(first.id ?? "").slice(0, 25)))).toBe(true);
  });
});

describe("the panel", () => {
  const settings = (w: StudioWorld) => {
    const base = defaultSettings();
    return { ...base, routes: w.settings.routes, studio: { ...base.studio, baseUrl: STUDIO_HOST } };
  };
  const env = (w: StudioWorld) => ({ settings: settings(w), vault: w.deps.vault, ...(w.deps.images ? { images: w.deps.images } : {}), imageDigests: new Map<string, string>() });

  it("says a note with a missing image has a problem, before the user taps", async () => {
    const w = world("![[missing.png]]\n", {});
    const state = await loadPanelState(env(w), { path: NOTE, name: "Note.md", extension: "md" });
    expect(JSON.stringify(state)).toContain("is not in the vault");
    expect(state.canPublish).toBe(false);
  });

  it("reads an unchanged image once, however often it redraws", async () => {
    const w = world("![[door.png]]\n");
    let reads = 0;
    const images = w.deps.images;
    if (!images) throw new Error("images");
    const counting = { ...env(w), images: { fileInfo: (p: string) => images.fileInfo(p), readBinary: (p: string) => (reads++, images.readBinary(p)) } };
    for (let i = 0; i < 3; i++) await loadPanelState(counting, { path: NOTE, name: "Note.md", extension: "md" });
    expect(reads).toBe(1);
  });
});
