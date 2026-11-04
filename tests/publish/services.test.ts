// Service behaviour beyond the 13 parity scenarios: withdraw (the legacy macro had no tests for it), hardening
// the port adds, error paths, branch targeting and the whitespace rule. New coverage, not parity.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMPTY_CONTENT_HASH } from "../../src/core/hash";
import { HttpError } from "../../src/platform/http";
import { TOKEN } from "../helpers";
import { frontmatterOf, has, makeWorld, repoText, sha1, tap, tapWithdraw, type World } from "../world";

const NOTE = "website/blyg/Note.md";

/** Publish NOTE once and return the world plus the minted id. */
async function published(body = "first\n"): Promise<{ w: World; id: string; notePath: string }> {
  const w = makeWorld({ vault: { [NOTE]: body } });
  const out = await tap(w, NOTE);
  const id = out.id ?? "";
  expect(id).toHaveLength(26);
  return { w, id, notePath: `src/content/notes/${id}.md` };
}

describe("withdraw", () => {
  it("commits an endcap: version +1, flag, empty body, hash of the empty string, 'withdrawn' changelog entry", async () => {
    const { w, id, notePath } = await published("Some words.\n");
    w.now = "2026-10-02T09:00:00.000Z";
    const out = await tapWithdraw(w, NOTE);
    expect(out).toMatchObject({ status: "committed", id, version: 2 });
    expect(out.notices).toEqual(["Withdrawn: committed v2 to main. The site deploys after its checks pass (about 1–2 minutes)."]);
    expect(id).toHaveLength(26);
    expect(w.commits.at(-1)).toMatchObject({ path: notePath, message: `content: withdraw note ${id} (v2)` });
    const committed = repoText(w, notePath) ?? "";
    expect(committed.endsWith("\n---\n")).toBe(true); // frontmatter only, empty body
    const fm = frontmatterOf(committed);
    expect(fm).toMatchObject({ blyg_version: 2, blyg_withdrawn: true, blyg_hash: EMPTY_CONTENT_HASH });
    expect((fm.blyg_changelog as { version: number; note: string | null }[]).at(-1)).toMatchObject({ version: 2, note: "withdrawn" });
  });

  it("never touches the local body, only the frontmatter flag", async () => {
    const { w } = await published("Some words.\n");
    await tapWithdraw(w, NOTE);
    const local = w.local.get(NOTE) ?? "";
    expect(local.endsWith("---\nSome words.\n")).toBe(true);
    expect(local).toMatch(/blyg_withdrawn: true/);
  });

  it("is a no-op when already withdrawn", async () => {
    const { w } = await published();
    await tapWithdraw(w, NOTE);
    const commits = w.commits.length;
    const out = await tapWithdraw(w, NOTE);
    expect(out).toMatchObject({ status: "noop", notices: ["Already withdrawn — nothing was committed."] });
    expect(w.commits).toHaveLength(commits);
  });

  it("a normal publish afterwards un-withdraws: a new version, flag gone locally and in the commit", async () => {
    const { w, id, notePath } = await published("Some words.\n");
    await tapWithdraw(w, NOTE);
    w.now = "2026-10-03T09:00:00.000Z";
    const out = await tap(w, NOTE);
    expect(out).toMatchObject({ status: "committed", version: 3 });
    expect(frontmatterOf(repoText(w, notePath) ?? "")).not.toHaveProperty("blyg_withdrawn");
    expect(w.local.get(NOTE)).not.toMatch(/blyg_withdrawn/);
    expect(repoText(w, notePath)).toContain("Some words.");
    expect(out.id).toBe(id);
  });

  it("refuses without a blyg_id, outside a Blyg route, and when nothing is committed — no writes", async () => {
    const fresh = makeWorld({ vault: { [NOTE]: "text\n", "website/essays/E.md": "---\ntitle: t\n---\nx\n" } });
    expect(await tapWithdraw(fresh, NOTE)).toMatchObject({ status: "refused", notices: [expect.stringMatching(/no blyg_id/)] });
    expect(await tapWithdraw(fresh, "website/essays/E.md")).toMatchObject({ status: "refused", notices: [expect.stringMatching(/not in a Blyg folder/)] });
    expect(await tapWithdraw(fresh, "elsewhere/x.md")).toMatchObject({ status: "refused" });
    expect(fresh.calls).toHaveLength(0);

    const { w, notePath } = await published();
    w.repo.delete(notePath);
    const out = await tapWithdraw(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/nothing is committed/);
  });

  it("reports a write race (409) and commits nothing", async () => {
    const { w } = await published();
    const before = w.commits.length;
    w.beforePut = (p) => {
      w.beforePut = null;
      w.repo.set(p, { text: w.repo.get(p)?.text + "\n# other device\n", sha: sha1("other") });
    };
    const out = await tapWithdraw(w, NOTE);
    expect(out.status).toBe("failed");
    expect(out.notices[0]).toMatch(/^409/);
    expect(w.commits).toHaveLength(before);
    expect(w.local.get(NOTE)).not.toMatch(/blyg_withdrawn/);
  });

  it("stamps the local note only after the commit landed; a stamp failure is reported", async () => {
    const { w, id } = await published();
    w.failStamp = true;
    const out = await tapWithdraw(w, NOTE);
    expect(out).toMatchObject({ status: "committed", localStampFailed: true });
    expect(out.notices[0]).toMatch(new RegExp(`Withdrew ${id} v2 on main, but writing the local frontmatter failed`));
  });
});

