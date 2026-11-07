// P6 slice D (docs/plans/P6-ui-regression.md): "Insert quote" in real Obsidian, desktop and phone layout: the picker, the quote window (the whole item,
// a passage), a pasted address, an item of a blyg the Studio reads, and the hint on a fragment. Replaces by a machine what T1 R3/R4 and the quote
// part of S4 do by hand. The item of the other blyg needs `WITH_REMOTE=1 scripts/local-studio.sh start` (without it that part says so and is left out).
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/quote.mjs
import { STUDIO, fixtureData, runScenario, wait } from "../lib.mjs";

const base = fixtureData();
const data = { ...base, routes: [...base.routes, { vaultPrefix: "Publish/", mode: "studio", label: "Blyg item" }] };

await runScenario({ data }, async (s) => {
  const { check } = s;
  const stamp = Date.now().toString(36);
  const own = `Quotable source ${stamp}. A second sentence to quote.`;

  // An item of yours, published "in the Studio" (REST, like the Studio's editor), and an item of a blyg the Studio reads (if the remote Studio is there).
  const made = await s.studio("/items", { method: "POST", body: JSON.stringify({ mode: "blank", kind: "fragment", contentMd: own }) });
  const ownId = made.json?.id;
  const rev = (await s.studioItem(ownId)).json?.revision;
  const pub = await s.studio(`/items/${encodeURIComponent(ownId)}/publish`, { method: "POST", body: JSON.stringify({ expectedRevision: rev }) });
  check(made.status === 201 && pub.status === 200, `an item of yours is published in the Studio (HTTP ${made.status}, ${pub.status})`);
  const imported = (await s.studio("/search?source=imported&limit=5")).json?.items?.[0];
  if (!imported) console.log("skip the part about a blyg you read: the Studio holds no imported item (WITH_REMOTE=1 scripts/local-studio.sh start)");

  async function round(layout) {
    const tag = layout === "desktop" ? "desktop" : "phone";
    const path = `Publish/Quote thread ${tag}.md`;
    await s.createNote(path, "---\nblyg_kind: thread\n---\nOpening words.\n\n");
    check(await s.openNote(path), `${layout}: the panel follows the thread`);
    await s.cursorToEnd(path);

    // the whole item
    check(await s.clickPanel("Insert quote"), `${layout}: the panel offers “Insert quote”`);
    check(Boolean(await s.becomes(() => s.pickerOpen(), 10000, "the picker")), `${layout}: the picker opens`);
    await s.typeInPicker(`Quotable source ${stamp}`);
    check(await s.pickerHas(`Quotable source ${stamp}`), `${layout}: typing the item's words lists it (${(await s.pickerItems())[0]?.slice(0, 60) ?? "nothing"})`);
    check((await s.pickerItems()).some((t) => t.includes("In your Studio")), `${layout}: ... marked as in your Studio`);
    await s.pickItem(`Quotable source ${stamp}`);
    check(await s.waitModal("Quote from this item"), `${layout}: the quote window opens`);
    check((await s.quoteBoxText()).includes(`Quotable source ${stamp}`), `${layout}: ... showing the item's text`);
    if (process.env.E2E_DEBUG) console.error("EDITOR BEFORE", JSON.stringify(await s.editorText(path)));
    await s.clearNotices();
    await s.clickModal("Quote the whole item");
    check(Boolean(await s.waitNotice(/quote/i)), `${layout}: a notice says the quote was inserted`);
    if (process.env.E2E_DEBUG) console.error("EDITOR AFTER WHOLE", JSON.stringify(await s.editorText(path)));
    const whole = await s.becomes(async () => (await s.editorText(path)).includes(`![[${ownId}`), 10000, "the embed");
    check(Boolean(whole), `${layout}: the note holds ![[…]] for the item`);

    // a passage
    await s.cursorToEnd(path);
    check(await s.clickPanel("Insert quote"), `${layout}: Insert quote again`);
    await s.becomes(() => s.pickerOpen(), 10000, "the picker");
    await s.typeInPicker(`Quotable source ${stamp}`);
    await s.pickerHas(`Quotable source ${stamp}`);
    await s.pickItem(`Quotable source ${stamp}`);
    check(await s.waitModal("Quote from this item"), `${layout}: the quote window opens again`);
    check(await s.selectInQuoteBox("A second sentence to quote."), `${layout}: a passage is selected in the text`);
    check(Boolean(await s.becomes(async () => /\d+ characters selected/.test(await s.modalText()), 5000, "the status")), `${layout}: the window says how many characters are selected`);
    await s.clearNotices();
    await s.clickModal("Quote the selection");
    const passage = await s.becomes(async () => (await s.editorText(path)).includes("> A second sentence to quote."), 10000, "the passage");
    check(Boolean(passage), `${layout}: the note holds the passage as a > line`);

    // a pasted address (R4): the item's public address finds it; an address that is not an item says so
    await s.cursorToEnd(path);
    const before = await s.editorText(path);
    check(await s.clickPanel("Insert quote"), `${layout}: Insert quote for an address`);
    await s.becomes(() => s.pickerOpen(), 10000, "the picker");
    await s.typeInPicker(`${STUDIO}/f/${ownId}/`);
    check(await s.pickerHas(`Quotable source ${stamp}`), `${layout}: the item's own address finds the item`);
    await s.typeInPicker("https://example.com/not-an-item/");
    const refused = await s.becomes(async () => /not recognised/.test(await s.pickerEmpty()), 15000, "the refusal");
    check(Boolean(refused), `${layout}: an address that is not an item says so (“${(await s.pickerEmpty()).slice(0, 60)}”)`);
    await s.closePicker();
    await s.becomes(async () => !(await s.pickerOpen()), 5000, "the picker to close");
    await wait(300);
    check((await s.editorText(path)) === before, `${layout}: closing the picker inserts nothing`);

    // an item of a blyg the Studio reads: found by its words, a passage quoted, and the publish window lists it as another blyg's
    if (imported) {
      const words = "remote fragment";
      const sentence = "It has a quotable sentence.";
      check(await s.clickPanel("Insert quote"), `${layout}: Insert quote for another blyg's item`);
      await s.becomes(() => s.pickerOpen(), 10000, "the picker");
      await s.typeInPicker(words);
      check(await s.pickerHas("Blog B"), `${layout}: the words find the item of the blyg you read (marked with its name)`);
      await s.pickItem("Blog B");
      check(await s.waitModal("Quote from this item"), `${layout}: the quote window opens for it`);
      check(await s.selectInQuoteBox(sentence), `${layout}: a passage is selected`);
      await s.clickModal("Quote the selection");
      check(Boolean(await s.becomes(async () => (await s.editorText(path)).includes(`> ${sentence}`), 10000, "the passage")), `${layout}: the note holds the passage of the other blyg's item`);
      await s.writeNote(path, await s.editorText(path));
      await s.refreshPanel(path);
      check(await s.clickPanel("Publish"), `${layout}: Publish on the thread`);
      check(await s.waitModal(/^Publish a new /), `${layout}: the publish window opens`);
      const sheet = await s.modalText();
      check(sheet.includes("Quotes in this thread") && sheet.includes("another blyg"), `${layout}: it lists the quote as from another blyg`);
      await s.clickModal("Cancel");
      await s.modalClosed();
    }

    // a fragment cannot quote: the button is grey and the panel says why
    const frag = `Publish/Quote fragment ${tag}.md`;
    await s.createNote(frag, "Just a fragment.");
    check(await s.openNote(frag), `${layout}: the panel follows a fragment`);
    check((await s.panelButtons()).find((b) => b.text === "Insert quote")?.disabled === true, `${layout}: “Insert quote” is grey on a fragment`);
    check((await s.panelText()).includes("Insert quote works in threads only"), `${layout}: ... and the panel says why`);
  }

  await round("desktop");
  if (!process.env.E2E_DESKTOP_ONLY) {
    await s.phone();
    await round("phone layout");
  }
});
