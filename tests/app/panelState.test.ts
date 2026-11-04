import { describe, expect, it } from "vitest";
import { computePanelState, deployLine, itemUrl, loadPanelState, localContentHash, summarizeThreadText, type LocalBlygFrontmatter, type PanelInput } from "../../src/app/panelState";
import { contentHash } from "../../src/core/hash";
import type { NoteRef, VaultPort } from "../../src/platform/ports";
import { defaultSettings, type BlygSettings } from "../../src/settings/schema";
import { MACRO_ROUTES } from "../world";

const ID = "7c9wk2mhq0v3xj8tn5rzfd41bg";
const note = (path: string, extension = "md"): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension });
const BLYG = note("website/blyg/Note.md");

function settings(over: Partial<BlygSettings["github"]> = {}, blyg: Partial<BlygSettings["blyg"]> = {}): BlygSettings {
  const s = defaultSettings();
  s.github = { ...s.github, owner: "o", repo: "r", ...over };
  s.blyg = { ...s.blyg, origin: "https://example.com/blyg/", previewOrigin: "https://preview.example.com/blyg/", ...blyg };
  s.routes = MACRO_ROUTES;
  return s;
}

const state = (over: Partial<PanelInput> & { fm?: LocalBlygFrontmatter } = {}) =>
  computePanelState({ settings: settings(), note: BLYG, frontmatter: over.fm ?? {}, localHash: "sha256:aaa", ...over });

describe("localContentHash", () => {
  it("is the hash a publish would compute: frontmatter and comments do not count, line endings do not matter", async () => {
    const plain = await contentHash("Hello world");
    expect(await localContentHash("---\nblyg_id: x\n---\n\nHello world\n")).toBe(plain);
    expect(await localContentHash("Hello world\r\n")).toBe(plain);
    expect(await localContentHash("Hello world %%private%%\n")).toBe(plain);
  });
  it("is null for an unclosed comment (the rest might be private)", async () => {
    expect(await localContentHash("Hello %% never closed")).toBeNull();
  });
});