// The format the legacy macro (Obsidian's YAML writer) really committed: ISO timestamps unquoted, empty `note:`.
// Invented id and text; the layout is copied from a note published from the iPad on 2026-10-01.
describe("republishing an item the legacy macro published", () => {
  const ID = "7c9wk2mhq0v3xj8tn5rzfd41bg";
  const PATH = `src/content/notes/${ID}.md`;
  const MACRO_WRITTEN = [
    "---",
    'blyg: "0.2"',
    `blyg_id: ${ID}`,
    "blyg_version: 1",
    "blyg_created: 2026-10-01T10:32:16.835Z",
    "blyg_updated: 2026-10-01T10:32:16.835Z",
    "blyg_hash: sha256:00",
    "blyg_changelog:",
    "  - version: 1",
    "    at: 2026-10-01T10:32:16.835Z",
    "    note:",
    "---",
    "",
    "An invented first version.",
    "",
  ].join("\n");
  const vault = `---\nblyg_id: ${ID}\n---\nAn invented second version.\n`;

  it("an edit publishes version 2 on top of it, keeping created and the first changelog entry", async () => {
    const w = makeWorld({ vault: { [NOTE]: vault }, repo: { [PATH]: MACRO_WRITTEN } });
    w.now = "2026-10-05T08:00:00.000Z";
    const out = await tap(w, NOTE);
    expect(out).toMatchObject({ status: "committed", id: ID, version: 2 });
    const fm = frontmatterOf(repoText(w, PATH) ?? "");
    expect(String(fm.blyg_created)).toContain("2026-10-01T10:32:16.835");
    expect((fm.blyg_changelog as unknown[]).length).toBe(2);
    expect(w.commits[0]?.providedSha).toBeTruthy();
  });

  it("can be withdrawn", async () => {
    const w = makeWorld({ vault: { [NOTE]: vault }, repo: { [PATH]: MACRO_WRITTEN } });
    const out = await tapWithdraw(w, NOTE);
    expect(out).toMatchObject({ status: "committed", version: 2 });
    expect(frontmatterOf(repoText(w, PATH) ?? "")).toMatchObject({ blyg_withdrawn: true });
  });
});

