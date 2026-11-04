import { describe, expect, it, vi } from "vitest";

// Just enough of Obsidian's ItemView and DOM helpers for BlygPanelView.
vi.mock("obsidian", () => {
  class FakeEl {
    cls = new Set<string>();
    text = "";
    href = "";
    disabled = false;
    children: FakeEl[] = [];
    handlers: (() => void)[] = [];
    constructor(public tag = "div") {}
    addClass(c: string) {
      this.cls.add(c);
    }
    private make(tag: string, o?: { cls?: string; text?: string; href?: string }) {
      const el = new FakeEl(tag);
      if (o?.cls) o.cls.split(" ").forEach((c) => el.cls.add(c));
      if (o?.text) el.text = o.text;
      if (o?.href) el.href = o.href;
      this.children.push(el);
      return el;
    }
    createDiv(o?: { cls?: string; text?: string }) {
      return this.make("div", o);
    }
    createEl(tag: string, o?: { cls?: string; text?: string; href?: string }) {
      return this.make(tag, o);
    }
    createSpan(o?: { cls?: string; text?: string }) {
      return this.make("span", o);
    }
    addEventListener(_t: string, fn: () => void) {
      this.handlers.push(fn);
    }
    click() {
      if (!this.disabled) this.handlers.forEach((h) => h());
    }
    empty() {
      this.children = [];
    }
    all(): FakeEl[] {
      return [this, ...this.children.flatMap((c) => c.all())];
    }
  }
  class ItemView {
    contentEl = new FakeEl();
    constructor(public leaf: unknown) {}
  }
  return { ItemView };
});

import { computePanelState, type PanelDeploy, type PanelState } from "../src/app/panelState";
import { BlygPanelView, type PanelHost } from "../src/ui/BlygPanelView";
import { defaultSettings } from "../src/settings/schema";
import { MACRO_ROUTES } from "./world";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type El = { cls: Set<string>; text: string; href: string; disabled: boolean; tag: string; click(): void; all(): El[] };

const ID = "7c9wk2mhq0v3xj8tn5rzfd41bg";
const settings = () => ({ ...defaultSettings(), routes: MACRO_ROUTES });
const stateOf = (fm: Record<string, unknown>, hash = "sha256:a"): PanelState =>
  computePanelState({
    settings: { ...settings(), blyg: { ...settings().blyg, origin: "https://example.com/blyg/" } },
    note: { path: "website/blyg/N.md", name: "N.md", extension: "md" },
    frontmatter: fm,
    localHash: hash,
  });

async function mount(state: PanelState, deploy: PanelDeploy | null = null, over: Partial<PanelHost> = {}) {
  const calls: string[] = [];
  const asked: Array<string | undefined> = [];
  const host: PanelHost = {
    version: "9.8.7",
    loadState: () => Promise.resolve(state),
    deleteDraft: () => Promise.resolve(),
    deploy: (path) => (asked.push(path), deploy),
    publish: () => (calls.push("publish"), Promise.resolve()),
    withdraw: () => (calls.push("withdraw"), Promise.resolve()),
    repost: () => (calls.push("repost"), Promise.resolve()),
    pull: () => (calls.push("pull"), Promise.resolve()),
    openWeb: (url) => void calls.push(`open ${url}`),
    setTarget: (channel) => (calls.push(`target ${channel}`), Promise.resolve()),
    canSwitchTarget: () => true,
    recheckDeploy: () => (calls.push("recheck"), Promise.resolve()),
    newThread: () => (calls.push("newThread"), Promise.resolve()),
    newNote: () => (calls.push("newNote"), Promise.resolve()),
    importFromStudio: () => (calls.push("importFromStudio"), Promise.resolve()),
    chooseHoppers: () => (calls.push("chooseHoppers"), Promise.resolve()),
    takeHoppers: () => (calls.push("takeHoppers"), Promise.resolve()),
    replyToItem: () => (calls.push("replyToItem"), Promise.resolve()),
    makeReply: () => (calls.push("makeReply"), Promise.resolve()),
    quoteInNewThread: () => (calls.push("quoteInNewThread"), Promise.resolve()),
    continueThread: () => (calls.push("continueThread"), Promise.resolve()),
    makeThread: () => (calls.push("makeThread"), Promise.resolve()),
    insertQuote: () => (calls.push("insertQuote"), Promise.resolve()),
    insertLink: () => (calls.push("insertLink"), Promise.resolve()),
    ...over,
  };
  const view = new BlygPanelView({} as never, host);
  await view.onOpen();
  const els = (view.contentEl as unknown as El).all();
  const button = (text: string) => els.find((e) => e.tag === "button" && e.text === text);
  return { view, calls, asked, els, button, texts: els.map((e) => e.text) };
}