describe("panel state: the Blyg route", () => {
  it("no note → says so, nothing to press", () => {
    const s = state({ note: null });
    expect(s.status).toBe("no-note");
    expect([s.canPublish, s.canWithdraw, s.canOpenWeb]).toEqual([false, false, false]);
  });

  it("a note outside every route → refused wording, nothing to press (fail closed)", () => {
    const s = state({ note: note("Daily/2026-10-07.md") });
    expect(s.status).toBe("no-route");
    expect(s.canPublish).toBe(false);
    expect(s.notes.join(" ")).toContain("website/blyg/");
  });

  it("an image in a publish folder is not a note", () => {
    const s = state({ note: note("website/blyg/pic.png", "png") });
    expect(s.status).toBe("not-markdown");
    expect(s.canPublish).toBe(false);
  });

  it("no id → not published; publish yes, withdraw no", () => {
    const s = state();
    expect(s.status).toBe("not-published");
    expect([s.canPublish, s.canWithdraw, s.canOpenWeb]).toEqual([true, false, false]);
    expect(s.item).toBeUndefined();
  });

  it("an id that is not a valid id → refused, with a reason", () => {
    const s = state({ fm: { id: "../../x" } });
    expect(s.status).toBe("invalid-id");
    expect(s.canPublish).toBe(false);
  });

  it("hash equals the stamped hash → in sync, with id, version and dates (timestamps as text or as Date)", () => {
    const s = state({
      localHash: "sha256:abc",
      fm: { id: ID, version: 3, hash: "sha256:abc", created: "2026-10-01T10:32:16.835Z", updated: new Date("2026-10-05T08:00:00.000Z") },
    });
    expect(s.status).toBe("in-sync");
    expect(s.headline).toContain("v3");
    expect(s.item).toEqual({ id: ID, version: 3, created: "2026-10-01T10:32:16.835Z", updated: "2026-10-05T08:00:00.000Z" });
    expect([s.canPublish, s.canWithdraw, s.canOpenWeb]).toEqual([true, true, true]);
    expect(s.webUrl).toBe(`https://example.com/blyg/f/${ID}/`);
  });

  it("a different hash → local changes", () => {
    const s = state({ localHash: "sha256:new", fm: { id: ID, version: 3, hash: "sha256:old" } });
    expect(s.status).toBe("local-changes");
  });

  it("a stamped hash that is not text counts as changed, never as in sync", () => {
    expect(state({ localHash: "sha256:x", fm: { id: ID, version: 1, hash: 42 } }).status).toBe("local-changes");
  });

  it("a damaged version is not shown as a number", () => {
    const s = state({ fm: { id: ID, version: "three", hash: "sha256:aaa" } });
    expect(s.item?.version).toBeNull();
    expect(s.headline).not.toContain("(v");
  });

  it("withdrawn wins over the hash (the endcap's hash is the empty text's); publishing un-withdraws, withdrawing again is not offered", () => {
    const s = state({ localHash: "sha256:aaa", fm: { id: ID, version: 4, hash: "sha256:aaa", withdrawn: true } });
    expect(s.status).toBe("withdrawn");
    expect([s.canPublish, s.canWithdraw]).toEqual([true, false]);
  });

  it("an unclosed comment → text cannot be published, publish not offered", () => {
    const s = state({ localHash: null, fm: { id: ID, version: 2, hash: "sha256:aaa" } });
    expect(s.status).toBe("unreadable-text");
    expect(s.canPublish).toBe(false);
  });

  it("a preview note while the target is production → blocked, same as the service", () => {
    const s = state({ fm: { id: ID, version: 2, hash: "sha256:aaa", channel: "preview" } });
    expect(s.status).toBe("preview-note");
    expect([s.canPublish, s.canWithdraw, s.canOpenWeb]).toEqual([false, false, false]);
  });

  it("the same note with the target on preview → normal state, preview address", () => {
    const s = computePanelState({
      settings: settings({ useBranch: "preview" }),
      note: BLYG,
      frontmatter: { id: ID, version: 2, hash: "sha256:aaa", channel: "preview" },
      localHash: "sha256:aaa",
    });
    expect([s.status, s.channel, s.branch]).toEqual(["in-sync", "preview", "preview"]);
    expect(s.webUrl).toBe(`https://preview.example.com/blyg/f/${ID}/`);
  });

  it("a production note (no marker) while the target is preview → says it was published on production, claims nothing about preview", () => {
    const s = computePanelState({
      settings: settings({ useBranch: "preview" }),
      note: BLYG,
      frontmatter: { id: ID, version: 2, hash: "sha256:aaa" },
      localHash: "sha256:aaa",
    });
    expect([s.status, s.ok, s.headline]).toEqual(["production-note", false, "Published on production (v2)."]);
    expect(s.notes[0]).toContain("only works if that branch already has this item");
    expect([s.canPublish, s.publishLabel, s.emphasizePublish]).toEqual([true, "Update", false]);
  });

  it("in test mode every status says 'on preview'; on production none mentions it", () => {
    const fmPreview = { id: ID, version: 10, hash: "sha256:aaa", channel: "preview" };
    const prev = (fm: LocalBlygFrontmatter, localHash = "sha256:aaa") =>
      computePanelState({ settings: settings({ useBranch: "preview" }), note: BLYG, frontmatter: fm, localHash });
    expect(prev(fmPreview).headline).toBe("Published on preview (v10) and up to date.");
    expect(prev(fmPreview, "sha256:new").headline).toBe("Published on preview (v10), with changes not sent yet.");
    expect(prev({ ...fmPreview, withdrawn: true }).headline).toBe("Withdrawn on preview (v10).");
    const prod = state({ fm: { id: ID, version: 10, hash: "sha256:aaa" } });
    expect(prod.headline).toBe("Published (v10) and up to date.");
    const essayPreview = computePanelState({
      settings: { ...settings({ useBranch: "preview" }), routes: [{ vaultPrefix: "website/essays/", mode: "plain" as const, dest: "src/content/essays/", label: "essay" }] },
      note: note("website/essays/E.md"),
      frontmatter: {},
      localHash: "sha256:a",
      plainRecord: { hash: "sha256:a", at: "t" },
    });
    expect(essayPreview.headline).toBe("Essay: published on preview and up to date.");
  });

  it("the deploy box belongs to the note that owns the committed file: the item file for a Blyg note, the repo file for an essay", () => {
    expect(state({ fm: { id: ID, version: 1, hash: "sha256:aaa" } }).deployPath).toBe(`src/content/notes/${ID}.md`);
    expect(state().deployPath).toBeUndefined();
    expect(state({ note: note("Daily/D.md") }).deployPath).toBeUndefined();
    expect(state({ note: note("website/essays/Essay.md") }).deployPath).toBe("src/content/essays/Essay.md");
  });

  it("no address in the settings → no web link", () => {
    const s = computePanelState({
      settings: settings({}, { origin: "" }),
      note: BLYG,
      frontmatter: { id: ID, version: 1, hash: "sha256:aaa" },
      localHash: "sha256:aaa",
    });
    expect(s.canOpenWeb).toBe(false);
    expect(s.webUrl).toBeUndefined();
  });

  it("itemUrl adds the slash an address may lack", () => {
    expect(itemUrl(settings({}, { origin: "https://example.com/blyg" }), ID)).toBe(`https://example.com/blyg/f/${ID}/`);
  });
});

