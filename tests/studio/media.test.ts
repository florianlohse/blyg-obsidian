import { describe, expect, it } from "vitest";
import { buildMultipart, safeFileName } from "../../src/studio/multipart";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { idleTimers } from "../helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./fake-studio";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 255, 254, 13, 10, 13, 10, 45, 45]).buffer; // includes bytes that look like CRLFs and dashes

function setup() {
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return { studio, client };
}

describe("multipart body", () => {
  it("is well formed and carries the bytes untouched", () => {
    const { body, contentType } = buildMultipart("XB", { itemId: "a", alt: "é" }, { field: "file", name: 'a "b".png', mime: "image/png", bytes: PNG });
    expect(contentType).toBe("multipart/form-data; boundary=XB");
    const text = Buffer.from(body).toString("latin1");
    expect(text.startsWith('--XB\r\nContent-Disposition: form-data; name="itemId"\r\n\r\na\r\n--XB\r\n')).toBe(true);
    expect(text).toContain('filename="a__b_.png"');
    expect(text.endsWith("\r\n--XB--\r\n")).toBe(true);
    expect(Buffer.from(body).includes(Buffer.from(PNG))).toBe(true);
  });
  it("makes file names safe", () => expect(safeFileName("my photo/é.png")).toBe("my_photo__.png"));
});

describe("studio client: uploadMedia", () => {
  it("attaches an image to the item, bumps the revision, and answers the address that holds the file's digest", async () => {
    const { client, studio } = setup();
    const made = await client.createItem({ kind: "fragment", contentMd: "x" });
    if (made.kind !== "ok") throw new Error("create");
    const res = await client.uploadMedia({ itemId: made.value.id, expectedRevision: made.value.revision, bytes: PNG, name: "door.png", mime: "image/png", alt: "a red door" });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value).toMatchObject({ mime: "image/png", duplicate: false, revision: made.value.revision + 1 });
    expect(res.value.url).toMatch(new RegExp(`^${STUDIO_HOST}/media/[0-9a-z]+/[0-9a-f]{64}\\.png$`));
    expect(studio.uploads).toEqual([expect.objectContaining({ itemId: made.value.id, alt: "a red door", inline: "true", size: PNG.byteLength, duplicate: false })]);
    // The bytes arrived intact: the digest in the address is the digest of the file.
    const { createHash } = await import("node:crypto");
    expect(res.value.url).toContain(createHash("sha256").update(Buffer.from(PNG)).digest("hex"));
    // The Studio's item lists it as attached.
    const got = await client.getItem(made.value.id);
    expect(got.kind === "ok" ? got.value.revision : 0).toBe(res.value.revision);
  });

  it("answers a duplicate without moving the revision", async () => {
    const { client } = setup();
    const made = await client.createItem({ kind: "fragment", contentMd: "x" });
    if (made.kind !== "ok") throw new Error("create");
    const first = await client.uploadMedia({ itemId: made.value.id, expectedRevision: 1, bytes: PNG, name: "a.png", mime: "image/png", alt: "" });
    const again = await client.uploadMedia({ itemId: made.value.id, expectedRevision: first.kind === "ok" ? (first.value.revision ?? 0) : 0, bytes: PNG, name: "a.png", mime: "image/png", alt: "" });
    expect(again).toMatchObject({ kind: "ok", value: { duplicate: true, revision: 2 } });
  });

  it("reports a stale revision as a conflict, and the Studio's refusals as rejections", async () => {
    const { client } = setup();
    const made = await client.createItem({ kind: "fragment", contentMd: "x" });
    if (made.kind !== "ok") throw new Error("create");
    expect(await client.uploadMedia({ itemId: made.value.id, expectedRevision: 9, bytes: PNG, name: "a.png", mime: "image/png", alt: "" })).toMatchObject({ kind: "conflict" });
    expect(await client.uploadMedia({ itemId: made.value.id, expectedRevision: 1, bytes: PNG, name: "a.txt", mime: "text/plain", alt: "" })).toMatchObject({ kind: "rejected", status: 415 });
    expect(await client.uploadMedia({ itemId: made.value.id, expectedRevision: 1, bytes: new ArrayBuffer(5 * 1024 * 1024 + 1), name: "big.png", mime: "image/png", alt: "" })).toMatchObject({ kind: "rejected", status: 413 });
  });

  it("never puts the token in the body or the address", async () => {
    const { client, studio } = setup();
    const made = await client.createItem({ kind: "fragment", contentMd: "x" });
    if (made.kind !== "ok") throw new Error("create");
    await client.uploadMedia({ itemId: made.value.id, expectedRevision: 1, bytes: PNG, name: "a.png", mime: "image/png", alt: "" });
    expect(studio.seen.filter((s) => s.path.startsWith("/api/media")).every((s) => !s.path.includes(STUDIO_TOKEN) && !JSON.stringify(s.body).includes(STUDIO_TOKEN))).toBe(true);
  });
});
