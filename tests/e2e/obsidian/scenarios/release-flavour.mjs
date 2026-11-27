// Release 1.1.0: what the RELEASE flavour (manifest id `blyg`, the build this harness loads) offers with NO feature switches in data.json, as a user who never opened
// "Experimental features" sees it. The promoted features (Daily and its AI layer, Save for later, Marginalia) are on without a switch; the features that stay experimental
// (send passage to note and drafting, new items from a thread, open a shared address) and the dev-only ones are absent (off means absent: fail closed).
//   STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… node tests/e2e/obsidian/scenarios/release-flavour.mjs
import { fixtureData, runScenario } from "../lib.mjs";

const data = fixtureData();
delete data.features; // no switches at all

await runScenario({ data }, async (s) => {
  const { check } = s;
  const ids = await s.commandIds("blyg:");
  const has = (id) => ids.includes(`blyg:${id}`);
  for (const id of ["open-daily", "show-digest-sent", "clear-digest-requests"]) check(has(id), `promoted, on without a switch: the command ${id} exists`);
  for (const id of ["send-passage-to-note", "publish-paragraph", "open-address-from-clipboard", "dev-author-look", "dev-draw-synthetic-posts"]) check(!has(id), `not promoted: the command ${id} is absent`);
  const plugin = await s.page.evaluate(() => {
    const p = window.app.plugins.plugins.blyg;
    return p ? { id: p.manifest.id, features: ["daily", "digest-ai", "shelf", "marginalia", "passages", "tangle", "share-open"].map((f) => [f, p.features.enabled(f)]) } : null;
  });
  check(plugin?.id === "blyg", "the loaded plugin is the release flavour (manifest id blyg, not blyg-dev)");
  const on = Object.fromEntries(plugin?.features ?? []);
  for (const f of ["daily", "digest-ai", "shelf", "marginalia"]) check(on[f] === true, `feature ${f} is on in the release flavour with no switch`);
  for (const f of ["passages", "tangle", "share-open"]) check(on[f] === false, `feature ${f} is off in the release flavour with no switch`);
});