describe("panel wording: one line per state, and why a link is missing", () => {
  const essayIn = (webUrl: string | undefined, over: Partial<PanelInput> = {}, mut: (s: BlygSettings) => void = () => {}) => {
    const st = { ...settings(), routes: [{ vaultPrefix: "website/essays/", mode: "plain" as const, dest: "src/content/essays/", label: "essay", ...(webUrl !== undefined ? { webUrl } : {}) }] };
    mut(st);
    return computePanelState({ settings: st, note: note("website/essays/E.md"), frontmatter: {}, localHash: "sha256:a", plainRecord: { hash: "sha256:a", at: "t" }, ...over });
  };

  it("every state gives one short instruction line (two only when a preview warning comes with it)", () => {
    const all = [
      state({ note: null }),
      state({ note: note("Daily/D.md") }),
      state({ note: note("website/blyg/p.png", "png") }),
      state(),
      state({ fm: { id: "../x" } }),
      state({ fm: { id: ID, version: 1, hash: "sha256:aaa" } }),
      state({ fm: { id: ID, version: 1, hash: "sha256:old" } }),
      state({ fm: { id: ID, version: 1, hash: "sha256:aaa", withdrawn: true } }),
      state({ localHash: null, fm: { id: ID, version: 1, hash: "sha256:aaa" } }),
      state({ fm: { id: ID, version: 1, hash: "sha256:aaa", channel: "preview" } }),
      essayIn(undefined),
      essayIn(undefined, { plainRecord: null }),
      essayIn(undefined, { localHash: "sha256:b" }),
      essayIn(undefined, { localHash: null }),
    ];
    for (const s of all) {
      expect(s.notes.length, s.status).toBe(1);
      expect(s.notes[0]?.length ?? 0, s.status).toBeLessThan(120);
      expect(s.headline.length, s.status).toBeLessThan(70);
    }
  });

  it("the notes tell the user what to do next, per state and per route", () => {
    const note1 = (s: ReturnType<typeof state>) => s.notes[0] ?? "";
    expect(note1(state())).toBe("Tap Publish to send it as version 1.");
    expect(note1(state({ fm: { id: ID, version: 1, hash: "sha256:aaa" } }))).toContain("tap Update");
    expect(note1(state({ fm: { id: ID, version: 1, hash: "sha256:old" } }))).toContain("review the changes");
    expect(note1(state({ fm: { id: ID, version: 4, hash: "sha256:aaa", withdrawn: true } }))).toContain("as v5");
    expect(note1(essayIn(undefined, { plainRecord: null }))).toContain("compare it with the site");
    expect(note1(essayIn(undefined))).toContain("tap Update");
    expect(essayIn(undefined).headline).toBe("Essay: published and up to date.");
    expect(state({ fm: { id: ID, version: 3, hash: "sha256:aaa" } }).headline).toBe("Published (v3) and up to date.");
  });

  it("no web address on an essay route → a one-line hint says where to set it", () => {
    expect(essayIn(undefined).hint).toContain("set a “Web address” for this route in Settings → Blyg");
    expect(essayIn("").hint).toContain("Web address");
  });

  it("a malformed web address or a missing Blyg address is named as the reason", () => {
    expect(essayIn("{site}/{title}/").hint).toContain("not valid");
    expect(essayIn("{site}/essays/{slug}/", {}, (st) => (st.blyg.origin = "")).hint).toContain("set the Blyg address");
    expect(essayIn("{site}/essays/{slug}/", {}, (st) => ((st.blyg.previewOrigin = ""), (st.github.useBranch = "preview"))).hint).toContain("set the preview Blyg address");
  });

  it("with a working link there is no hint", () => {
    const s = essayIn("{site}/essays/{slug}/");
    expect([s.hint, s.webUrl]).toEqual([undefined, "https://example.com/essays/e/"]);
  });

  it("a published Blyg item without a Blyg address gets the hint; with one, none", () => {
    const fm = { id: ID, version: 1, hash: "sha256:aaa" };
    const without = computePanelState({ settings: settings({}, { origin: "" }), note: BLYG, frontmatter: fm, localHash: "sha256:aaa" });
    expect(without.hint).toBe("To get a link, set the Blyg address in Settings → Blyg.");
    expect(state({ fm }).hint).toBeUndefined();
    expect(state().hint).toBeUndefined();
  });
});

