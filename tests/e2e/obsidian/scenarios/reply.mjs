// P6 slice D (docs/plans/P6-ui-regression.md): replies (S10) in real Obsidian, desktop and phone layout: "Reply to item" starts a thread that quotes the item
// and carries `blyg_stub_of`; "Make reply" marks an existing thread; both show the "Stub" row on the panel. Replaces by a machine what T1 R5 /
// S10-DEVICE-TEST.md §1, §2 and §4 do by hand (the refusals of §3/§5 are covered by unit tests). The reply to an item of another blyg needs
// `WITH_REMOTE=1 scripts/local-studio.sh start`.
//
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/reply.mjs
import { STUDIO, fixtureData, runScenario } from "../lib.mjs";

const base = fixtureData();
const data = { ...base, routes: [...base.routes, { vaultPrefix: "Publish/", mode: "studio", label: "Blyg item" }] };

await runScenario({ data }, async (s) => {
  const { check } = s;
  const stamp = Date.now().toString(36);
  const made = await s.studio("/items", { method: "POST", body: JSON.stringify({ mode: "blank", kind: "fragment", contentMd: `Reply target ${stamp}. Something to answer.` }) });
  const ownId = made.json?.id;
  const rev = (await s.studioItem(ownId)).json?.revision;
  const pub = await s.studio(`/items/${encodeURIComponent(ownId)}/publish`, { method: "POST", body: JSON.stringify({ expectedRevision: rev }) });
  check(made.status === 201 && pub.status === 200, `an item to answer is published in the Studio (HTTP ${made.status}, ${pub.status})`);
  const imported = (await s.studio("/search?source=imported&limit=5")).json?.items?.[0];
  if (!imported) console.log("skip the reply to a blyg you read: the Studio holds no imported item (WITH_REMOTE=1 scripts/local-studio.sh start)");

  /** The note the plugin just made is the active one: wait for it and return its path. */
  const newNote = async (before) => s.becomes(async () => { const p = await s.activePath(); return p && p !== before ? p : false; }, 15000, "the new note");

  async function round(layout) {
    const tag = layout === "desktop" ? "desktop" : "phone";
    const seed = `Publish/Reply seed ${tag}.md`;
    await s.createNote(seed, "A note to start from.");
    check(await s.openNote(seed), `${layout}: the panel follows a note in the Studio folder`);

    // Reply to item, by a pasted address (S10 §1/§2): a new thread that starts with the quote, and the Stub row
    check(await s.clickPanel("Reply to item"), `${layout}: the panel offers “Reply to item”`);
    check(Boolean(await s.becomes(() => s.pickerOpen(), 10000, "the picker")), `${layout}: the picker opens`);
    await s.clearNotices();
    await s.typeInPicker(`${STUDIO}/f/${ownId}/`);
    check(await s.pickerHas(`Reply target ${stamp}`), `${layout}: the pasted address finds the item`);
    await s.pickItem(`Reply target ${stamp}`);
    const reply = await newNote(seed);
    check(Boolean(reply), `${layout}: a new note is made and opened (${reply || "none"})`);
    if (reply) {
      check(Boolean(await s.waitNotice(/New thread, a reply to/)), `${layout}: the notice says it is a reply`);
      const fm = await s.becomes(async () => (await s.frontmatter(reply))?.blyg_stub_of, 15000, "blyg_stub_of");
      check(Boolean(fm) && fm.id === ownId && fm.version === 1 && typeof fm.origin === "string", `${layout}: blyg_stub_of holds origin, id and version of the item (${JSON.stringify(fm)})`);
      check((await s.frontmatter(reply))?.blyg_kind === "thread", `${layout}: the note is a thread`);
      check((await s.editorText(reply)).includes(`![[${ownId}`), `${layout}: it starts with a quote of the item`);
      await s.openNote(reply);
      check(Boolean(await s.becomes(async () => /^a reply to /.test((await s.panelFacts()).Stub ?? ""), 15000, "the Stub row")), `${layout}: the panel's Stub row says “a reply to …” (${(await s.panelFacts()).Stub ?? "no row"})`);
    }

    // Reply to an item of a blyg you read (R5)
    if (imported) {
      await s.openNote(seed);
      check(await s.clickPanel("Reply to item"), `${layout}: Reply to item again`);
      await s.becomes(() => s.pickerOpen(), 10000, "the picker");
      await s.typeInPicker("remote fragment");
      check(await s.pickerHas("Blog B"), `${layout}: the words find the item of the blyg you read`);
      await s.pickItem("Blog B");
      const remote = await newNote(seed);
      check(Boolean(remote), `${layout}: another new note is made`);
      if (remote) {
        const fm = await s.becomes(async () => (await s.frontmatter(remote))?.blyg_stub_of, 15000, "blyg_stub_of");
        check(Boolean(fm) && fm.id === imported.id && !String(fm.origin).startsWith(STUDIO), `${layout}: blyg_stub_of points at the other blyg's item (${JSON.stringify(fm)?.slice(0, 120)})`);
      }
    }

    // Make reply (S10 §4): an existing, unpublished thread names the item it answers; a fragment has no such button
    const thread = `Publish/Reply thread ${tag}.md`;
    await s.createNote(thread, "---\nblyg_kind: thread\n---\nMy own words first.\n");
    check(await s.openNote(thread), `${layout}: the panel follows a thread`);
    check(!(await s.panelFacts()).Stub, `${layout}: a plain thread shows no Stub row`);
    check(await s.clickPanel("Make reply"), `${layout}: the panel offers “Make reply”`);
    await s.becomes(() => s.pickerOpen(), 10000, "the picker");
    await s.clearNotices();
    await s.typeInPicker(`Reply target ${stamp}`);
    check(await s.pickerHas(`Reply target ${stamp}`), `${layout}: the words find the item`);
    await s.pickItem(`Reply target ${stamp}`);
    check(Boolean(await s.waitNotice(/This thread is now a reply to/)), `${layout}: the notice says the thread is now a reply`);
    const marked = await s.becomes(async () => (await s.frontmatter(thread))?.blyg_stub_of, 15000, "blyg_stub_of");
    check(Boolean(marked) && marked.id === ownId, `${layout}: blyg_stub_of is written`);
    check((await s.readNote(thread)).includes("My own words first."), `${layout}: the text is untouched`);
    await s.refreshPanel(thread);
    check(Boolean(await s.becomes(async () => /^a reply to /.test((await s.panelFacts()).Stub ?? ""), 15000, "the Stub row")), `${layout}: the panel's Stub row says “a reply to …”`);
    await s.openNote(seed);
    check(!(await s.panelButtons()).some((b) => b.text === "Make reply"), `${layout}: a fragment has no “Make reply” button`);
  }

  await round("desktop");
  if (!process.env.E2E_DESKTOP_ONLY) {
    await s.phone();
    await round("phone layout");
  }
});
