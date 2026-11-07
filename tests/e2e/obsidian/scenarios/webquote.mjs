// S20 (docs/plans/S20-web-quote.md): "Insert web quote" in real Obsidian, desktop and phone layout: the form, Insert waiting for a usable quote and address,
// the block written at the cursor with a blank line either side, the tracking parameters gone, the selection taken as the quote, and the draft kept when the
// form is left and opened again (what saves the text when an iPhone ends the app), and a changed format in the settings driving the whole block. A plain note outside every route: the command has nothing to do with blyg.
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/webquote.mjs
import { fixtureData, runScenario } from "../lib.mjs";

await runScenario({ data: fixtureData() }, async (s) => {
  const { check } = s;
  const page = s.page;
  const ID = "blyg:insert-web-quote";

  const fill = (name, value) => page.evaluate(([n, v]) => {
    const row = [...activeDocument.querySelectorAll(".modal-container .modal .setting-item")].find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() === n);
    const el = row?.querySelector("textarea, input[type=text]");
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, [name, value]);
  const read = (name) => page.evaluate((n) => {
    const row = [...activeDocument.querySelectorAll(".modal-container .modal .setting-item")].find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() === n);
    return row?.querySelector("textarea, input[type=text]")?.value ?? null;
  }, name);
  const preview = () => page.evaluate(() => activeDocument.querySelector(".modal-container .blyg-webquote-preview")?.textContent ?? "");
  const openPlain = (path) => page.evaluate(async (p) => { await window.app.workspace.getLeaf(false).openFile(window.app.vault.getAbstractFileByPath(p)); }, path);
  const cursorAtLine = (path, line) => page.evaluate(([p, l]) => {
    const ed = window.app.workspace.getLeavesOfType("markdown").find((x) => x.view.file?.path === p)?.view.editor;
    if (!ed) return false;
    ed.setCursor({ line: l, ch: 0 });
    return true;
  }, [path, line]);
  const selectLine = (path, text) => page.evaluate(([p, t]) => {
    const ed = window.app.workspace.getLeavesOfType("markdown").find((x) => x.view.file?.path === p)?.view.editor;
    if (!ed) return false;
    const line = ed.getValue().split("\n").indexOf(t);
    if (line < 0) return false;
    ed.setSelection({ line, ch: 0 }, { line, ch: t.length });
    return true;
  }, [path, text]);

  async function round(layout) {
    const tag = layout === "desktop" ? "desktop" : "phone";
    const path = `Scratch/Web quote ${tag}.md`;
    await s.createNote(path, "Intro paragraph.\n\nClosing paragraph.\n");
    await openPlain(path);
    check(await cursorAtLine(path, 1), `${layout}: a plain note outside every route is open, the cursor between its paragraphs`);

    check((await s.commandIds("blyg:insert-web-quote")).includes(ID), `${layout}: the command “Insert web quote (plain Markdown)” is in the palette`);
    await s.command(ID);
    check(await s.waitModal("Insert web quote"), `${layout}: the form opens`);
    check(!(await s.clickModal("Insert", 800)), `${layout}: Insert is grey while the form is empty`);

    // leave half-way, open again: the draft is back
    check(await fill("Quote", "Half a thought"), `${layout}: the quote is typed`);
    check(await fill("Link", "https://example.com/post?id=7&utm_source=newsletter#c"), `${layout}: the address is typed`);
    check((await preview()) === "> Half a thought\n> *[example.com/post](https://example.com/post?id=7#c)*", `${layout}: the form shows the block as it will be written (tracking parameter gone, link shortened, no blank line between): ${JSON.stringify(await preview())}`);
    check(await s.clickModal("Cancel"), `${layout}: Cancel`);
    check(await s.modalClosed(), `${layout}: the form closes`);
    await s.command(ID);
    check(await s.waitModal("Insert web quote"), `${layout}: the form opens again`);
    check((await read("Quote")) === "Half a thought" && (await read("Link")) === "https://example.com/post?id=7&utm_source=newsletter#c", `${layout}: ... with the draft back`);

    check(await fill("Quote", "Quote line one\nQuote line two"), `${layout}: the quote is two lines`);
    check(await fill("Alias (optional)", "A *post*"), `${layout}: an alias is typed`);
    check(await s.clickModal("Insert"), `${layout}: Insert is offered and clicked`);
    check(await s.modalClosed(), `${layout}: the form closes`);
    const expected = "Intro paragraph.\n\n> Quote line one\n> Quote line two\n> *[A \\*post\\*](https://example.com/post?id=7#c)*\n\nClosing paragraph.\n";
    const text = await s.editorText(path);
    check(text === expected, `${layout}: the note holds the block, a blank line either side${text === expected ? "" : ` (got ${JSON.stringify(text)})`}`);

    // a selection becomes the quote; the draft was cleared by the insert
    check(await selectLine(path, "Closing paragraph."), `${layout}: a line of the note is selected`);
    await s.command(ID);
    check(await s.waitModal("Insert web quote"), `${layout}: the form opens on a selection`);
    check((await read("Quote")) === "Closing paragraph." && (await read("Link")) === "", `${layout}: the selection is the quote, nothing is left over from the insert`);
    check(await s.clickModal("Cancel"), `${layout}: Cancel`);
    await s.modalClosed();
    // nothing typed: no draft is kept
    await s.command(ID);
    await s.waitModal("Insert web quote");
    check(await s.clickModal("Clear"), `${layout}: Clear`);
    check(await s.clickModal("Cancel"), `${layout}: Cancel`);
    await s.modalClosed();
  }

  await round("desktop");

  // The format drives the whole block: this one has no marks and a blank line of its own.
  await s.withData(fixtureData({ webQuote: { format: "{quote}\n\nSource: {link}", stripTracking: true } }));
  {
    const path = "Scratch/Web quote format.md";
    await s.createNote(path, "Intro paragraph.\n\nClosing paragraph.\n");
    await openPlain(path);
    await cursorAtLine(path, 1);
    await s.command(ID);
    check(await s.waitModal("Insert web quote"), "a changed format: the form opens");
    await fill("Quote", "Plain words");
    await fill("Link", "https://example.com/p?utm_source=x");
    await fill("Alias (optional)", "Title");
    check(await s.clickModal("Insert"), "a changed format: Insert");
    await s.modalClosed();
    const text = await s.editorText(path);
    const want = "Intro paragraph.\n\nPlain words\n\nSource: [Title](https://example.com/p)\n\nClosing paragraph.\n";
    check(text === want, `a changed format (no marks, a blank line of its own) is followed exactly${text === want ? "" : ` (got ${JSON.stringify(text)})`}`);
  }
  await s.withData(fixtureData());
  if (!process.env.E2E_DESKTOP_ONLY) {
    await s.phone();
    await round("phone layout");
  }
});