describe("panel state: plain routes", () => {
  it("Withdraw and Open on web are drawn for Blyg items only", () => {
    expect([state().showWithdraw, state().showOpenWeb]).toEqual([true, true]);
    const plain = state({ note: note("website/essays/E.md") });
    expect([plain.showWithdraw, plain.showOpenWeb]).toEqual([false, false]);
    const outside = state({ note: note("Daily/D.md") });
    expect([outside.showWithdraw, outside.showOpenWeb]).toEqual([false, false]);
  });

  it("the main button follows the state: Publish, Update once published, Publish again after a withdrawal", () => {
    const btn = (s: ReturnType<typeof state>) => [s.publishLabel, s.emphasizePublish, s.ok];
    expect(btn(state())).toEqual(["Publish", true, false]);
    expect(btn(state({ fm: { id: ID, version: 1, hash: "sha256:aaa" } }))).toEqual(["Update", false, true]);
    expect(btn(state({ fm: { id: ID, version: 1, hash: "sha256:old" } }))).toEqual(["Update", true, false]);
    expect(btn(state({ fm: { id: ID, version: 1, hash: "sha256:aaa", withdrawn: true } }))).toEqual(["Publish again", true, false]);
  });

  const essayRoute = (webUrl?: string) => ({
    ...settings(),
    routes: [{ vaultPrefix: "website/essays/", mode: "plain" as const, dest: "src/content/essays/", label: "essay", ...(webUrl ? { webUrl } : {}) }],
  });
  const essay = (over: Partial<PanelInput> = {}) =>
    computePanelState({ settings: essayRoute(), note: note("website/essays/Wrestling With Eels.md"), frontmatter: {}, localHash: "sha256:a", ...over });

  it("an essay the plugin has no record of → 'not known', publish only, the repo path shown", () => {
    const s = essay();
    expect(s.status).toBe("plain-unknown");
    expect(s.repoPath).toBe("src/content/essays/Wrestling With Eels.md");
    expect([s.canPublish, s.canWithdraw, s.canOpenWeb]).toEqual([true, false, false]);
    expect(s.published).toBeUndefined();
  });

  it("an essay whose record matches → published; a different hash → changed; both show when it was last published", () => {
    const rec = { hash: "sha256:a", at: "2026-10-05T08:00:00.000Z" };
    const same = essay({ plainRecord: rec });
    expect([same.status, same.published]).toEqual(["plain-in-sync", { at: rec.at }]);
    expect(same.headline).toContain("Essay: published");
    expect([same.publishLabel, same.emphasizePublish, same.ok]).toEqual(["Update", false, true]);
    const unknown = essay();
    expect([unknown.publishLabel, unknown.emphasizePublish, unknown.ok]).toEqual(["Publish", true, false]);
    const changed = essay({ plainRecord: rec, localHash: "sha256:b" });
    expect([changed.status, changed.published]).toEqual(["plain-changed", { at: rec.at }]);
  });

  it("an essay with an unclosed comment cannot be published", () => {
    const s = essay({ localHash: null, plainRecord: { hash: "sha256:a", at: "t" } });
    expect([s.status, s.canPublish]).toEqual(["unreadable-text", false]);
  });

  it("Open on web for essays: only when the route has a web address, with the site taken from the active target's Blyg address", () => {
    expect(essay().showOpenWeb).toBe(false);
    const withUrl = computePanelState({
      settings: essayRoute("{site}/essays/{slug}/"),
      note: note("website/essays/Wrestling With Eels.md"),
      frontmatter: {},
      localHash: "sha256:a",
      plainRecord: { hash: "sha256:a", at: "t" },
    });
    expect([withUrl.showOpenWeb, withUrl.canOpenWeb, withUrl.webUrl]).toEqual([true, true, "https://example.com/essays/wrestling-with-eels/"]);
    const onPreview = computePanelState({
      settings: { ...essayRoute("{site}/essays/{slug}/"), github: { ...settings().github, useBranch: "preview" } },
      note: note("website/essays/Wrestling With Eels.md"),
      frontmatter: {},
      localHash: "sha256:a",
    });
    expect(onPreview.webUrl).toBe("https://preview.example.com/essays/wrestling-with-eels/");
  });

  it("a web address that cannot be filled (no Blyg address for {site}) shows the button, but disabled", () => {
    const s = computePanelState({
      settings: { ...essayRoute("{site}/essays/{slug}/"), blyg: { ...settings().blyg, origin: "" } },
      note: note("website/essays/E.md"),
      frontmatter: {},
      localHash: "sha256:a",
    });
    expect([s.showOpenWeb, s.canOpenWeb, s.webUrl]).toEqual([true, false, undefined]);
  });

  it("a route without a destination → unusable", () => {
    const s = computePanelState({
      settings: { ...settings(), routes: [{ vaultPrefix: "pages/", mode: "plain", label: "page" }] },
      note: note("pages/A.md"),
      frontmatter: {},
      localHash: null,
    });
    expect(s.status).toBe("plain-unusable");
    expect(s.canPublish).toBe(false);
  });
});

