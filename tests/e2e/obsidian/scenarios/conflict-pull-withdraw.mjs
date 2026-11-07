// P6 slice B (docs/plans/P6-ui-regression.md): publish, a change made in the Studio, the overwrite window, pull, withdraw and re-publish, and a refusal
// before anything is sent, on a NORMAL Studio folder (it publishes to the local Studio), in real Obsidian, desktop and phone layout.
// Replaces by a machine what T1 S3/S4/R8/R9 do by hand. "Typed in the Studio's editor" is the Studio's REST API with the owner token (the plugin
// only ever sees its answer).
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/conflict-pull-withdraw.mjs
import { fixtureData, runScenario, wait } from "../lib.mjs";

const base = fixtureData();
const data = { ...base, routes: [...base.routes, { vaultPrefix: "Publish/", mode: "studio", label: "Blyg item" }] };

await runScenario({ data }, async (s) => {
  const { check } = s;
  /** The note's text without its properties. */
  const body = async (path) => (await s.readNote(path)).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  const append = async (path, line) => { const cur = await s.readNote(path); await s.writeNote(path, `${cur.replace(/\n*$/, "\n")}${line}\n`); };

  async function cycle(layout) {
    const tag = layout === "desktop" ? "desktop" : "phone";
    const path = `Publish/Cycle ${tag}.md`;
    const opening = `Cycle text for the ${tag}.`;
    await s.createNote(path, `${opening} It is the first version.`);
    check(await s.openNote(path), `${layout}: the panel follows the new note`);

    // publish for real (to the local Studio)
    check(await s.clickPanel("Publish"), `${layout}: the panel offers “Publish”`);
    check(await s.waitModal(/^Publish a new /), `${layout}: the window is titled “Publish a new … to your Studio”`);
    check(/goes live at once/.test(await s.modalText()), `${layout}: the window says it goes live at once`);
    await s.clearNotices();
    await s.clickModal("Publish");
    check(Boolean(await s.waitNotice(/Published to the Studio: new item/)), `${layout}: the notice says a new item was published`);
    const id = await s.stamped(path);
    check(Boolean(id), `${layout}: the note is stamped with blyg_id (${id || "none"})`);
    if (!id) return;
    const v1 = await s.studioItem(id);
    check(v1.json?.status === "public" && v1.json?.version === 1, `${layout}: the Studio has it public, version 1 (${v1.json?.status}, v${v1.json?.version})`);

    // S3: a change made in the Studio, and a change of the note → the overwrite window
    check((await s.editInStudio(id, "Typed in the Studio.")) === 200, `${layout}: the text is changed in the Studio`);
    await append(path, "Added in the note.");
    await s.becomes(async () => (await s.panelHeadline()) !== "", 5000, "the panel");
    await wait(1000);
    check(await s.clickPanel("Update"), `${layout}: the panel offers “Update”`);
    check(await s.waitModal("The Studio’s copy was changed there"), `${layout}: the window says the Studio's copy was changed there`);
    const conflict = await s.modalText();
    check(conflict.includes("Typed") && conflict.includes("Added"), `${layout}: the window shows both texts`);
    if (process.env.E2E_DEBUG) console.error("CONFLICT WINDOW", JSON.stringify(conflict));
    await s.clearNotices();
    await s.clickModal("Cancel");
    check(Boolean(await s.waitNotice("Cancelled — the working copy")), `${layout}: Cancel says the Studio's copy was left as it is`);
    const kept = await s.studioItem(id);
    check(kept.json?.contentMd === "Typed in the Studio.", `${layout}: the Studio still holds what was typed there`);
    check((await body(path)).includes("Added in the note."), `${layout}: the note still holds its own text`);

    check(await s.clickPanel("Update"), `${layout}: Update again`);
    check(await s.waitModal("The Studio’s copy was changed there"), `${layout}: the window opens again`);
    await s.clearNotices();
    await s.clickModal("Replace the online copy with this note");
    // agreeing is followed by the ordinary confirmation window (with the change-note field): the second yes
    check(await s.waitModal(/^Publish a new version/), `${layout}: agreeing is followed by the publish window`);
    await s.clickModal("Publish");
    check(Boolean(await s.waitNotice(/Published to the Studio: version 2/)), `${layout}: agreeing publishes version 2`);
    const v2 = await s.studioItem(id);
    check(String(v2.json?.contentMd).includes("Added in the note.") && v2.json?.version === 2, `${layout}: the Studio now holds the note's text as version 2`);

    // R8: pull the Studio's copy
    check((await s.editInStudio(id, "Rewritten in the Studio, for the pull.")) === 200, `${layout}: the text is changed in the Studio again`);
    // the panel reads the Studio when it draws: make it draw again
    await s.refreshPanel(path);
    check(await s.clickPanel("Replace this note with the online text"), `${layout}: the panel offers “Replace this note with the online text”`);
    check(await s.waitModal("Replace this note with the online text"), `${layout}: the pull window opens`);
    const pullSheet = await s.modalText();
    check(pullSheet.includes("Rewritten") && pullSheet.includes("Changes: +"), `${layout}: it shows the online text as changes to the note`);
    if (process.env.E2E_DEBUG) console.error("PULL WINDOW", JSON.stringify(pullSheet));
    await s.clearNotices();
    await s.clickModal("Cancel");
    check(Boolean(await s.waitNotice("Cancelled — the note was left as it is")), `${layout}: Cancel leaves the note as it is`);
    check((await body(path)).includes("Added in the note."), `${layout}: ... and it does`);
    check(await s.clickPanel("Replace this note with the online text"), `${layout}: pull again`);
    check(await s.waitModal("Replace this note with the online text"), `${layout}: the window opens again`);
    await s.clearNotices();
    await s.clickModal("Replace this note with the online text");
    check(Boolean(await s.waitNotice(/The note now holds the Studio's copy/)), `${layout}: the notice says the note holds the Studio's copy`);
    check((await body(path)) === "Rewritten in the Studio, for the pull.", `${layout}: the note's text is the Studio's (${JSON.stringify((await body(path)).slice(0, 60))})`);

    // R9: withdraw, then bring it back
    check(await s.clickPanel("Withdraw"), `${layout}: the panel offers “Withdraw”`);
    check(await s.waitModal("Withdraw this item from your Studio"), `${layout}: the withdraw window opens`);
    check(/A withdrawal cannot be deleted/.test(await s.modalText()), `${layout}: it says a withdrawal cannot be deleted`);
    await s.typeInModal("retracted in the e2e run");
    await s.clearNotices();
    await s.clickModal("Withdraw");
    check(Boolean(await s.waitNotice(/Withdrawn in the Studio: version 3/)), `${layout}: the notice says version 3 is withdrawn`);
    const gone = await s.studioItem(id);
    check(gone.json?.status === "withdrawn", `${layout}: the Studio shows the item as withdrawn (${gone.json?.status})`);
    check(Boolean(await s.stamped(path, "blyg_withdrawn")), `${layout}: the note carries blyg_withdrawn`);
    check(Boolean(await s.becomes(async () => /withdrawn/i.test(await s.panelText()), 15000, "the panel")), `${layout}: the panel says it is withdrawn`);
    check(await s.clickPanel("Publish again"), `${layout}: the panel offers “Publish again”`);
    check(await s.waitModal(/^Publish a new version/), `${layout}: the window offers a new version`);
    await s.clearNotices();
    await s.clickModal("Publish");
    check(Boolean(await s.waitNotice(/Published to the Studio: version 4/)), `${layout}: publishing again makes version 4`);
    const back = await s.studioItem(id);
    check(back.json?.status === "public" && back.json?.version === 4, `${layout}: the Studio has it public again, version 4`);

    // S4: a refusal before anything is sent: the panel says why and holds Publish back; the same thread, corrected, reaches the window
    const thread = `Publish/Refusal ${tag}.md`;
    await s.createNote(thread, `---\nblyg_kind: thread\n---\nOpening.\n\n![[${id}]]\n> Rewritten in the Studio\nand a line of my own directly under it\n`);
    check(await s.openNote(thread), `${layout}: the panel follows the thread`);
    const refused = await s.becomes(async () => /directly under a quote/.test(await s.panelText()), 15000, "the refusal in the panel");
    check(Boolean(refused), `${layout}: the panel says a line directly under a partial quote is refused`);
    check((await s.panelButtons()).find((b) => b.text === "Publish")?.disabled === true, `${layout}: ... and Publish is held back`);
    check(!(await s.modalOpen()) && !(await s.frontmatter(thread))?.blyg_id, `${layout}: ... nothing was sent (no window, no blyg_id)`);
    await s.writeNote(thread, `---\nblyg_kind: thread\n---\nOpening.\n\n![[${id}]]\n> Rewritten in the Studio\n\nand a line of my own, after a blank line\n`);
    await s.refreshPanel(thread);
    check(await s.clickPanel("Publish"), `${layout}: with the blank line Publish is enabled`);
    check(await s.waitModal(/^Publish a new /), `${layout}: ... and the window opens`);
    check(/Quotes in this thread/.test(await s.modalText()), `${layout}: ... and lists the quote`);
    await s.clickModal("Cancel");
    await s.modalClosed();
  }

  await cycle("desktop");
  if (!process.env.E2E_DESKTOP_ONLY) {
    await s.phone();
    await cycle("phone layout");
  }
});
