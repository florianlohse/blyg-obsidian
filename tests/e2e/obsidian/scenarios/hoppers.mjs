// P6 slice C (docs/plans/P6-ui-regression.md): hoppers from the plugin (S13), in real Obsidian, desktop and phone layout, on a drafts-only folder.
// Replaces by a machine what docs/S13-DEVICE-TEST.md §1–§6 (T1 R6, including step 14, the 0.7.0 retest) do by hand: choose a hopper for a note, send
// it, take it out from the note, a removal made in the Studio stands, a wrong name is refused and stays in the property, also right after typing.
// The hopper itself is made "in the Studio" through its REST API (the plugin never creates one, D4).
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/hoppers.mjs
import { runScenario, wait } from "../lib.mjs";

await runScenario({}, async (s) => {
  const { check } = s;
  const stamp = Date.now().toString(36);

  /** Is the item in the hopper's list of the owner's own items? (The memberships rows are searched as text: only the id matters.) */
  async function inHopper(hopperId, itemId) {
    const got = await s.studio(`/hoppers/${encodeURIComponent(hopperId)}/memberships`);
    return got.status === 200 && JSON.stringify(got.json).includes(itemId);
  }
  /** The note with its `blyg_hoppers` property replaced by `value` (a line), or removed when value is null. The other properties stay. */
  async function withHoppersProperty(path, value) {
    const text = await s.readNote(path);
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    const rest = m ? text.slice(m[0].length) : text;
    const lines = (m ? m[1] : "").split("\n");
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^blyg_hoppers:/.test(lines[i])) { while (i + 1 < lines.length && /^\s+- /.test(lines[i + 1])) i++; continue; }
      kept.push(lines[i]);
    }
    if (value !== null) kept.unshift(`blyg_hoppers: ${value}`);
    return `---\n${kept.filter((l) => l !== "").join("\n")}\n---\n${rest}`;
  }
  const setHoppersProperty = async (path, value) => s.writeNote(path, await withHoppersProperty(path, value));

  const made = await s.studio("/hoppers", { method: "POST", body: JSON.stringify({ name: `Plugin test ${stamp}` }) });
  check(made.status === 201, `a private test hopper is made in the Studio (HTTP ${made.status})`);
  if (made.status !== 201) return;
  const hopper = { id: made.json.id, name: made.json.name };

  async function round(layout) {
    const tag = layout === "desktop" ? "desktop" : "phone";
    const path = `Blyg/Hopper ${tag}.md`;
    await s.createNote(path, `Hopper test ${tag} ${stamp}.`);
    check(await s.openNote(path), `${layout}: the panel follows the new note`);

    // §2 choose it for a note
    check((await s.panelFacts()).Hoppers === "none", `${layout}: the panel shows “Hoppers: none” (${(await s.panelFacts()).Hoppers ?? "no row"})`);
    check(await s.clickPanel("Hoppers…"), `${layout}: the panel offers “Hoppers…”`);
    check(await s.waitModal("Hoppers for this note"), `${layout}: the window is titled “Hoppers for this note”`);
    const listed = await s.modalText();
    check(listed.includes(hopper.name) && listed.includes("Private"), `${layout}: it lists the hopper, marked Private`);
    check((await s.switchIsOn(hopper.name)) === false, `${layout}: its switch starts off`);
    await s.toggleInModal(hopper.name);
    await s.clearNotices();
    await s.clickModal("Save");
    check(Boolean(await s.waitNotice("The Studio changes when you publish or send the note")), `${layout}: the notice says the Studio changes when the note is sent`);
    const chosen = await s.becomes(async () => JSON.stringify((await s.frontmatter(path))?.blyg_hoppers ?? null).includes(hopper.name), 15000, "blyg_hoppers");
    check(Boolean(chosen), `${layout}: the note's property holds the hopper's name`);

    // §3 send it
    check(await s.clickPanel("Send draft"), `${layout}: Send draft`);
    check(await s.waitModal("Send a draft to your Studio"), `${layout}: the window opens`);
    check((await s.modalText()).includes(`Hoppers: + ${hopper.name}`), `${layout}: the window lists “Hoppers: + …”`);
    await s.clearNotices();
    await s.clickModal("Send draft");
    check(Boolean(await s.waitNotice(/Draft sent to the Studio \(/)), `${layout}: the notice says the draft was sent`);
    check(Boolean(await s.waitNotice(`added to “${hopper.name}”`)), `${layout}: ... and that the item was added to the hopper`);
    const id = await s.stamped(path);
    check(Boolean(id), `${layout}: the note is stamped (${id || "none"})`);
    if (!id) return;
    check(Boolean(await s.stamped(path, "blyg_hoppers_sent")), `${layout}: the note remembers what it sent (blyg_hoppers_sent)`);
    check(await inHopper(hopper.id, id), `${layout}: the Studio holds the item in the hopper`);

    // §4 take it out from the note
    check(await s.clickPanel("Hoppers…"), `${layout}: Hoppers… again`);
    check(await s.waitModal("Hoppers for this note"), `${layout}: the window opens again`);
    check((await s.switchIsOn(hopper.name)) === true, `${layout}: its switch starts on`);
    await s.toggleInModal(hopper.name);
    await s.clickModal("Save");
    await s.modalClosed();
    await wait(500);
    await s.clearNotices();
    check(await s.clickPanel("Send draft"), `${layout}: Send draft after taking it out`);
    check(Boolean(await s.waitNotice(`taken out of “${hopper.name}”`)), `${layout}: the notice says it was taken out of the hopper`);
    check(Boolean(await s.waitNotice("The text has no changes")), `${layout}: ... and that the text has no changes (no new version)`);
    check(!(await s.modalOpen()), `${layout}: no window was asked for (only the hoppers changed)`);
    check(!(await inHopper(hopper.id, id)), `${layout}: the Studio no longer holds the item in the hopper`);

    // §5 a change made in the Studio is kept
    check(await s.clickPanel("Hoppers…"), `${layout}: put it back: Hoppers…`);
    check(await s.waitModal("Hoppers for this note"), `${layout}: the window opens`);
    await s.toggleInModal(hopper.name);
    await s.clickModal("Save");
    await s.modalClosed();
    await wait(500);
    await s.clearNotices();
    check(await s.clickPanel("Send draft"), `${layout}: Send draft (added again)`);
    check(Boolean(await s.waitNotice(`added to “${hopper.name}”`)), `${layout}: the notice says it was added to the hopper again`);
    check(await inHopper(hopper.id, id), `${layout}: the item is in the hopper again`);
    const removed = await s.studio(`/hoppers/${encodeURIComponent(hopper.id)}/items/${encodeURIComponent("~own")}/${encodeURIComponent(id)}`, { method: "DELETE" });
    check(removed.status === 200 || removed.status === 204, `${layout}: the item is taken out of the hopper in the Studio (HTTP ${removed.status})`);
    await s.refreshPanel(path);
    check(Boolean(await s.becomes(async () => (await s.panelFacts())["In the Studio"] === "in no hopper", 15000, "the panel to see it")), `${layout}: the panel shows “In the Studio: in no hopper”`);
    check((await s.panelButtons()).some((b) => b.text === "Use the Studio's hoppers"), `${layout}: ... and offers “Use the Studio's hoppers”`);
    await s.clearNotices();
    check(await s.clickPanel("Send draft"), `${layout}: Send draft without changing anything`);
    check(Boolean(await s.waitNotice("already has this text — nothing to send")), `${layout}: the send says there is nothing to send`);
    check(!(await s.notices()).some((t) => /added to “/.test(t)), `${layout}: ... and says nothing about adding it to the hopper`);
    check(!(await inHopper(hopper.id, id)), `${layout}: the item is NOT put back (the removal in the Studio stands)`);
    check(Boolean(await s.becomes(async () => JSON.stringify((await s.frontmatter(path))?.blyg_hoppers ?? []) === "[]", 15000, "blyg_hoppers to empty")), `${layout}: the note's blyg_hoppers is now empty`);

    // §6 a wrong name is refused and stays in the property, also right after typing (the 0.7.0 retest)
    const typed = await withHoppersProperty(path, "Nope");
    await s.clearNotices();
    // The 0.7.0 retest: the property is written and the command started in the same tick, while Obsidian's cache still says what it said before
    // (the cache lag is SIMULATED, see lib.mjs: the plugin must read the property from the file).
    await s.staleCache(path);
    await s.writeThenCommand(path, typed, "blyg:publish-active-note");
    const refusal = await s.waitNotice(/there is no hopper “Nope”/);
    check(Boolean(refusal), `${layout}: refused: there is no hopper “Nope”`);
    check(refusal.includes(hopper.name), `${layout}: ... with the list of the hoppers`);
    await s.freshCache();
    check(!(await s.modalOpen()), `${layout}: ... and no window opened (nothing was sent)`);
    check((await s.readNote(path)).includes("blyg_hoppers: Nope"), `${layout}: “Nope” is still in the property`);
    await s.writeNote(path, (await s.readNote(path)).replace(/\n*$/, "\n") + "One more word.\n");
    await s.clearNotices();
    check(await s.clickPanel("Send draft"), `${layout}: Send draft with “Nope” and a changed text`);
    check(Boolean(await s.waitNotice(/there is no hopper “Nope”/)), `${layout}: refused again`);
    check((await s.readNote(path)).includes("blyg_hoppers: Nope"), `${layout}: “Nope” is still in the property`);
    await setHoppersProperty(path, null);
  }

  await round("desktop");
  if (!process.env.E2E_DESKTOP_ONLY) {
    await s.phone();
    await round("phone layout");
  }

  // §7 clean up
  const gone = await s.studio(`/hoppers/${encodeURIComponent(hopper.id)}`, { method: "DELETE" });
  check(gone.status === 200 || gone.status === 204, `the test hopper is deleted in the Studio (HTTP ${gone.status})`);
});
