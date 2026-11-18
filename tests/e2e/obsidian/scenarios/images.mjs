// S6 (images in Studio notes), in real Obsidian: a note embeds a picture from its own route folder; the publish window lists it AND shows it
// (the Studio cannot serve the picture's address before the upload, so the window puts the vault's file in place of that stand-in); sending uploads it
// and the Studio then holds the note with the picture's own address. Desktop layout; the phone layout renders the same window.
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/images.mjs
import { runScenario, wait } from "../lib.mjs";

// A 24x16 PNG made of two colours (valid, tiny): enough for a picture that really decodes.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAI0lEQVR4nGPUiFrAQAjsy5tDUA0TQRVEglGDRg0aNWikGgQAU6kDCruj+sUAAAAASUVORK5CYII=";

await runScenario({}, async (s) => {
  const { check } = s;
  const path = "Blyg/Picture note.md";
  const image = "Blyg/pic.png"; // inside the route folder: that is the only place a picture may come from

  await s.evaluate(async ([p, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.app.vault.createBinary(p, bytes.buffer);
  }, [image, PNG_BASE64]);
  await s.createNote(path, "A note with a small picture.\n\n![[pic.png|a small test picture]]\n");
  check(await s.openNote(path), "the panel follows the new note");

  // the panel says nothing is wrong with it
  await s.clickPanel("Send draft");
  check(await s.waitModal("Send a draft to your Studio"), "the window opens");
  const sheet = await s.modalText();
  check(/1 image uploaded with this draft: pic\.png/.test(sheet), "the window lists the picture that will be uploaded");

  // the picture is SHOWN, from the vault, not a broken image at an address the Studio cannot serve yet
  const shown = await s.becomes(
    () => s.evaluate(() => {
      const img = activeDocument.querySelector(".blyg-studio-render img");
      return img && img.complete && img.naturalWidth > 0 ? { src: img.getAttribute("src"), width: img.naturalWidth, height: img.naturalHeight } : null;
    }),
    10000,
    "the picture in the window to load",
  );
  check(Boolean(shown), "the window shows the picture (it decoded: not a broken image)");
  check(Boolean(shown) && !/\/media\/pending\//.test(shown.src) && shown.width === 24 && shown.height === 16, `it is the vault's file, 24x16 (${shown ? `${shown.src.slice(0, 40)}…, ${shown.width}x${shown.height}` : "none"})`);

  // sending: the picture is uploaded and the Studio holds the text with the picture's own address
  await s.clearNotices();
  await s.clickModal("Send draft");
  check(Boolean(await s.waitNotice(/Draft sent to the Studio \(/)), "the notice says the draft was sent");
  const id = await s.stamped(path);
  check(Boolean(id), `the note is stamped (${id || "none"})`);
  const item = id ? await s.studioItem(id) : { status: 0, json: null };
  const text = String(item.json?.contentMd ?? "");
  check(item.status === 200 && /!\[a small test picture\]\(https?:\/\/[^)]*\/media\/[0-9a-z]+\/[0-9a-f]{64}\.png\)/.test(text), `the Studio holds the text with the picture's own address (HTTP ${item.status})`);
  check(Array.isArray(item.json?.media) && item.json.media.length === 1, `the picture is attached to the item (${Array.isArray(item.json?.media) ? item.json.media.length : "?"} attached)`);

  // sending again: nothing to send (the note and the Studio's copy agree although one names a file and the other an address)
  await wait(1500);
  await s.clearNotices();
  await s.openNote(path);
  await s.clickPanel("Send draft");
  const again = await s.waitModal("Send a draft to your Studio", 6000, true);
  const noChange = await s.waitNotice(/nothing to send|No changes|up to date|unchanged/i, 8000);
  check(!again || Boolean(noChange), "sending the same note again finds nothing to send");
});