describe("hardening the port adds to the macro's behaviour", () => {
  it("refuses a blyg_id that is not a valid id before any network call (it would become part of a repo path)", async () => {
    for (const bad of ["../../x", "short", "7C9WK2MHQ0V3XJ8TN5RZFD41BG", "src/content/essays/x"]) {
      const w = makeWorld({ vault: { [NOTE]: `---\nblyg_id: ${bad}\n---\nbody\n` } });
      for (const out of [await tap(w, NOTE), await tapWithdraw(w, NOTE)]) {
        expect(out.status, bad).toBe("refused");
        expect(out.notices[0]).toMatch(/not a valid Blyg id/);
      }
      expect(w.calls, bad).toHaveLength(0);
    }
    const numeric = makeWorld({ vault: { [NOTE]: "---\nblyg_id: 12345\n---\nbody\n" } });
    expect((await tap(numeric, NOTE)).status).toBe("refused");
  });

  it("refuses to build on a damaged committed file and commits nothing", async () => {
    const { w, notePath } = await published();
    const before = w.commits.length;
    for (const damaged of ["no frontmatter at all\n", "---\nblyg_version: two\nblyg_created: x\n---\n\nbody\n", "---\nblyg_created: x\nblyg_changelog: nope\n---\n"]) {
      w.repo.set(notePath, { text: damaged, sha: sha1(damaged) });
      w.local.set(NOTE, (w.local.get(NOTE) ?? "") + "more\n");
      const out = await tap(w, NOTE);
      expect(out.status, damaged).toBe("failed");
      expect(w.commits).toHaveLength(before);
    }
  });

  it("an id locally but nothing committed is refused, not re-created", async () => {
    const { w, notePath } = await published();
    w.repo.delete(notePath);
    w.local.set(NOTE, (w.local.get(NOTE) ?? "") + "edit\n");
    const before = w.commits.length;
    const out = await tap(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/nothing committed at .* on main/);
    expect(w.commits).toHaveLength(before);
  });

  it("the Blyg route refuses files that are not Markdown (an image or canvas in the folder), before any network call", async () => {
    const w = makeWorld({ vault: { "website/blyg/diagram.canvas": "{}", "website/blyg/pic.png": "x" } });
    for (const [path, extension] of [["website/blyg/diagram.canvas", "canvas"], ["website/blyg/pic.png", "png"]] as const) {
      const out = await tap(w, path, { extension });
      expect(out.status, path).toBe("refused");
      expect(out.notices[0]).toMatch(/not a Markdown file/);
    }
    expect(w.calls).toHaveLength(0);
    expect(w.previews).toHaveLength(0);
  });

  it("refuses a plain route that has no repository folder", async () => {
    const w = makeWorld({
      vault: { "a/x.md": "---\ntitle: t\n---\nb\n" },
      settings: { routes: [{ vaultPrefix: "a/", mode: "plain", label: "thing" }] },
    });
    const out = await tap(w, "a/x.md");
    expect(out.status).toBe("refused");
    expect(w.calls).toHaveLength(0);
  });

  it("a plain route whose folder points at the items folder is refused", async () => {
    const w = makeWorld({
      vault: { "a/x.md": "---\ntitle: t\n---\nb\n" },
      settings: { routes: [{ vaultPrefix: "a/", mode: "plain", dest: "src/content/notes/", label: "thing" }] },
    });
    expect((await tap(w, "a/x.md")).status).toBe("refused");
    expect(w.commits).toHaveLength(0);
  });
});

