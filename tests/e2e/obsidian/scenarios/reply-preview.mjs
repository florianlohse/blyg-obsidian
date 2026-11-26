// S15: the reply preview in real Obsidian, desktop and phone layout: a reply note starts with `![[id | label]]`; in Live Preview and Reading view the line shows the
// text of the item it points at (an item of the owner's, and an item of a blyg the Studio reads), VIEW-ONLY: the note's text stays as written. Source mode and the line
// under the cursor show the line itself; a directive inside fenced code is left alone; an id nothing knows says so.
//
//   WITH_REMOTE=1 scripts/local-studio.sh start …;   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/reply-preview.mjs
import { STUDIO, fixtureData, runScenario, wait } from "../lib.mjs";

const base = fixtureData();
const data = { ...base, routes: [...base.routes, { vaultPrefix: "Publish/", mode: "studio", label: "Blyg item" }] };

await runScenario({ data }, async (s) => {
  const { check, page } = s;
  const stamp = Date.now().toString(36);
  const made = await s.studio("/items", { method: "POST", body: JSON.stringify({ mode: "blank", kind: "fragment", contentMd: `Preview target ${stamp}. The words to be shown.` }) });
  const ownId = made.json?.id;
  const rev = (await s.studioItem(ownId)).json?.revision;
  const pub = await s.studio(`/items/${encodeURIComponent(ownId)}/publish`, { method: "POST", body: JSON.stringify({ expectedRevision: rev }) });
  check(made.status === 201 && pub.status === 200, `an item to answer is published in the Studio (HTTP ${made.status}, ${pub.status})`);
  const imported = (await s.studio("/search?source=imported&q=remote%20fragment&limit=5")).json?.items?.find((i) => /remote fragment/i.test(i.excerpt ?? ""));
  if (!imported) console.log("skip the preview of an item of a blyg you read: the Studio holds no imported item (WITH_REMOTE=1 scripts/local-studio.sh start)");
  const missing = "0000000000000000000000000z";

  const note = (id, label, stub) => `---\nblyg_kind: thread\n${stub ? `blyg_stub_of:\n  origin: ${stub.origin}\n  id: ${id}\n  version: 1\n` : ""}---\n![[${id}${label ? ` | ${label}` : ""}]]\n\nMy own words under the quote.\n`;
  /** Open the note in the given mode ("source" or "live" for the editor, "preview" for Reading view) and wait for the editor to settle. */
  const openIn = (path, mode) => page.evaluate(async ([p, m]) => {
    const leaf = window.app.workspace.getLeaf(false);
    await leaf.openFile(window.app.vault.getAbstractFileByPath(p));
    await leaf.setViewState({ type: "markdown", state: { file: p, mode: m === "preview" ? "preview" : "source", source: m === "source" } });
    await new Promise((r) => setTimeout(r, 500));
    // A new reply note puts the cursor under the quote; here it goes to the end of the note, off the directive's line.
    const ed = leaf.view.editor;
    if (ed) ed.setCursor({ line: ed.lastLine(), ch: 0 });
    await new Promise((r) => setTimeout(r, 400));
  }, [path, mode]);
  const widgets = () => page.evaluate(() => [...document.querySelectorAll(".workspace-leaf.mod-active .blyg-reply-preview")].map((w) => ({ text: w.textContent ?? "", clamped: !!w.querySelector(".is-clamped") })));

  async function round(layout) {
    const tag = layout === "desktop" ? "d" : "p";
    const own = `Publish/Preview own ${tag}.md`;
    await s.createNote(own, note(ownId, "My earlier item", null));
    await openIn(own, "live");
    const got = await s.becomes(async () => { const w = await widgets(); return w.length === 1 && /The words to be shown/.test(w[0].text) ? w : false; }, 15000, "the preview in Live Preview");
    if (!got) console.log("DEBUG", JSON.stringify(await page.evaluate(() => { const l = window.app.workspace.getLeaf(false); const cm = document.querySelector(".workspace-leaf.mod-active .cm-content"); return { mode: l.view.getMode?.(), state: l.getViewState().state, html: cm?.innerHTML?.slice(0, 700), cursor: l.view.editor?.getCursor?.() }; })));
    check(Boolean(got), `${layout}: Live Preview shows the text of the item the directive points at (${JSON.stringify(await widgets()).slice(0, 160)})`);
    // H: the preview is collapsed to about two lines by default (the expand button is "Show more")
    const clampPx = await page.evaluate(() => { const host = document.querySelector(".workspace-leaf.mod-active .blyg-reply-preview"); if (!host) return null; const probe = host.createDiv({ cls: "blyg-reply-preview-body is-clamped" }); const px = parseFloat(getComputedStyle(probe).maxHeight); const lh = parseFloat(getComputedStyle(probe).lineHeight) || 24; probe.remove(); return { px, lh }; });
    check(clampPx && clampPx.px <= clampPx.lh * 2.4, `${layout}: a long quoted item is collapsed to two lines by default (max height ${clampPx?.px}px, line ${clampPx?.lh}px)`);
    if (process.env.POC_SHOTS) await page.screenshot({ path: `${process.env.POC_SHOTS}/reply-preview-${layout}.png` }).catch(() => {});
    check((await s.readNote(own)).includes(`![[${ownId} | My earlier item]]`) && !(await s.readNote(own)).includes("The words to be shown"), `${layout}: the note's text is unchanged: the directive stays, the item's words are not in the file`);
    const raw = await page.evaluate(() => document.querySelector(".workspace-leaf.mod-active .cm-content")?.textContent ?? "");
    check(!raw.includes(`![[${ownId}`), `${layout}: the line is replaced while the cursor is elsewhere`);

    // "Edit line" puts the cursor on the line: the directive shows as written, the card goes.
    await page.evaluate(() => document.querySelector(".workspace-leaf.mod-active .blyg-reply-preview-edit")?.click());
    await wait(600);
    const editing = await page.evaluate(() => ({ widgets: document.querySelectorAll(".workspace-leaf.mod-active .blyg-reply-preview").length, text: document.querySelector(".workspace-leaf.mod-active .cm-content")?.textContent ?? "" }));
    check(editing.widgets === 0 && editing.text.includes(`![[${ownId}`), `${layout}: "Edit line" shows the line as written (${editing.widgets} cards)`);

    await openIn(own, "source");
    check((await widgets()).length === 0, `${layout}: source mode shows the line itself, no card`);

    await openIn(own, "preview");
    const reading = await s.becomes(async () => { const w = await widgets(); return w.length >= 1 && /The words to be shown/.test(w[0].text) ? w : false; }, 15000, "the preview in Reading view");
    check(Boolean(reading), `${layout}: Reading view shows it too (${JSON.stringify(await widgets()).slice(0, 160)})`);

    if (imported) {
      const held = `Publish/Preview held ${tag}.md`;
      await s.createNote(held, note(imported.id, "Blog B", { origin: "http://localhost:8788" }));
      await openIn(held, "live");
      const h = await s.becomes(async () => { const w = await widgets(); return w.length === 1 && /remote fragment/i.test(w[0].text) ? w : false; }, 15000, "the preview of a held item");
      check(Boolean(h), `${layout}: the text of an item of a blyg you read is shown (${JSON.stringify(await widgets()).slice(0, 140)})`);
    }

    const none = `Publish/Preview none ${tag}.md`;
    await s.createNote(none, note(missing, "Nobody", null));
    await openIn(none, "live");
    const n = await s.becomes(async () => { const w = await widgets(); return w.length === 1 && /could not be found/.test(w[0].text) ? w : false; }, 15000, "the missing item's card");
    check(Boolean(n), `${layout}: an id nothing knows says so, in words`);

    const fenced = `Publish/Preview fenced ${tag}.md`;
    await s.createNote(fenced, `---\nblyg_kind: thread\n---\nA code sample:\n\n\`\`\`\n![[${ownId}]]\n\`\`\`\n`);
    await openIn(fenced, "live");
    await wait(800);
    check((await widgets()).length === 0, `${layout}: a directive inside fenced code is left alone`);
  }

  await round("desktop");
  await s.phone();
  await round("phone");
});