describe("panel deploy line", () => {
  const at = new Date("2026-10-07T12:00:00Z");
  it("nothing committed this session → no line", () => {
    expect(deployLine(null)).toBeNull();
  });
  it("while waiting", () => {
    expect(deployLine({ phase: "watching", branch: "main", version: 7 })).toEqual({ headline: "Checking the deploy of v7 on main…", detail: null, attention: false });
  });
  it("success is one quiet line", () => {
    const l = deployLine({ phase: "done", branch: "main", version: 7, kind: "deployed", text: "Deployed ✓ — …", attention: false, at });
    expect(l).toEqual({ headline: "v7 on main: Deployed", detail: null, attention: false });
  });
  it("a failure keeps the full explanation (the failed step, the next version)", () => {
    const text = "Checks failed ✗ — nothing went live. It stopped at the step “Check build”. …";
    const l = deployLine({ phase: "done", branch: "preview", version: 8, kind: "failed", text, attention: true, at });
    expect(l?.headline).toBe("v8 on preview: Checks failed ✗ — nothing went live");
    expect(l?.detail).toBe(text);
    expect(l?.attention).toBe(true);
  });
  it("an essay commit has no version in its line", () => {
    expect(deployLine({ phase: "watching", branch: "main" })?.headline).toBe("Checking the deploy of main…");
  });
});