describe("failures are reported honestly", () => {
  it("a network error on the committed-file read stops before any write", async () => {
    const { w, notePath } = await published();
    w.fail.set(`GET ${notePath}`, new HttpError("offline"));
    w.local.set(NOTE, (w.local.get(NOTE) ?? "") + "more\n");
    const before = w.commits.length;
    const out = await tap(w, NOTE);
    expect(out).toMatchObject({ status: "failed", notices: [expect.stringMatching(/Network or parse error/)] });
    expect(w.commits).toHaveLength(before);
  });

  it("a network error on the write says nothing changed and leaves the local note untouched", async () => {
    const id = "7c9wk2mhq0v3xj8tn5rzfd41bg";
    const local = `---\nblyg_id: ${id}\n---\nhello\n`;
    const committed = `---\nblyg: "0.2"\nblyg_id: ${id}\nblyg_version: 1\nblyg_created: c\nblyg_updated: c\nblyg_hash: sha256:other\nblyg_changelog: []\n---\n\nold\n`;
    const w = makeWorld({ vault: { [NOTE]: local }, repo: { [`src/content/notes/${id}.md`]: committed } });
    w.fail.set(`PUT src/content/notes/${id}.md`, new HttpError("offline"));
    const out = await tap(w, NOTE);
    expect(out).toMatchObject({ status: "failed", notices: [expect.stringMatching(/safe to retry/)] });
    expect(w.local.get(NOTE)).toBe(local);
    expect(w.commits).toHaveLength(0);
  });

  it("other statuses are named, and 409 and 422 both mean 'someone else wrote first'", async () => {
    const w = makeWorld({ vault: { "website/pages/p.md": "---\ntitle: t\n---\nbody\n" } });
    w.fail.set("GET src/content/pages/p.md", { status: 500, text: "{}" });
    expect(await tap(w, "website/pages/p.md")).toMatchObject({ status: "failed", notices: ["Unexpected GET status 500 — see console."] });
    w.fail.clear();
    w.fail.set("PUT src/content/pages/p.md", { status: 422, text: "{}" });
    expect((await tap(w, "website/pages/p.md")).notices[0]).toMatch(/^422 — someone else changed this/);
    w.fail.set("PUT src/content/pages/p.md", { status: 403, text: JSON.stringify({ message: "forbidden" }) });
    expect((await tap(w, "website/pages/p.md")).notices[0]).toBe("Publish failed: 403 — see console.");
    w.fail.set("PUT src/content/pages/p.md", { status: 404, text: "{}" });
    expect((await tap(w, "website/pages/p.md")).notices[0]).toMatch(/repository or the branch "main" was not found/);
    expect(w.commits).toHaveLength(0);
  });

  it("when the commit landed but the local stamp failed, it says so and does not claim a clean publish", async () => {
    const w = makeWorld({ vault: { [NOTE]: "hello\n" } });
    w.failStamp = true;
    const out = await tap(w, NOTE);
    expect(out).toMatchObject({ status: "committed", localStampFailed: true });
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]).toMatch(/to main, but writing the local frontmatter failed/);
    expect(w.commits).toHaveLength(1);
  });

  it("no outcome ever contains the token", async () => {
    const w = makeWorld({ vault: { "website/pages/p.md": "---\ntitle: t\n---\nbody\n" } });
    w.fail.set("GET src/content/pages/p.md", { status: 500, text: JSON.stringify({ message: `oops ${TOKEN}` }) });
    expect(JSON.stringify(await tap(w, "website/pages/p.md"))).not.toContain(TOKEN);
    w.fail.set("GET src/content/pages/p.md", new HttpError(`socket closed Bearer ${TOKEN}`));
    expect(JSON.stringify(await tap(w, "website/pages/p.md"))).not.toContain(TOKEN);
  });
});