describe("BlygPanelView", () => {
  it("offers Use the Studio's copy only when the state says so, and runs it", async () => {
    const shown = await mount({ ...stateOf({}), showPull: true, canPull: true });
    shown.button("Replace this note with the online text")?.click();
    await vi.waitFor(() => expect(shown.calls).toContain("pull"));
    const hidden = await mount(stateOf({}));
    expect(hidden.button("Replace this note with the online text")).toBeUndefined();
  });

  it("names the plugin version at the foot, whatever the note", async () => {
    const { texts } = await mount(stateOf({}));
    expect(texts.at(-1)).toBe("Blyg 9.8.7");
  });

  it("on production the panel shows no target or branch at all", async () => {
    const { texts, els } = await mount(stateOf({}));
    expect(texts.some((t) => /branch|Production|Preview|Test mode/.test(t))).toBe(false);
    expect(els.some((e) => e.cls.has("blyg-pane-testmode"))).toBe(false);
  });

  it("while the target is preview it says so in words and offers the way back", async () => {
    const preview = computePanelState({
      settings: { ...settings(), github: { ...settings().github, useBranch: "preview" } },
      note: { path: "website/blyg/N.md", name: "N.md", extension: "md" },
      frontmatter: {},
      localHash: "sha256:a",
    });
    const { els, texts, button, calls } = await mount(preview);
    expect(els.some((e) => e.cls.has("blyg-pane-testmode"))).toBe(true);
    expect(texts).toContain("Test mode: publishing goes to the “preview” branch, not to your real site.");
    button("Switch to production")?.click();
    await settle();
    expect(calls).toEqual(["target production"]);
  });

  it("the way back is not offered while the settings are read-only or a write is running", async () => {
    const preview = computePanelState({
      settings: { ...settings(), github: { ...settings().github, useBranch: "preview" } },
      note: { path: "website/blyg/N.md", name: "N.md", extension: "md" },
      frontmatter: {},
      localHash: "sha256:a",
    });
    const { button, calls } = await mount(preview, null, { canSwitchTarget: () => false });
    expect(button("Switch to production")?.disabled).toBe(true);
    button("Switch to production")?.click();
    await settle();
    expect(calls).toEqual([]);
  });

  it("the main button says Publish before and Update after; Publish again after a withdrawal; the call to action only when there is something to send", async () => {
    const label = async (fm: Record<string, unknown>, hash = "sha256:a") => {
      const m = await mount(stateOf(fm, hash));
      const b = m.els.find((e) => e.tag === "button" && ["Publish", "Update", "Publish again"].includes(e.text));
      return [b?.text, b?.cls.has("mod-cta")];
    };
    expect(await label({})).toEqual(["Publish", true]);
    expect(await label({ blyg_id: ID, id: ID, version: 3, hash: "sha256:a" })).toEqual(["Update", false]);
    expect(await label({ blyg_id: ID, id: ID, version: 3, hash: "sha256:old" })).toEqual(["Update", true]);
    expect(await label({ blyg_id: ID, id: ID, version: 3, hash: "sha256:a", withdrawn: true })).toEqual(["Publish again", true]);
  });

  it("when everything is fine the status gets a green check and the green edge; otherwise neither", async () => {
    const ok = await mount(stateOf({ blyg_id: ID, id: ID, version: 3, hash: "sha256:a" }));
    expect(ok.els.some((e) => e.cls.has("blyg-pane-status-ok"))).toBe(true);
    expect(ok.els.some((e) => e.cls.has("blyg-pane-check") && e.text === "✓")).toBe(true);
    const changed = await mount(stateOf({ blyg_id: ID, id: ID, version: 3, hash: "sha256:old" }));
    expect(changed.els.some((e) => e.cls.has("blyg-pane-status-ok") || e.cls.has("blyg-pane-check"))).toBe(false);
    const fresh = await mount(stateOf({}));
    expect(fresh.els.some((e) => e.cls.has("blyg-pane-status-ok"))).toBe(false);
  });

  it("the deploy box shows only on the note whose file was committed, and nowhere outside the publish folders", async () => {
    const deploy: PanelDeploy = { phase: "done", branch: "preview", version: 1, path: `src/content/notes/${ID}.md`, kind: "deployed", text: "Deployed ✓", attention: false, at: new Date() };
    const own = await mount(stateOf({ blyg_id: ID, id: ID, version: 1, hash: "sha256:a" }), deploy);
    expect(own.texts).toContain("Last deploy");
    const other = await mount(stateOf({}), deploy);
    expect(other.texts).not.toContain("Last deploy");
    const outside = await mount(computePanelState({ settings: settings(), note: { path: "Daily/D.md", name: "D.md", extension: "md" }, frontmatter: {}, localHash: null }), deploy);
    expect(outside.texts).not.toContain("Last deploy");
    const otherEssay = await mount(
      computePanelState({ settings: settings(), note: { path: "website/essays/Other.md", name: "Other.md", extension: "md" }, frontmatter: {}, localHash: "sha256:a" }),
      { ...deploy, path: "src/content/essays/E.md" },
    );
    expect(otherEssay.texts).not.toContain("Last deploy");
  });

  it("a published item shows its address as a link, without the scheme", async () => {
    const { els } = await mount(stateOf({ blyg_id: ID, id: ID, version: 1, hash: "sha256:a" }));
    const link = els.find((e) => e.tag === "a");
    expect(link?.text).toBe(`example.com/blyg/f/${ID}/`);
    expect(link?.href).toBe(`https://example.com/blyg/f/${ID}/`);
  });

  it("the hint about a missing setting is drawn as a muted line", async () => {
    const s = computePanelState({
      settings: { ...settings(), routes: [{ vaultPrefix: "website/essays/", mode: "plain" as const, dest: "src/content/essays/", label: "essay" }] },
      note: { path: "website/essays/E.md", name: "E.md", extension: "md" },
      frontmatter: {},
      localHash: "sha256:a",
      plainRecord: { hash: "sha256:a", at: "t" },
    });
    const { els } = await mount(s);
    expect(els.some((e) => e.cls.has("blyg-pane-hint") && e.text.startsWith("To get a link, set a “Web address”"))).toBe(true);
  });

  it("a thread shows its kind, what it quotes, and a link to its t/ page", async () => {
    const state = computePanelState({
      settings: { ...settings(), blyg: { ...settings().blyg, origin: "https://example.com/blyg/" } },
      note: { path: "website/blyg/N.md", name: "N.md", extension: "md" },
      frontmatter: { id: ID, version: 2, hash: "sha256:a", kind: "thread" },
      localHash: "sha256:a",
      thread: { quotes: 3, passages: 2, links: 1, problems: [] },
    });
    const { els, texts } = await mount(state);
    expect(texts).toContain("Thread");
    expect(texts).toContain("3 (2 passages)");
    expect(texts).toContain("Item links");
    expect(els.find((e) => e.tag === "a")?.href).toBe(`https://example.com/blyg/t/${ID}/`);
  });

  it("a fragment says what it is and shows no quote rows", async () => {
    const { texts } = await mount(stateOf({}));
    expect(texts).toContain("Kind");
    expect(texts).toContain("Fragment");
    expect(texts).not.toContain("Quotes");
  });

  it("no address, no link row", async () => {
    const { els, texts } = await mount(stateOf({}));
    expect(els.some((e) => e.tag === "a")).toBe(false);
    expect(texts).not.toContain("Link");
  });

  it("a published, unchanged note: id and version shown, all three buttons live", async () => {
    const { texts, button } = await mount(stateOf({ id: ID, blyg_id: ID, version: 3, hash: "sha256:a" }));
    expect(texts).toContain(ID);
    expect(texts).toContain("3");
    expect([button("Update")?.disabled, button("Withdraw")?.disabled, button("Open on web")?.disabled]).toEqual([false, false, false]);
  });

  it("an unpublished note: only Publish is live", async () => {
    const { button } = await mount(stateOf({}));
    expect([button("Publish")?.disabled, button("Withdraw")?.disabled, button("Open on web")?.disabled]).toEqual([false, true, true]);
  });

  it("essays and pages have no Withdraw button, and no Open on web button unless their route has an address", async () => {
    const s = computePanelState({ settings: settings(), note: { path: "website/essays/E.md", name: "E.md", extension: "md" }, frontmatter: {}, localHash: "sha256:a" });
    const { button } = await mount(s);
    expect(button("Publish")?.disabled).toBe(false);
    expect(button("Withdraw")).toBeUndefined();
    expect(button("Open on web")).toBeUndefined();
  });

  it("an essay shows when it was last published, and Open on web only when its route has an address", async () => {
    const route = { vaultPrefix: "website/essays/", mode: "plain" as const, dest: "src/content/essays/", label: "essay" };
    const mk = (webUrl?: string) =>
      computePanelState({
        settings: { ...settings(), blyg: { ...settings().blyg, origin: "https://example.com/blyg/" }, routes: [{ ...route, ...(webUrl ? { webUrl } : {}) }] },
        note: { path: "website/essays/Wrestling With Eels.md", name: "Wrestling With Eels.md", extension: "md" },
        frontmatter: {},
        localHash: "sha256:a",
        plainRecord: { hash: "sha256:a", at: "2026-10-05T08:00:00.000Z" },
      });
    const without = await mount(mk());
    expect(without.texts).toContain("Last published");
    expect(without.button("Open on web")).toBeUndefined();
    const withUrl = await mount(mk("{site}/essays/{slug}/"));
    expect(withUrl.button("Open on web")?.disabled).toBe(false);
    withUrl.button("Open on web")?.click();
    expect(withUrl.calls).toEqual(["open https://example.com/essays/wrestling-with-eels/"]);
  });

  it("a note outside the routes: just the information, no publishing buttons at all", async () => {
    const s = computePanelState({ settings: settings(), note: { path: "Daily/D.md", name: "D.md", extension: "md" }, frontmatter: {}, localHash: null });
    const { button } = await mount(s);
    expect([button("Publish"), button("Update"), button("Withdraw"), button("Open on web")]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("Publish runs the plugin's publish; a second tap while it runs is ignored", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { button, calls } = await mount(stateOf({}), null, { publish: () => (calls.push("publish"), gate) });
    button("Publish")?.click();
    button("Publish")?.click();
    await settle();
    expect(calls).toEqual(["publish"]);
    release();
    await settle();
  });

  it("Open on web opens the item's permalink", async () => {
    const { button, calls } = await mount(stateOf({ blyg_id: ID, id: ID, version: 1, hash: "sha256:a" }));
    button("Open on web")?.click();
    expect(calls).toEqual([`open https://example.com/blyg/f/${ID}/`]);
  });

  it("asks for the deploy of the note's own file, and says plainly when a newer publish replaced one", async () => {
    const replaced: PanelDeploy = { phase: "done", branch: "preview", version: 3, path: `src/content/notes/${ID}.md`, kind: "replaced", text: "Not deployed by itself — …", attention: false, at: new Date() };
    const { asked, texts, els } = await mount(stateOf({ blyg_id: ID, id: ID, version: 3, hash: "sha256:a" }), replaced);
    expect(asked).toContain(`src/content/notes/${ID}.md`);
    expect(texts).toContain("v3 on preview: Not deployed — a newer publish replaced this one");
    expect(els.some((e) => e.cls.has("blyg-pane-deploy-attention"))).toBe(false);
  });

  it("draws Import from Studio when a Studio folder exists, and runs the import", async () => {
    const studioSettings = { ...settings(), studio: { baseUrl: "https://studio.test", mount: "", tokenSecretName: "t", importFolder: "" }, routes: [{ vaultPrefix: "studio/", mode: "studio" as const, label: "Blyg item" }] };
    const st = computePanelState({ settings: studioSettings, note: { path: "elsewhere/N.md", name: "N.md", extension: "md" }, frontmatter: {}, localHash: "sha256:a" });
    const { button, calls } = await mount(st);
    button("Import from Studio")?.click();
    await vi.waitFor(() => expect(calls).toContain("importFromStudio"));
    expect((await mount(stateOf({}))).button("Import from Studio")).toBeUndefined();
  });

  it("a note with another blyg's record gets a Repost to Studio button, enabled when the text can be sent", async () => {
    const studioSettings = { ...settings(), studio: { baseUrl: "https://studio.test", mount: "", tokenSecretName: "t", importFolder: "" }, routes: [{ vaultPrefix: "studio/", mode: "studio" as const, label: "Blyg item" }] };
    const old = computePanelState({ settings: studioSettings, note: { path: "studio/Old.md", name: "Old.md", extension: "md" }, frontmatter: { id: ID, version: 3 }, localHash: "sha256:a" });
    const { button, calls } = await mount(old);
    expect(button("Repost to Studio")?.disabled).toBe(false);
    button("Repost to Studio")?.click();
    await vi.waitFor(() => expect(calls).toContain("repost"));
    const plain = await mount(stateOf({}));
    expect(plain.button("Repost to Studio")).toBeUndefined();
    const blocked = computePanelState({ settings: studioSettings, note: { path: "studio/Old.md", name: "Old.md", extension: "md" }, frontmatter: { id: ID, version: 3 }, localHash: null });
    expect((await mount(blocked)).button("Repost to Studio")?.disabled).toBe(true);
  });

  it("a Studio note shows its mentions and the Studio's warnings in plain sentences, and says when the Studio could not be reached", async () => {
    const studioSettings = { ...settings(), studio: { baseUrl: "https://studio.test", mount: "", tokenSecretName: "t", importFolder: "" }, routes: [{ vaultPrefix: "studio/", mode: "studio" as const, label: "Blyg item" }] };
    const base = { settings: studioSettings, note: { path: "studio/N.md", name: "N.md", extension: "md" }, frontmatter: { id: ID, origin: "https://studio.test/", version: 2, sent: "sha256:a" }, localHash: "sha256:a" };
    const withInfo = computePanelState({ ...base, studio: { warnings: ["The Studio token expires in 3 days."], facts: { item: { status: "public", version: 2, workingHash: "sha256:a" }, mentions: { count: 3, complete: false }, at: 0 } } });
    const shown = await mount(withInfo);
    expect(shown.texts).toContain("The Studio token expires in 3 days.");
    expect(shown.texts).toContain("Mentions");
    expect(shown.texts).toContain("3+");
    const none = await mount(computePanelState({ ...base, studio: { warnings: [], facts: { item: { status: "public", version: 2, workingHash: "sha256:a" }, mentions: { count: 0, complete: true }, at: 0 } } }));
    expect(none.texts).toContain("none yet");
    const down = await mount(computePanelState({ ...base, studio: { warnings: [], facts: { item: "unreachable", mentions: null, at: 0 } } }));
    expect(down.texts.some((t) => /could not be reached just now/.test(t))).toBe(true);
    expect(down.texts).not.toContain("Mentions");
  });

  it("says why Insert quote is grey on a fragment, and what to do", async () => {
    const fragment = await mount(stateOf({}));
    expect(fragment.button("Insert quote")?.disabled).toBe(true);
    expect(fragment.texts.some((t) => /Insert quote works in threads only.*tap Make thread/.test(t))).toBe(true);
    const published = await mount(stateOf({ blyg_id: ID, id: ID, version: 1, hash: "sha256:a" }));
    expect(published.texts.some((t) => /published fragment.*never changes.*Quote in thread/.test(t))).toBe(true);
    const thread = await mount(stateOf({ kind: "thread" }));
    expect(thread.button("Insert quote")?.disabled).toBe(false);
    expect(thread.texts.some((t) => /Insert quote works in threads only/.test(t))).toBe(false);
  });

  it("deploy: nothing before a commit; a quiet line on success; the full explanation on failure", async () => {
    expect((await mount(stateOf({}))).texts).not.toContain("Last deploy");

    const ok = await mount(stateOf({}), { phase: "done", branch: "main", version: 2, kind: "deployed", text: "Deployed ✓ — …", attention: false, at: new Date() });
    expect(ok.texts).toContain("Last deploy");
    expect(ok.texts).toContain("v2 on main: Deployed");
    expect(ok.els.some((e) => e.cls.has("blyg-pane-check"))).toBe(true);
    expect(ok.els.some((e) => e.cls.has("blyg-pane-deploy-attention"))).toBe(false);

    const text = "Checks failed ✗ — nothing went live. It stopped at the step “Check build”.";
    const bad = await mount(stateOf({}), { phase: "done", branch: "preview", version: 8, kind: "failed", text, attention: true, at: new Date() });
    expect(bad.texts).toContain(text);
    expect(bad.els.some((e) => e.cls.has("blyg-pane-deploy-attention"))).toBe(true);
    bad.button("Check again")?.click();
    await settle();
    expect(bad.calls).toContain("recheck");
  });

  it("only the newest refresh draws: a slow read of an earlier note cannot overwrite a later one", async () => {
    const first = stateOf({}); // "Not published yet."
    const second = stateOf({ id: ID, blyg_id: ID, version: 5, hash: "sha256:a" });
    const resolvers: ((s: PanelState) => void)[] = [];
    const view = new BlygPanelView({} as never, {
      version: "9.8.7",
      deleteDraft: () => Promise.resolve(),
      pull: () => Promise.resolve(),
      loadState: () => new Promise<PanelState>((r) => resolvers.push(r)),
      deploy: () => null,
      publish: () => Promise.resolve(),
      withdraw: () => Promise.resolve(),
      repost: () => Promise.resolve(),
      openWeb: () => {},
      setTarget: () => Promise.resolve(),
      canSwitchTarget: () => true,
      recheckDeploy: () => Promise.resolve(),
      newThread: () => Promise.resolve(),
      newNote: () => Promise.resolve(),
      importFromStudio: () => Promise.resolve(),
      chooseHoppers: () => Promise.resolve(),
      takeHoppers: () => Promise.resolve(),
      replyToItem: () => Promise.resolve(),
      makeReply: () => Promise.resolve(),
      quoteInNewThread: () => Promise.resolve(),
      continueThread: () => Promise.resolve(),
      makeThread: () => Promise.resolve(),
      insertQuote: () => Promise.resolve(),
      insertLink: () => Promise.resolve(),
    });
    const a = view.refresh();
    const b = view.refresh();
    resolvers[1]?.(second);
    await b;
    resolvers[0]?.(first);
    await a;
    const texts = (view.contentEl as unknown as El).all().map((e) => e.text);
    expect(texts).toContain("5");
    expect(texts).not.toContain("Not published yet.");
  });
});

describe("the writing buttons", () => {
  const WRITE = ["New thread", "New fragment", "Quote in thread", "Continue thread", "Make thread", "Insert quote", "Insert link"];
  const noteState = (path: string, fm: Record<string, unknown>, ext = "md") =>
    computePanelState({ settings: settings(), note: { path, name: path.split("/").pop() ?? path, extension: ext }, frontmatter: fm, localHash: "sha256:a" });

  it("with no note open: only New thread and New fragment are drawn, and no Publish row", async () => {
    const { button, els } = await mount(computePanelState({ settings: settings(), note: null, frontmatter: {}, localHash: null }));
    expect(WRITE.map((t) => [t, button(t)?.disabled])).toEqual([
      ["New thread", false], ["New fragment", false], ["Quote in thread", undefined], ["Continue thread", undefined], ["Make thread", undefined], ["Insert quote", undefined], ["Insert link", undefined],
    ]);
    expect(["Publish", "Update", "Withdraw", "Open on web"].map((t) => button(t))).toEqual([undefined, undefined, undefined, undefined]);
    expect(els.some((e) => e.cls.has("blyg-pane-buttons") && e.text === "Publish")).toBe(false);
  });

  it("outside the publish folders: the info and the two New buttons, nothing that cannot work", async () => {
    const { button, texts } = await mount(noteState("Daily/2026-10-10.md", {}));
    expect(texts).toContain("Not in a publish folder.");
    expect(WRITE.map((t) => button(t)?.disabled)).toEqual([false, false, undefined, undefined, undefined, undefined, undefined]);
    expect(["Publish", "Update", "Withdraw", "Open on web"].map((t) => button(t))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("an essay open: Publish stays (it applies), the Blyg-note buttons are not drawn", async () => {
    const { button } = await mount(noteState("website/essays/E.md", {}));
    expect(WRITE.map((t) => button(t)?.disabled)).toEqual([false, false, undefined, undefined, undefined, undefined, undefined]);
    expect(button("Publish")).toBeDefined();
  });

  it("an unpublished fragment open: it can be quoted, linked into and made a thread; Continue and Insert quote stay, grayed out", async () => {
    const { button } = await mount(noteState("website/blyg/N.md", {}));
    expect(WRITE.map((t) => button(t)?.disabled)).toEqual([false, false, false, true, false, true, false]);
  });

  it("a published fragment can no longer be made a thread (the kind never changes): the button stays, grayed out", async () => {
    const { button } = await mount(noteState("website/blyg/N.md", { id: ID, blyg_id: ID, version: 1, hash: "sha256:a" }));
    expect(button("Make thread")?.disabled).toBe(true);
  });

  it("a thread open: everything is live", async () => {
    const { button } = await mount(noteState("website/blyg/N.md", { kind: "thread" }));
    expect(WRITE.map((t) => button(t)?.disabled)).toEqual([false, false, false, false, true, false, false]);
  });

  it("with no Blyg folder in the settings even New thread is off", async () => {
    const s = computePanelState({ settings: { ...settings(), routes: [] }, note: null, frontmatter: {}, localHash: null });
    const { button } = await mount(s);
    expect([button("New thread")?.disabled, button("New fragment")?.disabled]).toEqual([true, true]);
  });

  it("Make thread runs its action on an unpublished fragment", async () => {
    const { button, calls } = await mount(noteState("website/blyg/N.md", {}));
    button("Make thread")?.click();
    await settle();
    expect(calls).toContain("makeThread");
  });

  it("each button runs its own action", async () => {
    const actions: Record<string, string> = {
      "New thread": "newThread", "New fragment": "newNote", "Quote in thread": "quoteInNewThread",
      "Continue thread": "continueThread", "Insert quote": "insertQuote", "Insert link": "insertLink",
    };
    for (const [label, call] of Object.entries(actions)) {
      const { button, calls } = await mount(noteState("website/blyg/N.md", { kind: "thread" }));
      button(label)?.click();
      await settle();
      expect(calls, label).toContain(call);
    }
  });
});