describe("loadPanelState", () => {
  const fakeVault = (fm: Record<string, unknown>, text: string, reads = { n: 0 }): VaultPort => ({
    read: () => {
      reads.n++;
      return Promise.resolve(text);
    },
    blygId: () => fm.blyg_id,
    frontmatterValue: (_n, key) => fm[key],
    resolveLink: () => null,
    updateFrontmatter: () => Promise.resolve(),
  });

  it("compares the stamped hash with the text as it is now", async () => {
    const hash = await contentHash("Hello world");
    const fm = { blyg_id: ID, blyg_version: 2, blyg_hash: hash };
    expect((await loadPanelState({ settings: settings(), vault: fakeVault(fm, "---\nblyg_id: x\n---\n\nHello world\n") }, BLYG)).status).toBe("in-sync");
    expect((await loadPanelState({ settings: settings(), vault: fakeVault(fm, "Hello world, edited") }, BLYG)).status).toBe("local-changes");
  });

  it("reads the text of notes in the publish folders only (a Blyg note's quotes are counted from it since R3), never outside them", async () => {
    const reads = { n: 0 };
    await loadPanelState({ settings: settings(), vault: fakeVault({}, "x", reads) }, note("Daily/D.md"));
    await loadPanelState({ settings: settings(), vault: fakeVault({}, "x", reads) }, note("website/blyg/pic.png", "png"));
    expect(reads.n).toBe(0);
    await loadPanelState({ settings: settings(), vault: fakeVault({}, "x", reads) }, BLYG);
    await loadPanelState({ settings: settings(), vault: fakeVault({ blyg_id: ID, blyg_withdrawn: true }, "x", reads) }, BLYG);
    await loadPanelState({ settings: settings(), vault: fakeVault({}, "x", reads) }, note("website/essays/E.md"));
    expect(reads.n).toBe(3);
  });

  it("a note that cannot be read is shown as no note, not as an error", async () => {
    const vault = { ...fakeVault({ blyg_id: ID, blyg_hash: "h" }, ""), read: () => Promise.reject(new Error("gone")) };
    expect((await loadPanelState({ settings: settings(), vault }, BLYG)).status).toBe("no-note");
  });

  it("a text with an unclosed comment is flagged", async () => {
    const vault = fakeVault({ blyg_id: ID, blyg_version: 1, blyg_hash: "h" }, "text %% open");
    expect((await loadPanelState({ settings: settings(), vault }, BLYG)).status).toBe("unreadable-text");
  });
});

