// Studio-only mode (M1 lane A2.4, docs/plans/M1-first-public-release.md §6 B2): someone who has only a Blygger Studio needs no GitHub
// owner, repository, branches or token to publish; a missing GitHub setup never blocks a Studio route, and the GitHub-site path stays
// in the code but is hidden for a user who has none.
import { describe, expect, it } from "vitest";
import { runPublish, runWithdraw, type AppEnv } from "../../src/app/run";
import { preflight } from "../../src/app/publishSettings";
import type { NoteRef } from "../../src/platform/ports";
import { defaultSettings, type BlygSettings } from "../../src/settings/schema";
import { githubInUse, isStudioOnly } from "../../src/settings/studioOnly";
import { describeField, validateSettings } from "../../src/settings/validate";
import { fakeKeychain, idleTimers } from "../helpers";
import { makeWorld, MACRO_ROUTES, type World } from "../world";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./fake-studio";

const ref = (path: string): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension: "md" });

/** A fresh install that has only been given a Studio address and token: nothing else. */
function studioOnlySettings(): BlygSettings {
  const s = defaultSettings();
  s.studio = { baseUrl: STUDIO_HOST, mount: "", tokenSecretName: "studio-token", importFolder: "" };
  return s;
}

function setup(vault: Record<string, string>, active: string, settings: BlygSettings, keys: Record<string, string> = { "studio-token": STUDIO_TOKEN }) {
  const w: World = makeWorld({ vault, settings: { routes: settings.routes } });
  const studio = new FakeStudio();
  const env: AppEnv = {
    settings,
    activeNote: () => ref(active),
    flush: () => Promise.resolve(),
    keychain: fakeKeychain(keys),
    // GitHub must never be touched in these tests: any call is a failure
    http: { request: () => Promise.reject(new Error("GitHub was called")) } as unknown as AppEnv["http"],
    vault: w.deps.vault,
    yaml: w.deps.yaml,
    clock: w.deps.clock,
    random: w.deps.random,
    confirm: w.deps.confirm,
    studio: { transport: studio.transport, timers: idleTimers, pending: { get: () => Promise.resolve(null), set: () => Promise.resolve(), clear: () => Promise.resolve() } },
  };
  return { w, studio, env };
}

describe("who counts as Studio-only", () => {
  it("a fresh install is: every route is a Studio route and no GitHub setting is filled in", () => {
    const s = defaultSettings();
    expect(s.routes.every((r) => r.mode === "studio")).toBe(true);
    expect(isStudioOnly(s)).toBe(true);
  });
  it("not when a route commits to a repository (Blyg or Plain), or a GitHub setting has been filled in", () => {
    const withRoute = studioOnlySettings();
    withRoute.routes.push({ vaultPrefix: "essays/", mode: "plain", dest: "src/content/essays/", label: "Essay" });
    expect(githubInUse(withRoute)).toBe(true);
    for (const [key, value] of [["owner", "o"], ["repo", "r"], ["tokenSecretName", "gh-token"]] as const) {
      const s = studioOnlySettings();
      s.github[key] = value;
      expect(isStudioOnly(s), key).toBe(false);
    }
    const old = defaultSettings();
    old.routes = MACRO_ROUTES;
    expect(isStudioOnly(old)).toBe(false);
  });
});

describe("the setup check", () => {
  it("asks for no GitHub field: a Studio address and token is a complete setup", () => {
    expect(validateSettings(studioOnlySettings()).filter((i) => i.severity === "error")).toEqual([]);
    expect(preflight(studioOnlySettings())).toBeNull();
  });
  it("still asks for the Studio's own fields", () => {
    expect(validateSettings(defaultSettings()).filter((i) => i.severity === "error").map((i) => i.field)).toEqual(["studio.baseUrl", "studio.tokenSecretName"]);
  });
  it("a setup that does use GitHub still needs all of it", () => {
    const s = studioOnlySettings();
    s.routes = MACRO_ROUTES;
    expect(validateSettings(s).filter((i) => i.severity === "error").map((i) => describeField(i.field))).toEqual(expect.arrayContaining(["Owner", "Repository"]));
  });
  it("a half-filled GitHub setup is not silently ignored", () => {
    const s = studioOnlySettings();
    s.github.owner = "o";
    expect(validateSettings(s).filter((i) => i.severity === "error").map((i) => i.field)).toEqual(["github.repo"]);
  });
});

describe("publishing with only a Studio", () => {
  it("publishes, with no GitHub settings and no GitHub token in the keychain, and never calls GitHub", async () => {
    const { w, studio, env } = setup({ "blyg/N.md": "Hello.\n" }, "blyg/N.md", studioOnlySettings());
    const out = await runPublish(env);
    expect(out).toMatchObject({ status: "published", version: 1 });
    expect(studio.writes()).toHaveLength(2);
    expect(w.calls).toEqual([]);
  });

  it("withdraws too", async () => {
    const { env, studio } = setup({ "blyg/N.md": "Hello.\n" }, "blyg/N.md", studioOnlySettings());
    expect((await runPublish(env)).status).toBe("published");
    expect(await runWithdraw(env)).toMatchObject({ status: "published" });
    expect([...studio.items.values()][0]?.status).toBe("withdrawn");
  });

  it("a note outside every route is still refused (fail closed)", async () => {
    const { studio, env } = setup({ "elsewhere/N.md": "Hello.\n" }, "elsewhere/N.md", studioOnlySettings());
    expect((await runPublish(env)).status).toBe("refused");
    expect(studio.seen).toEqual([]);
  });
});

describe("a missing GitHub setup never blocks a Studio route", () => {
  const mixed = (): BlygSettings => {
    const s = studioOnlySettings();
    s.github = { ...s.github, owner: "o", repo: "r", tokenSecretName: "gh-token" };
    s.routes = [{ vaultPrefix: "studio/", mode: "studio", label: "Blyg item" }, ...MACRO_ROUTES];
    return s;
  };

  it("with no GitHub token on this device, a Studio note still publishes", async () => {
    const { studio, env } = setup({ "studio/N.md": "Hello.\n" }, "studio/N.md", mixed());
    expect((await runPublish(env)).status).toBe("published");
    expect(studio.writes()).toHaveLength(2);
  });

  it("and a GitHub note says what is missing, without a request", async () => {
    const { w, env } = setup({ "website/blyg/N.md": "Hello.\n" }, "website/blyg/N.md", mixed());
    const out = await runPublish(env);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/token/i);
    expect(w.calls).toEqual([]);
  });
});