describe("settings the services honour", () => {
  it("every read and write targets the configured branch", async () => {
    const w = makeWorld({ vault: { [NOTE]: "hello\n", "website/essays/E.md": "---\ntitle: T\n---\n![[a.png]]\n" }, settings: { branch: "preview" } });
    await tap(w, NOTE);
    await tap(w, "website/essays/E.md");
    await tap(w, NOTE); // no-op re-read
    expect(w.commits.length).toBeGreaterThan(0);
    expect(w.commits.every((c) => c.branch === "preview")).toBe(true);
    expect(w.refs.length).toBeGreaterThan(0);
    expect(w.refs.every((r) => r === "preview")).toBe(true);
  });

  it("uses the configured items folder, fragment cap and attachments folder", async () => {
    const w = makeWorld({
      vault: { [NOTE]: "x".repeat(60) + "\n", "website/essays/E.md": "---\ntitle: T\n---\n![[a.png]]\n", "Attachments/a.png": "x" },
      settings: { itemsDir: "content/items", fragmentCharCap: 50, attachmentsDir: "static/img" },
    });
    expect((await tap(w, NOTE)).notices[0]).toMatch(/over the 50-char fragment cap/);
    w.local.set(NOTE, "short\n");
    const out = await tap(w, NOTE);
    expect(out.commit?.path).toMatch(/^content\/items\/[0-9a-z]{26}\.md$/);
    await tap(w, "website/essays/E.md");
    expect(w.calls).toContain("GET static/img");
  });

  it("a cap above the contract's is ignored: 1001 characters are refused, before any network call", async () => {
    const w = makeWorld({ vault: { [NOTE]: "x".repeat(1001) }, settings: { fragmentCharCap: 50000 } });
    const out = await tap(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/over the 1000-char fragment cap/);
    expect(w.calls).toHaveLength(0);
  });

  it("the whitespace rule: off, a trailing space is a change; on, it is 'no changes'; real edits still publish exactly as typed", async () => {
    const text = "---\ntitle: T\n---\nBody\n";
    const off = makeWorld({ vault: { "website/pages/p.md": text + " " }, repo: { "src/content/pages/p.md": text } });
    expect((await tap(off, "website/pages/p.md")).status).toBe("committed");

    const on = makeWorld({ vault: { "website/pages/p.md": text + "  \n" }, repo: { "src/content/pages/p.md": text }, settings: { ignoreTrailingWhitespace: true } });
    expect(await tap(on, "website/pages/p.md")).toMatchObject({ status: "noop" });
    expect(on.commits).toHaveLength(0);

    const edited = text.replace("Body", "Body changed ") + "  \n";
    on.local.set("website/pages/p.md", edited);
    expect((await tap(on, "website/pages/p.md")).status).toBe("committed");
    expect(repoText(on, "src/content/pages/p.md")).toBe(edited); // the committed text is the exact local text
  });
});

// The files the plugin would commit, written out so they can be copied into a scratch checkout of the site and run
// through the site's own `npm test` (docs/TESTING.md layer 4). Not asserted against the site here: it is not attached.
describe("contract fixtures", () => {
  it("writes the files a publish / update / withdraw / plain publish commits into tests/fixtures/out/", async () => {
    const out = new URL("../fixtures/out/", import.meta.url);
    mkdirSync(out, { recursive: true });
    const w = makeWorld({ vault: { [NOTE]: "Prüfung: Äöü ß — 🌿 first note\n", "website/essays/Wrestling With Eels.md": "---\ntitle: \"Wrestling With Eels\"\n---\n\nBody.\n" } });
    const first = await tap(w, NOTE);
    const id = first.id ?? "";
    const save = (name: string) => writeFileSync(new URL(name, out), repoText(w, `src/content/notes/${id}.md`) ?? "");
    save("blyg-v1.md");
    w.now = "2026-10-01T06:05:00.000Z";
    w.local.set(NOTE, (w.local.get(NOTE) ?? "") + "A new sentence.\n");
    await tap(w, NOTE);
    save("blyg-v2.md");
    w.now = "2026-10-01T06:10:00.000Z";
    await tapWithdraw(w, NOTE);
    save("blyg-v3-withdrawn.md");
    await tap(w, "website/essays/Wrestling With Eels.md");
    writeFileSync(new URL("essay.md", out), repoText(w, "src/content/essays/Wrestling With Eels.md") ?? "");

    expect(has(first.notices, /Committed v1 to main/)).toBe(true);
    expect(w.commits).toHaveLength(4);
  });
});
