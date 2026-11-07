// P6 slice A (docs/plans/P6-ui-regression.md): the publish loop of a drafts-only Studio folder, in real Obsidian, desktop and phone layout.
// Replaces by a machine what T1 F3/F4/S1/S2/R10 and RC2 §1/§2 do by hand: Check connection, the publish window, "Draft sent" / "Draft updated" /
// "nothing to send", deleting the draft, and the Advanced switch keeping the GitHub values (with the repost commands listed only for a GitHub setup).
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/publish-loop.mjs
import { fixtureData, runScenario, wait } from "../lib.mjs";

await runScenario({}, async (s) => {
  const { check } = s;

  async function loop(layout) {
    const tag = layout === "desktop" ? "desktop" : "phone";
    const path = `Blyg/Loop ${tag}.md`;
    const first = `The first words of the ${tag} loop. A second sentence for the diff.`;

    // F3: Check connection
    await s.command("blyg:check-studio-connection");
    const report = await s.waitNotice(/✓|✗/, 30000);
    check(report.includes("✓") && !report.includes("✗"), `${layout}: Check connection reports no error (${report.split("\n")[0] || "no notice"})`);

    // F4 / S1: the panel offers "Send draft"; the window says nothing goes live; confirming stamps the note and the Studio holds the draft
    await s.createNote(path, first);
    check(await s.openNote(path), `${layout}: the panel follows the new note`);
    check((await s.panelFacts()).Route?.startsWith("Blyg item"), `${layout}: the panel names the route (${(await s.panelFacts()).Route ?? "nothing"})`);
    check(await s.clickPanel("Send draft"), `${layout}: the panel's button says “Send draft”`);
    check(await s.waitModal("Send a draft to your Studio"), `${layout}: the window is titled “Send a draft to your Studio”`);
    const sheet = await s.modalText();
    check(/draft only, nothing goes live/.test(sheet), `${layout}: the window says nothing goes live`);
    check(sheet.includes("New text") && sheet.includes("The first words"), `${layout}: the window shows the new text`);
    await s.clearNotices();
    await s.clickModal("Send draft");
    const sent = await s.waitNotice(/Draft sent to the Studio \(/);
    check(Boolean(sent), `${layout}: the notice says “Draft sent to the Studio”`);
    const id = await s.stamped(path);
    check(Boolean(id), `${layout}: the note is stamped with blyg_id (${id || "none"})`);
    const item = id ? await s.studioItem(id) : { status: 0, json: null };
    check(item.status === 200 && item.json?.status === "draft" && String(item.json?.contentMd).includes("The first words"), `${layout}: the Studio holds the text as a draft (HTTP ${item.status}, ${item.json?.status})`);
    check(Boolean(await s.becomes(async () => (await s.panelFacts()).Id === id, 15000, "the Id")), `${layout}: the panel shows the Id`);

    // S1: edit and send again
    const current = await s.readNote(path);
    await s.writeNote(path, `${current.replace(/\n*$/, "\n")}A third sentence, added later.\n`);
    check((await s.readNote(path)).includes("A third sentence"), `${layout}: the note was edited`);
    await s.becomes(async () => (await s.panelFacts()).Note !== undefined, 5000, "the panel");
    await wait(1000);
    check(await s.clickPanel("Send draft"), `${layout}: the panel offers “Send draft” again after an edit`);
    check(await s.waitModal("Send a draft to your Studio"), `${layout}: the window opens again`);
    check(/Changes: \+\d+ word/.test(await s.modalText()), `${layout}: the window shows the changes as words added`);
    await s.clearNotices();
    await s.clickModal("Send draft");
    // a draft that was never published says "Draft sent" again (the line "working copy … now has this text" is for an item with a published version: slice B)
    const again = await s.waitNotice(/Draft sent to the Studio \(/);
    check(again.includes(id), `${layout}: the second send names the same item (${id}), not a new one`);
    const after = id ? await s.studioItem(id) : { json: null };
    check(String(after.json?.contentMd).includes("A third sentence"), `${layout}: the Studio holds the edited text`);

    // nothing changed → nothing to send (no new draft)
    check(await s.clickPanel("Send draft"), `${layout}: the button is still there`);
    await s.clearNotices();
    check(Boolean(await s.waitNotice("already has this text")), `${layout}: sending an unchanged note says there is nothing to send`);
    check(!(await s.modalOpen()), `${layout}: ... and opens no window`);

    // S2 / R10: delete the draft
    check(await s.clickPanel("Delete draft"), `${layout}: the panel offers “Delete draft”`);
    check(await s.waitModal("Delete this draft"), `${layout}: the window is titled “Delete this draft”`);
    check(/deletes the draft from the Studio for good/.test(await s.modalText()), `${layout}: the window says the deletion is for good and the note keeps its text`);
    await s.clearNotices();
    await s.clickModal("Delete draft");
    check(Boolean(await s.waitNotice(/Draft .* deleted from the Studio/)), `${layout}: the notice says the draft was deleted`);
    const gone = id ? await s.studioItem(id) : { status: 0 };
    check(gone.status === 404, `${layout}: the Studio no longer has the item (HTTP ${gone.status})`);
    const text = await s.readNote(path);
    check(text.includes("A third sentence") && !text.includes("blyg_id"), `${layout}: the note keeps its text and lost its blyg_id`);
  }

  // RC2 §1 / §2: the Advanced switch keeps the GitHub values; the repost commands exist only with a GitHub setup
  async function advanced(layout) {
    const base = fixtureData();
    check((await s.commandIds("blyg:repost-to-studio")).length === 0, `${layout}: a Studio-only setup lists no “repost” command`);
    await s.withData({ ...base, github: { owner: "someone", repo: "site", branch: "main", previewBranch: "preview", useBranch: "production", tokenSecretName: "smoke-github", watchDeploy: true }, blyg: { origin: "https://example.com/blyg/" } });
    check((await s.commandIds("blyg:repost-to-studio")).length === 1 && (await s.commandIds("blyg:list-reposted-items")).length === 1, `${layout}: a GitHub setup lists both repost commands`);
    const inDom = (sel) => s.evaluate((q) => Boolean(activeDocument.querySelector(q)), sel);
    const text = () => s.evaluate(() => activeDocument.querySelector(".modal.mod-settings")?.textContent ?? "");
    await s.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("blyg"); });
    check(Boolean(await s.becomes(async () => /GitHub owner/.test(await text()), 15000, "the GitHub settings")), `${layout}: the GitHub settings are shown`);
    const owner = () => s.evaluate(() => {
      const row = [...activeDocument.querySelectorAll(".modal.mod-settings .setting-item")].find((r) => /GitHub owner/.test(r.querySelector(".setting-item-name")?.textContent ?? ""));
      return row?.querySelector("input")?.value ?? null;
    });
    check((await owner()) === "someone", `${layout}: the GitHub owner field holds its value`);
    const toggle = () => s.evaluate(() => {
      const row = [...activeDocument.querySelectorAll(".modal.mod-settings .setting-item")].find((r) => /Also publish to a GitHub-hosted site/.test(r.textContent ?? ""));
      row?.querySelector(".checkbox-container")?.click();
    });
    await toggle();
    check(Boolean(await s.becomes(async () => !/GitHub owner/.test(await text()), 10000, "the fields to go")), `${layout}: switching off hides the GitHub fields`);
    await toggle();
    check(Boolean(await s.becomes(async () => /GitHub owner/.test(await text()), 10000, "the fields to come back")), `${layout}: switching on shows them again`);
    check((await owner()) === "someone", `${layout}: ... with the same value as before (nothing was deleted)`);
    await s.evaluate(() => { window.app.setting.close(); });
    await s.becomes(async () => !(await inDom(".modal.mod-settings")), 10000, "Settings to close");
    await wait(1500);
    await s.withData(base);
  }

  await loop("desktop");
  await advanced("desktop");
  await s.phone();
  await loop("phone layout");
  await advanced("phone layout");
});