describe("threads in the panel", () => {
  const A = "7c9wk2mhq0v3xj8tn5rzfd41bg";
  const B = "1vgtgz0gq5b2c9k7d3m8r4n6xy";
  const vaultOf = (fm: Record<string, unknown>, text: string): VaultPort => ({
    read: () => Promise.resolve(text),
    blygId: () => fm.blyg_id,
    frontmatterValue: (_n, key) => fm[key],
    resolveLink: () => null,
    updateFrontmatter: () => Promise.resolve(),
  });
  const load = (fm: Record<string, unknown>, text: string, over: Partial<BlygSettings["github"]> = {}) =>
    loadPanelState({ settings: settings(over), vault: vaultOf(fm, text) }, BLYG);

  it("counts quotes, passages and item links in the note's text", async () => {
    const text = `Intro [[${B}]].\n\n![[${A}]]\n\n![[${A}]]\n> a passage\n`;
    expect(summarizeThreadText(text, "thread")).toEqual({ quotes: 2, passages: 1, links: 1, problems: [] });
    const s = await load({ blyg_kind: "thread" }, `---\nblyg_kind: thread\n---\n${text}`);
    expect(s).toMatchObject({ status: "not-published", kind: "thread", thread: { quotes: 2, passages: 1, links: 1 }, canPublish: true });
  });

  it("a fragment has a kind but no thread counts", async () => {
    const s = await load({}, "Plain words.");
    expect(s).toMatchObject({ status: "not-published", kind: "fragment" });
    expect(s.thread).toBeUndefined();
  });

  it("says what is wrong locally, with the same checks the publish makes first, and offers no Publish", async () => {
    const withCode = await load({ blyg_kind: "thread" }, `\`\`\`\ncode\n\`\`\`\n\n![[${A}]]\n`);
    expect(withCode).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(withCode.notes[0]).toMatch(/code block/);
    const fragmentQuoting = await load({}, `Words\n\n![[${A}]]\n`);
    expect(fragmentQuoting).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(fragmentQuoting.notes[0]).toMatch(/only a thread can do/);
  });

  it("a published thread keeps Withdraw even when its text has a problem", async () => {
    const fm = { blyg_kind: "thread", blyg_id: A, blyg_version: 2, blyg_hash: "h" };
    const s = await load(fm, `\`\`\`\n![[${B}]]\n\`\`\`\n`);
    expect(s).toMatchObject({ status: "thread-unreadable", canPublish: false, canWithdraw: true, item: { id: A } });
  });

  it("an unknown blyg_kind is flagged", async () => {
    expect(await load({ blyg_kind: "essay" }, "Words")).toMatchObject({ status: "invalid-kind", canPublish: false });
  });

  it("the link of a thread goes to t/{id}/, a fragment's to f/{id}/, on the active channel's address", () => {
    expect(itemUrl(settings(), A, "thread")).toBe(`https://example.com/blyg/t/${A}/`);
    expect(itemUrl(settings(), A)).toBe(`https://example.com/blyg/f/${A}/`);
    expect(itemUrl(settings({ useBranch: "preview" }), A, "thread")).toBe(`https://preview.example.com/blyg/t/${A}/`);
  });

  it("a published thread in sync links to its page and shows the counts", async () => {
    const text = `![[${A}]]\n`;
    const hash = await contentHash(text.trim());
    const s = await load({ blyg_kind: "thread", blyg_id: B, blyg_version: 3, blyg_hash: hash }, text);
    expect(s).toMatchObject({ status: "in-sync", ok: true, webUrl: `https://example.com/blyg/t/${B}/`, thread: { quotes: 1, passages: 0, links: 0 } });
  });
});

