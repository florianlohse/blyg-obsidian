import { describe, expect, it } from "vitest";
import { activeBranch, activeChannel, describeTarget, preflight, toPublishSettings } from "../../src/app/publishSettings";
import type { PublishedStore } from "../../src/app/publishedStore";
import { runPublish, runWithdraw, type AppEnv } from "../../src/app/run";
import type { NoteRef } from "../../src/platform/ports";
import { defaultSettings, type BlygSettings } from "../../src/settings/schema";
import { fakeKeychain, TOKEN } from "../helpers";
import { makeWorld, MACRO_ROUTES, type World } from "../world";

const NOTE = "website/blyg/Note.md";
const ref = (path: string): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension: "md" });

/** User settings as a real setup would have them (owner/repo match the fake GitHub's "o"/"r"). */
function userSettings(over: Partial<BlygSettings["github"]> = {}): BlygSettings {
  const s = defaultSettings();
  s.github = { ...s.github, owner: "o", repo: "r", tokenSecretName: "gh-token", ...over };
  s.routes = MACRO_ROUTES;
  return s;
}

function envFor(w: World, over: Partial<AppEnv> = {}, settings = userSettings(), active: NoteRef | null = ref(NOTE)): AppEnv {
  return {
    settings,
    activeNote: () => active,
    flush: () => Promise.resolve(),
    keychain: fakeKeychain({ "gh-token": TOKEN }),
    http: w.http,
    vault: w.deps.vault,
    yaml: w.deps.yaml,
    clock: w.deps.clock,
    random: w.deps.random,
    confirm: w.deps.confirm,
    ...over,
  };
}

describe("settings → publish settings", () => {
  it("production uses the production branch; preview uses the preview branch", () => {
    const s = userSettings();
    expect([activeChannel(s), activeBranch(s)]).toEqual(["production", "main"]);
    s.github.useBranch = "preview";
    expect([activeChannel(s), activeBranch(s)]).toEqual(["preview", "preview"]);
    expect(toPublishSettings(s)).toMatchObject({ channel: "preview", branch: "preview", outsideLinks: "block", ignoreTrailingWhitespace: true, itemsDir: "src/content/notes", fragmentCharCap: 1000 });
  });

  it("describes the target for notices", () => {
    expect(describeTarget(userSettings())).toBe("Production — your real site (branch “main”)");
    expect(describeTarget(userSettings({ useBranch: "preview" }))).toBe("Preview — the test channel (branch “preview”)");
  });

  it("preflight: null when fine, otherwise names what to fix (errors only, not notes)", () => {
    expect(preflight(userSettings())).toBeNull();
    const githubUser = defaultSettings();
    githubUser.routes = [{ vaultPrefix: "blyg/", mode: "blyg", label: "Blyg item" }];
    expect(preflight(githubUser)).toMatch(/Owner: Required\. · Repository: Required\./);
    const s = userSettings();
    s.blyg.fragmentCharCap = 5000;
    expect(preflight(s)).toMatch(/Fragment character cap/);
    const warnOnly = userSettings();
    warnOnly.blyg.itemsDir = "content/items"; // only a warning
    expect(preflight(warnOnly)).toBeNull();
  });
});

describe("the publish and withdraw commands", () => {
  it("publish goes to the production branch by default and shows the preview first", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n" } });
    const out = await runPublish(envFor(w));
    expect(out.status).toBe("committed");
    expect(w.commits[0]).toMatchObject({ branch: "main" });
    expect(w.previews).toHaveLength(1);
  });

  it("with 'Publish to: Preview' every write goes to the preview branch and the note is marked", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Scratch\n" } });
    const out = await runPublish(envFor(w, {}, userSettings({ useBranch: "preview" })));
    expect(out.notices[0]).toMatch(/Committed v1 to preview/);
    expect(w.commits.every((c) => c.branch === "preview")).toBe(true);
    expect(w.local.get(NOTE)).toMatch(/blyg_channel: preview/);
    expect(w.refs.every((r) => r === "preview")).toBe(true);
  });

  it("an essay publish is remembered in the published store when the command is given one", async () => {
    const essay = "website/essays/Essay.md";
    const w = makeWorld({ vault: { [essay]: "---\ntitle: T\n---\nBody\n" } });
    const records = new Map<string, string>();
    const published: PublishedStore = {
      get: () => Promise.resolve(null),
      set: (branch, path, rec) => (records.set(`${branch}:${path}`, rec.hash), Promise.resolve()),
    };
    const out = await runPublish(envFor(w, { published }, userSettings(), ref(essay)));
    expect(out.status).toBe("committed");
    expect([...records.keys()]).toEqual(["main:src/content/essays/Essay.md"]);
  });

  it("withdraw works end to end, behind the confirmation", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Words\n" } });
    await runPublish(envFor(w));
    w.answer = false;
    expect((await runWithdraw(envFor(w))).status).toBe("cancelled");
    w.answer = true;
    expect(await runWithdraw(envFor(w))).toMatchObject({ status: "committed", version: 2 });
  });

  it("refuses with no active note, bad settings, or no token — before any network call", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n" } });
    expect((await runPublish(envFor(w, {}, userSettings(), null))).notices[0]).toMatch(/No active note/);
    expect((await runPublish(envFor(w, {}, defaultSettings()))).notices[0]).toMatch(/settings need attention/);
    expect((await runPublish(envFor(w, {}, userSettings({ tokenSecretName: "" })))).notices[0]).toMatch(/No GitHub token chosen/);
    expect((await runPublish(envFor(w, { keychain: fakeKeychain({}) }))).notices[0]).toMatch(/keychain entry “gh-token” is empty/);
    expect((await runPublish(envFor(w, { keychain: fakeKeychain({ "gh-token": TOKEN }, false) }))).notices[0]).toMatch(/no keychain/);
    expect(w.calls).toHaveLength(0);
    expect(w.previews).toHaveLength(0);
  });

  it("saves pending edits first, then reads the note", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n" } });
    const order: string[] = [];
    await runPublish(
      envFor(w, {
        flush: () => (order.push("flush"), Promise.resolve()),
        vault: { ...w.deps.vault, read: (n) => (order.push("read"), w.deps.vault.read(n)) },
      }),
    );
    expect(order.slice(0, 2)).toEqual(["flush", "read"]);
  });

  it("an unexpected exception becomes a plain message that cannot contain the token", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n" } });
    const out = await runPublish(
      envFor(w, { vault: { ...w.deps.vault, read: () => Promise.reject(new Error(`disk exploded near Bearer ${TOKEN}`)) } }),
    );
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/Something unexpected went wrong/);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("a note outside every route is refused (fail closed), nothing asked, nothing sent", async () => {
    const w = makeWorld({ vault: { "elsewhere/x.md": "x" } });
    const out = await runPublish(envFor(w, {}, userSettings(), ref("elsewhere/x.md")));
    expect(out.status).toBe("refused");
    expect(w.calls).toHaveLength(0);
    expect(w.previews).toHaveLength(0);
  });

  it("the whitespace rule is on: a trailing space alone is 'no changes'", async () => {
    const text = "---\ntitle: T\n---\nBody\n";
    const w = makeWorld({ vault: { "website/pages/p.md": text + "  \n" }, repo: { "src/content/pages/p.md": text } });
    const out = await runPublish(envFor(w, {}, userSettings(), ref("website/pages/p.md")));
    expect(out.status).toBe("noop");
    expect(w.commits).toHaveLength(0);
  });
});
