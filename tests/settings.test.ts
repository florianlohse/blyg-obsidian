import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/settings/migrate";
import { defaultSettings, SCHEMA_VERSION } from "../src/settings/schema";
import { describeField, validateSettings } from "../src/settings/validate";

/** The settings of someone who publishes to a GitHub-hosted site: the default Blyg (GitHub) route, which a new install no longer starts with. */
const githubDefaults = () => {
  const s = defaultSettings();
  s.routes = [{ vaultPrefix: "blyg/", mode: "blyg", label: "Blyg item" }];
  return s;
};

describe("defaults", () => {
  it("are generic placeholders: no owner, repo, origin or secret name", () => {
    const d = defaultSettings();
    expect(d.github.owner).toBe("");
    expect(d.github.repo).toBe("");
    expect(d.github.tokenSecretName).toBe("");
    expect(d.blyg.origin).toBe("");
    expect(d.blyg.previewOrigin).toBe("");
    expect(d.routes).toEqual([{ vaultPrefix: "blyg/", mode: "studio", label: "Blyg item" }]);
  });

  it("return a fresh object each time", () => {
    const a = defaultSettings();
    a.routes.push({ vaultPrefix: "x/", mode: "blyg", label: "x" });
    expect(defaultSettings().routes).toHaveLength(1);
  });
});

describe("templates", () => {
  it("default to none, are read from stored data, and ignore junk", () => {
    expect(defaultSettings().templates).toEqual({ fragment: "", thread: "" });
    expect(migrateSettings({ templates: { fragment: "T/F.md", thread: 3 } }).settings.templates).toEqual({ fragment: "T/F.md", thread: "" });
    expect(migrateSettings({ templates: "x" }).settings.templates).toEqual({ fragment: "", thread: "" });
  });
  it("warn when a template sits inside a publish folder", () => {
    const s = defaultSettings();
    s.templates.thread = "blyg/Templates/Thread.md";
    s.templates.fragment = "Templates/Fragment.md";
    const issues = validateSettings(s).filter((i) => i.field.startsWith("templates."));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "templates.thread", severity: "warning" });
    expect(describeField("templates.thread")).toBe("Thread template");
  });
});

describe("migrateSettings", () => {
  it("gives the defaults for missing or non-object data", () => {
    for (const raw of [undefined, null, 42, "x", []]) {
      const r = migrateSettings(raw);
      expect(r.settings).toEqual(defaultSettings());
      expect(r.fromNewerVersion).toBe(false);
    }
  });

  it("keeps valid stored values and fills the rest from the defaults", () => {
    const r = migrateSettings({
      schemaVersion: 1,
      github: { owner: "someone", repo: "site", useBranch: "preview", tokenSecretName: "my-token" },
      blyg: { fragmentCharCap: 500 },
      routes: [{ vaultPrefix: "notes/", mode: "plain", dest: "src/content/essays/", label: "Essay", requireTitle: true }],
    });
    expect(r.settings.github).toMatchObject({ owner: "someone", repo: "site", useBranch: "preview", branch: "main" });
    expect(r.settings.github.tokenSecretName).toBe("my-token");
    expect(r.settings.blyg.fragmentCharCap).toBe(500);
    expect(r.settings.blyg.threadSoftCap).toBe(50000);
    expect(r.settings.routes).toEqual([
      { vaultPrefix: "notes/", mode: "plain", dest: "src/content/essays/", label: "Essay", requireTitle: true },
    ]);
  });

  it("replaces values of the wrong type instead of trusting them", () => {
    const r = migrateSettings({
      github: { owner: 5, useBranch: "elsewhere" },
      blyg: { fragmentCharCap: -3, threadSoftCap: "big" },
      routes: [null, "x", { mode: "weird" }],
      reader: { sourcesStore: "cloud", pollMinutes: 0 },
    });
    expect(r.settings.github.owner).toBe("");
    expect(r.settings.github.useBranch).toBe("production");
    expect(r.settings.blyg.fragmentCharCap).toBe(1000);
    expect(r.settings.blyg.threadSoftCap).toBe(50000);
    expect(r.settings.routes).toEqual([{ vaultPrefix: "", mode: "blyg", label: "Blyg note" }]);
    expect(r.settings.reader.sourcesStore).toBe("repo");
    expect(r.settings.reader.pollMinutes).toBe(60);
  });

  it("flags data written by a newer plugin version so it is never saved over", () => {
    const r = migrateSettings({ schemaVersion: SCHEMA_VERSION + 1, github: { owner: "someone" } });
    expect(r.fromNewerVersion).toBe(true);
    expect(r.settings.github.owner).toBe("someone");
  });

  it("never stores anything that looks like a token field", () => {
    const r = migrateSettings({ github: { token: "ghp_shouldnotsurvive", tokenSecretName: "x" } });
    expect(JSON.stringify(r.settings)).not.toContain("shouldnotsurvive");
  });
});

