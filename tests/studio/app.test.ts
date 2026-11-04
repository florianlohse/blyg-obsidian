// The Studio publish wired the way the plugin wires it: settings → address, keychain → token, runPublish → the service.
import { describe, expect, it } from "vitest";
import { runPublish, runWithdraw, type AppEnv } from "../../src/app/run";
import type { NoteRef } from "../../src/platform/ports";
import { M } from "../../src/publish/messages";
import { defaultSettings, type BlygSettings } from "../../src/settings/schema";
import { fakeKeychain, idleTimers, TOKEN } from "../helpers";
import { makeWorld, MACRO_ROUTES, type World } from "../world";
import { FakeStudio, STUDIO_HOST, STUDIO_ORIGIN, STUDIO_TOKEN } from "./fake-studio";

const ref = (path: string): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension: "md" });

function userSettings(studio: Partial<BlygSettings["studio"]> = {}): BlygSettings {
  const s = defaultSettings();
  s.github = { ...s.github, owner: "o", repo: "r", tokenSecretName: "gh-token" };
  s.studio = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "studio-token", importFolder: "", ...studio };
  s.routes = [{ vaultPrefix: "studio/", mode: "studio", label: "Blyg item" }, ...MACRO_ROUTES];
  return s;
}

function setup(vault: Record<string, string>, active: string, over: Partial<AppEnv> = {}, settings = userSettings()) {
  const w: World = makeWorld({ vault, settings: { routes: settings.routes } });
  const studio = new FakeStudio();
  const env: AppEnv = {
    settings,
    activeNote: () => ref(active),
    flush: () => Promise.resolve(),
    keychain: fakeKeychain({ "gh-token": TOKEN, "studio-token": STUDIO_TOKEN }),
    http: w.http,
    vault: w.deps.vault,
    yaml: w.deps.yaml,
    clock: w.deps.clock,
    random: w.deps.random,
    confirm: w.deps.confirm,
    studio: { transport: studio.transport, timers: idleTimers, pending: { get: () => Promise.resolve(null), set: () => Promise.resolve(), clear: () => Promise.resolve() } },
    ...over,
  };
  return { w, studio, env };
}

describe("runPublish for a Studio route", () => {
  it("publishes through the Studio named in the settings, with the token from the keychain", async () => {
    const { w, studio, env } = setup({ "studio/N.md": "Hello.\n" }, "studio/N.md");
    const out = await runPublish(env);
    expect(out).toMatchObject({ status: "published", version: 1 });
    expect(studio.seen.every((s) => s.authorization === `Bearer ${STUDIO_TOKEN}`)).toBe(true);
    expect(w.calls).toEqual([]); // nothing went to GitHub
    expect(w.local.get("studio/N.md")).toContain(`blyg_origin: ${STUDIO_ORIGIN}`);
  });

  it("an essay does not need a Studio at all", async () => {
    const noStudio = userSettings({ baseUrl: "", tokenSecretName: "" });
    noStudio.routes = MACRO_ROUTES;
    const { w, studio, env } = setup({ "website/essays/E.md": "---\ntitle: T\n---\nBody.\n" }, "website/essays/E.md", {}, noStudio);
    expect((await runPublish(env)).status).toBe("committed");
    expect(studio.seen).toEqual([]);
    expect(w.commits).toHaveLength(1);
  });

  it("a Studio route with unfinished Studio settings blocks publishing, and the message names the Studio fields", async () => {
    const { studio, env } = setup({ "studio/N.md": "Hello.\n" }, "studio/N.md", {}, userSettings({ baseUrl: "", tokenSecretName: "" }));
    const out = await runPublish(env);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/Studio address: Required: a route publishes to a Studio\. · Studio token: Required/);
    expect(studio.seen).toEqual([]);
  });

  it("with no Studio token on this device, only the Studio route is refused, and the message says why", async () => {
    const { studio, env } = setup({ "studio/N.md": "Hello.\n", "website/essays/E.md": "---\ntitle: T\n---\nBody.\n" }, "studio/N.md", { keychain: fakeKeychain({ "gh-token": TOKEN }) });
    const out = await runPublish(env);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/keychain entry “studio-token” is empty on this device/);
    expect(studio.seen).toEqual([]);
    const essay = setup({ "website/essays/E.md": "---\ntitle: T\n---\nBody.\n" }, "website/essays/E.md", { keychain: fakeKeychain({ "gh-token": TOKEN }) });
    expect((await runPublish(essay.env)).status).toBe("committed");
  });

  it("an environment without Studio plumbing refuses a Studio route cleanly", async () => {
    const { env } = setup({ "studio/N.md": "Hello.\n" }, "studio/N.md");
    delete env.studio;
    expect((await runPublish(env)).notices).toEqual([M.studioNotConfigured]);
  });

  it("an unexpected error never carries either token into a notice", async () => {
    const { w, env } = setup({ "studio/N.md": "Hello.\n" }, "studio/N.md");
    w.deps.vault.read = () => Promise.reject(new Error(`disk trouble near ${STUDIO_TOKEN} and ${TOKEN}`));
    env.vault = w.deps.vault;
    const out = await runPublish(env);
    expect(out.status).toBe("failed");
    expect(JSON.stringify(out)).not.toContain(STUDIO_TOKEN);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("withdraw goes to the Studio too, with the same token, and never to GitHub", async () => {
    const { w, studio, env } = setup({ "studio/N.md": "Hello.\n" }, "studio/N.md");
    expect((await runPublish(env)).status).toBe("published");
    const out = await runWithdraw(env);
    expect(out).toMatchObject({ status: "published", version: 2 });
    expect(studio.seen.every((s) => s.authorization === `Bearer ${STUDIO_TOKEN}`)).toBe(true);
    expect(w.calls).toEqual([]);
  });
});