describe("names in the vault: the panel compares what a publish would commit", () => {
  const A = "7c9wk2mhq0v3xj8tn5rzfd41bg";
  const B = "1vgtgz0gq5b2c9k7d3m8r4n6xy";
  const notes: Record<string, { path: string; fm: Record<string, unknown> }> = {
    Quoted: { path: "website/blyg/Quoted.md", fm: { blyg_id: A } },
    Draft: { path: "website/blyg/Draft.md", fm: {} },
  };
  const vaultOf = (fm: Record<string, unknown>, text: string): VaultPort => ({
    read: () => Promise.resolve(text),
    blygId: (n) => (n.path === BLYG.path ? fm.blyg_id : Object.values(notes).find((x) => x.path === n.path)?.fm.blyg_id),
    frontmatterValue: (n, key) => (n.path === BLYG.path ? fm[key] : Object.values(notes).find((x) => x.path === n.path)?.fm[key]),
    resolveLink: (target) => {
      const hit = notes[target];
      return hit ? { path: hit.path, extension: "md" } : null;
    },
    updateFrontmatter: () => Promise.resolve(),
  });

  it("a thread written with a name is in sync once published with the id", async () => {
    const hash = await contentHash(`Words.\n\n![[${A}]]`);
    const fm = { blyg_kind: "thread", blyg_id: B, blyg_version: 1, blyg_hash: hash };
    const s = await loadPanelState({ settings: settings(), vault: vaultOf(fm, "Words.\n\n![[Quoted]]\n") }, BLYG);
    expect(s).toMatchObject({ status: "in-sync", thread: { quotes: 1 } });
    const edited = await loadPanelState({ settings: settings(), vault: vaultOf(fm, "Words, changed.\n\n![[Quoted]]\n") }, BLYG);
    expect(edited.status).toBe("local-changes");
  });

  it("a quoted note that is not published yet is said in the panel, with no Publish button", async () => {
    const s = await loadPanelState({ settings: settings(), vault: vaultOf({ blyg_kind: "thread" }, "![[Draft]]\n") }, BLYG);
    expect(s).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(s.notes[0]).toMatch(/line 1: “Draft” is not published yet/);
  });
});

describe("a stray embed is said in the panel before it breaks a deploy", () => {
  it("an inline or image embed makes the note unpublishable, with its line", async () => {
    const vault: VaultPort = {
      read: () => Promise.resolve("Words\n\n![[pic.png]]\n"),
      blygId: () => undefined,
      frontmatterValue: () => undefined,
      resolveLink: () => null,
      updateFrontmatter: () => Promise.resolve(),
    };
    const s = await loadPanelState({ settings: settings(), vault }, BLYG);
    expect(s).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(s.notes[0]).toMatch(/line 3: !\[\[pic\.png\]\]: an embed the site cannot show/);
  });
});

describe("the panel says the other local publish problems too (the ones the publish would refuse on, with no network)", () => {
  const vaultOf = (text: string): VaultPort => ({
    read: () => Promise.resolve(text),
    blygId: () => undefined,
    frontmatterValue: () => undefined,
    resolveLink: () => null,
    updateFrontmatter: () => Promise.resolve(),
  });
  const load = (text: string, fm: Record<string, unknown> = {}, over: Partial<BlygSettings["safety"]> = {}) => {
    const s = settings();
    s.safety = { ...s.safety, ...over };
    const vault = { ...vaultOf(text), frontmatterValue: (_n: NoteRef, key: string) => fm[key] };
    return loadPanelState({ settings: s, vault }, BLYG);
  };

  it("an empty note", async () => {
    const s = await load("---\ntitle: x\n---\n");
    expect(s).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(s.notes[0]).toBe("The note is empty: write something first.");
  });

  it("a fragment over its limit, with the number, the limit and what to do; a thread of the same length is fine", async () => {
    const long = "x".repeat(1200);
    const fragment = await load(long);
    expect(fragment).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(fragment.notes[0]).toBe("Too long for a fragment: 1200 characters, the limit is 1000. Shorten it, or make it a thread.");
    expect(await load(long, { blyg_kind: "thread" })).toMatchObject({ status: "not-published", canPublish: true });
  });

  it("links the site cannot honour, when the setting blocks them; not when it only warns", async () => {
    const text = "See [[Nowhere]] and [[Private Plan]].";
    const blocked = await load(text);
    expect(blocked).toMatchObject({ status: "thread-unreadable", canPublish: false });
    expect(blocked.notes[0]).toBe("Links the site cannot honour: [[Nowhere]] (no such note yet), [[Private Plan]] (no such note yet). Fix or remove them.");
    expect(await load(text, {}, { outsideLinks: "warn" })).toMatchObject({ status: "not-published", canPublish: true });
  });

  it("an ordinary short note has none of these", async () => {
    expect(await load("A fine note.")).toMatchObject({ status: "not-published", canPublish: true });
  });
});