describe("validateSettings", () => {
  const valid = () => {
    const s = githubDefaults();
    s.github.owner = "someone";
    s.github.repo = "site";
    return s;
  };
  const fields = (s = valid()) => validateSettings(s).map((i) => i.field);

  it("accepts a complete, ordinary configuration", () => {
    expect(validateSettings(valid())).toEqual([]);
  });

  it("requires owner and repository, in the right shape", () => {
    expect(fields(githubDefaults())).toEqual(["github.owner", "github.repo"]);
    const s = valid();
    s.github.repo = "someone/site";
    expect(fields(s)).toContain("github.repo");
  });

  it("requires distinct branches", () => {
    const s = valid();
    s.github.previewBranch = "main";
    expect(fields(s)).toContain("github.previewBranch");
  });

  it("checks origins: https and a trailing slash, empty allowed", () => {
    const s = valid();
    s.blyg.origin = "http://example.com/blyg/";
    s.blyg.previewOrigin = "https://example.com/blyg";
    expect(fields(s)).toEqual(["blyg.origin", "blyg.previewOrigin"]);
    s.blyg.origin = "https://example.com/blyg/";
    s.blyg.previewOrigin = "";
    expect(fields(s)).toEqual([]);
  });

  it("default user agent is the plain plugin name, not the old plugin id or a repo name", () => {
    expect(defaultSettings().reader.userAgent).toBe("blyg/{version}");
  });

  it("checks keychain entry names", () => {
    const s = valid();
    s.github.tokenSecretName = "My Token";
    expect(fields(s)).toContain("github.tokenSecretName");
    s.github.tokenSecretName = "obsidian-blyg-github";
    expect(fields(s)).toEqual([]);
  });

  it("requires route prefixes to end with a slash and not start with one", () => {
    const s = valid();
    s.routes = [{ vaultPrefix: "blyg", mode: "blyg", label: "Blyg note" }];
    expect(fields(s)).toContain("routes[0].vaultPrefix");
    s.routes = [{ vaultPrefix: "/blyg/", mode: "blyg", label: "Blyg note" }];
    expect(fields(s)).toContain("routes[0].vaultPrefix");
  });

  it("refuses overlapping routes", () => {
    const s = valid();
    s.routes = [
      { vaultPrefix: "website/", mode: "blyg", label: "a" },
      { vaultPrefix: "website/blyg/", mode: "blyg", label: "b" },
    ];
    expect(fields(s)).toEqual(["routes[1].vaultPrefix"]);
  });

  it("needs a destination for plain routes and never allows the items folder", () => {
    const s = valid();
    s.routes = [{ vaultPrefix: "essays/", mode: "plain", label: "Essay" }];
    expect(fields(s)).toContain("routes[0].dest");
    s.routes = [{ vaultPrefix: "essays/", mode: "plain", dest: "src/content/notes/", label: "Essay" }];
    expect(validateSettings(s).map((i) => i.message).join(" ")).toContain("never write into the Blyg items folder");
    s.routes = [{ vaultPrefix: "essays/", mode: "plain", dest: "src/content/essays/", label: "Essay" }];
    expect(fields(s)).toEqual([]);
  });

  it("errors on a fragment cap above the site's limit, accepts anything up to it", () => {
    const s = valid();
    s.blyg.fragmentCharCap = 1001;
    const issue = validateSettings(s).find((i) => i.field === "blyg.fragmentCharCap");
    expect(issue).toMatchObject({ severity: "error" });
    expect(issue?.message).toMatch(/fail the site's build/);
    for (const ok of [1, 500, 1000]) {
      s.blyg.fragmentCharCap = ok;
      expect(fields(s), String(ok)).toEqual([]);
    }
  });

  it("only warns (does not block) when the items folder differs from the contract's", () => {
    const s = valid();
    s.blyg.itemsDir = "content/items";
    const issues = validateSettings(s);
    expect(issues).toEqual([expect.objectContaining({ field: "blyg.itemsDir", severity: "warning" })]);
    s.blyg.itemsDir = "src/content/notes";
    expect(validateSettings(s)).toEqual([]);
  });

  it("needs at least one route", () => {
    const s = valid();
    s.routes = [];
    expect(fields(s)).toEqual(["routes"]);
  });
});

describe("describeField", () => {
  it("names fields as the settings screen does", () => {
    expect(describeField("github.owner")).toBe("Owner");
    expect(describeField("blyg.previewOrigin")).toBe("Preview blyg address");
    expect(describeField("routes[1].vaultPrefix")).toBe("Route 2 · Vault folder");
    expect(describeField("routes[0].dest")).toBe("Route 1 · Repository folder");
    expect(describeField("routes")).toBe("Routes");
    expect(describeField("something.else")).toBe("something.else");
  });

  it("covers every field the validator can report", () => {
    const s = defaultSettings();
    s.github.owner = "bad owner!";
    s.github.repo = "a/b";
    s.github.branch = "";
    s.github.previewBranch = "";
    s.github.tokenSecretName = "Bad Name";
    s.blyg.origin = "nope";
    s.blyg.previewOrigin = "nope";
    s.blyg.itemsDir = "";
    s.blyg.fragmentCharCap = 0;
    s.routes = [
      { vaultPrefix: "", mode: "plain", label: " " },
      { vaultPrefix: "x", mode: "blyg", label: "x" },
    ];
    for (const issue of validateSettings(s)) {
      expect(describeField(issue.field), issue.field).not.toBe(issue.field);
    }
  });
});

describe("safety settings", () => {
  it("default to blocking links to unpublished notes; migration keeps valid values and repairs invalid ones", () => {
    expect(defaultSettings().safety.outsideLinks).toBe("block");
    expect(migrateSettings({ safety: { outsideLinks: "warn" } }).settings.safety.outsideLinks).toBe("warn");
    expect(migrateSettings({ safety: { outsideLinks: "off" } }).settings.safety.outsideLinks).toBe("off");
    expect(migrateSettings({ safety: { outsideLinks: "sometimes" } }).settings.safety.outsideLinks).toBe("block");
    expect(migrateSettings({}).settings.safety.outsideLinks).toBe("block");
  });
});

describe("deploy watching setting", () => {
  it("is on by default, kept when set, and falls back for junk", () => {
    expect(defaultSettings().github.watchDeploy).toBe(true);
    expect(migrateSettings({}).settings.github.watchDeploy).toBe(true);
    expect(migrateSettings({ github: { watchDeploy: false } }).settings.github.watchDeploy).toBe(false);
    expect(migrateSettings({ github: { watchDeploy: "no" } }).settings.github.watchDeploy).toBe(true);
  });
});

describe("a route's web address", () => {
  const plainRoute = (webUrl?: string) => ({ vaultPrefix: "notes/", mode: "plain" as const, dest: "src/content/essays/", label: "Essay", ...(webUrl !== undefined ? { webUrl } : {}) });
  const withRoute = (route: ReturnType<typeof plainRoute>) => {
    const s = defaultSettings();
    s.github = { ...s.github, owner: "o", repo: "r" };
    s.routes = [route];
    return s;
  };

  it("is read from the saved settings, and left out when absent or not text", () => {
    const read = (webUrl: unknown) => migrateSettings({ routes: [{ vaultPrefix: "notes/", mode: "plain", dest: "x/", label: "E", webUrl }] }).settings.routes[0];
    expect(read("{site}/essays/{slug}/")?.webUrl).toBe("{site}/essays/{slug}/");
    expect(read(42)).not.toHaveProperty("webUrl");
    expect(migrateSettings({ routes: [{ vaultPrefix: "b/", mode: "blyg", label: "B" }] }).settings.routes[0]).not.toHaveProperty("webUrl");
  });

  it("a bad template is a warning on that field, never an error that blocks publishing", () => {
    const issues = validateSettings(withRoute(plainRoute("{site}/{title}/"))).filter((i) => i.field === "routes[0].webUrl");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(describeField("routes[0].webUrl")).toBe("Route 1 · Web address");
  });

  it("a good template or none raises nothing", () => {
    for (const t of [undefined, "", "{site}/essays/{slug}/"]) {
      expect(validateSettings(withRoute(plainRoute(t))).filter((i) => i.field === "routes[0].webUrl")).toEqual([]);
    }
  });
});
