// P6 slice D (docs/plans/P6-ui-regression.md): "Studio: import new items" (S7) in real Obsidian, desktop and phone layout. Replaces by a machine what
// T1 R7 does by hand: items written in the Studio's editor (a fragment, a thread quoting it, a draft) become notes; the thread's embed finds the
// fragment's note; the notes have nothing to send; an unticked item can be "not offered again". (T1 S5, a list of more than 100 items, stays a device step.)
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/import.mjs
import { fixtureData, runScenario } from "../lib.mjs";

const base = fixtureData();
const data = { ...base, routes: [...base.routes, { vaultPrefix: "Publish/", mode: "studio", label: "Blyg item" }] };

await runScenario({ data }, async (s) => {
  const { check } = s;

  /** An item "written in the Studio's editor": created through the owner API, published unless `draft`. */
  async function webItem(kind, contentMd, draft = false) {
    const made = await s.studio("/items", { method: "POST", body: JSON.stringify({ mode: "blank", kind, contentMd }) });
    const id = made.json?.id;
    if (!draft) {
      const rev = (await s.studioItem(id)).json?.revision;
      await s.studio(`/items/${encodeURIComponent(id)}/publish`, { method: "POST", body: JSON.stringify({ expectedRevision: rev }) });
    }
    return id;
  }

  async function round(layout) {
    const tag = layout === "desktop" ? "desktop" : "phone";
    const stamp = `${tag} ${Date.now().toString(36)}`;
    const fragId = await webItem("fragment", `Web fragment ${stamp}`);
    const threadId = await webItem("thread", `Web thread ${stamp}\n\n![[${fragId}]]\n\nAfter the quote.`);
    const draftId = await webItem("fragment", `Web draft ${stamp}`, true);
    await webItem("fragment", `Web skip ${stamp}`);
    check(Boolean(fragId && threadId && draftId), `${layout}: three items and one more are written in the Studio`);

    await s.openNote("Home.md");
    await s.clearNotices();
    check(await s.clickPanel("Import from Studio"), `${layout}: the panel offers “Import from Studio”`);
    check(await s.waitModal("Import new items"), `${layout}: the import window opens`);
    const rows = await s.importRows();
    const mine = rows.filter((r) => r.title.includes(stamp));
    check(mine.length === 4, `${layout}: it lists the four new items (${mine.length} of ${rows.length} rows are this run's)`);
    check(mine.every((r) => r.on), `${layout}: they start ticked`);
    check(mine.find((r) => r.title.startsWith("Web draft"))?.meta.includes("draft") === true, `${layout}: the draft is marked as a draft`);
    check(/Nothing/.test(await s.modalText()), `${layout}: the window says nothing is sent to the Studio`);
    // only this run's three: the Studio still holds items of earlier runs that have no note in this vault
    await s.tickOnly([`Web fragment ${stamp}`, `Web thread ${stamp}`, `Web draft ${stamp}`]);
    check((await s.importButtonLabel()) === "Import 3", `${layout}: the button counts the ticked rows (“${await s.importButtonLabel()}”)`);
    // “Don't offer the unticked ones again”
    await s.toggleInModal("Don't offer the unticked ones again");
    await s.clearNotices();
    await s.clickModal("Import 3");
    const done = await s.waitNotice(/Imported 3 items from the Studio into/);
    check(Boolean(done), `${layout}: the notice says 3 items were imported (${done.slice(0, 90)})`);
    check(done.includes("Nothing was sent to the Studio"), `${layout}: ... and that nothing was sent`);

    // the notes: where the plugin put them, and what is in them
    const folder = /into “([^”]*)”/.exec(done)?.[1] ?? "";
    const dir = folder === "" ? "" : folder.replace(/\/?$/, "/");
    const fragPath = `${dir}Web fragment ${stamp}.md`;
    const threadPath = `${dir}Web thread ${stamp}.md`;
    const draftPath = `${dir}Web draft ${stamp}.md`;
    const exist = await s.evaluate((ps) => ps.map((p) => Boolean(window.app.vault.getAbstractFileByPath(p))), [fragPath, threadPath, draftPath]);
    check(exist.every(Boolean), `${layout}: the three notes exist in “${folder}” (${exist.join(", ")})`);
    check((await s.readNote(threadPath)).includes(`![[Web fragment ${stamp}]]`), `${layout}: the thread's embed shows the fragment's note by name`);
    check((await s.frontmatter(fragPath))?.blyg_id === fragId || Boolean(await s.stamped(fragPath)), `${layout}: the fragment note carries its id`);
    check((await s.stamped(draftPath, "blyg_version")) === 0, `${layout}: the draft note carries version 0`);
    check((await s.stamped(draftPath, "blyg_id")) === draftId, `${layout}: ... and the draft's id`);

    // each note has nothing to send
    await s.openNote(fragPath);
    check(Boolean(await s.becomes(async () => /up to date/.test(await s.panelHeadline()), 20000, "the panel")), `${layout}: the fragment's panel says it is up to date (${await s.panelHeadline()})`);
    await s.openNote(draftPath);
    check(Boolean(await s.becomes(async () => /Draft in the Studio/.test(await s.panelHeadline()), 20000, "the panel")), `${layout}: the draft's panel says it is a draft in the Studio (${await s.panelHeadline()})`);

    // the unticked one is not offered again
    await s.openNote("Home.md");
    await s.clearNotices();
    await s.clickPanel("Import from Studio");
    const next = await s.becomes(async () => ((await s.modalTitle()) === "Import new items" ? "window" : (await s.notices()).some((t) => /nothing to import|Nothing was imported/.test(t)) ? "notice" : false), 20000, "the second import");
    if (next === "window") {
      check(!(await s.importRows()).some((r) => r.title.includes(`Web skip ${stamp}`)), `${layout}: the item left unticked is not offered again`);
      await s.clickModal("Cancel");
      await s.modalClosed();
    } else {
      check(next === "notice", `${layout}: nothing is left to import: the unticked items are not offered again`);
    }
  }

  await round("desktop");
  if (!process.env.E2E_DESKTOP_ONLY) {
    await s.phone();
    await round("phone layout");
  }
});
