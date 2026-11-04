// The 13 scenarios of reference/legacy-macro/test-obsidian-macro.mjs, re-expressed against the plugin's services
// (publish/*) + GitHub contents client, with the same kinds of fakes (tests/world.ts).
//
// Tagging (so R2 can tell a deliberate change from a regression):
//   [invariant] — a protocol promise, contract rule or safety rule. Never change the assertion.
//   [inherited] — merely what the macro did. R2 may change it on purpose.
// `// R2 changed this` marks an assertion whose wording R2 changed on purpose (honest "Committed … to <branch>" messages,
// never "live"); the behaviour asserted next to it is the macro's. Assertions without the marker are unchanged since R1.3.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { frontmatterOf, has, makeWorld, repoText, sha1, tap } from "../world";

const HOME = "---\ntitle: Home\n---\nI'm Ada Example, an engineer and designer.\n";
const ESSAY = '---\ntitle: "Wrestling With Eels"\ndescription: Can You Observe Yourself?\n---\n\nBody text with ümlauts and 🌿.\n';

describe("parity with the legacy publish macro", () => {
  it("[invariant] 1 routing: paths outside every route are refused, with no network call", async () => {
    const paths = [
      "website/notes/x.md", // the old Blyg folder name
      "website/home.md", // loose file in website/ (not pages/)
      "website/essays-drafts/x.md", // prefix lookalike
      "website/Essays/x.md", // case differs
      "website/blyg.md", // no trailing slash
      "elsewhere/x.md", // not under website/
      "x.md",
    ];
    for (const path of paths) {
      const w = makeWorld({ vault: { [path]: "---\ntitle: x\n---\nbody\n" } });
      const out = await tap(w, path);
      expect(out.status, path).toBe("refused");
      expect(has(out.notices, /Refusing to publish/), path).toBe(true); // wording is R2's
      expect(w.calls, `${path}: must not touch the network`).toHaveLength(0);
      expect(w.commits).toHaveLength(0);
    }
  });

  it("[invariant] 2 pages route: home.md is created, a repeat is a no-op, an edit updates with the sha", async () => {
    const w = makeWorld({ vault: { "website/pages/home.md": HOME } });
    let out = await tap(w, "website/pages/home.md");
    expect(has(out.notices, /Committed new page “home\.md” to main\. The site deploys after its checks pass/)).toBe(true); // R2 changed this: honest wording, never "live"
    expect(repoText(w, "src/content/pages/home.md")).toBe(HOME); // committed bytes equal the vault text
    expect(w.commits[0]?.message).toBe("content: publish page home.md"); // contract §1
    expect(w.commits[0]?.providedSha).toBeUndefined();

    out = await tap(w, "website/pages/home.md");
    expect(out.status).toBe("noop");
    expect(has(out.notices, /No changes since the last publish/)).toBe(true);
    expect(w.commits).toHaveLength(1);

    const edited = HOME + "\nA new line.\n";
    w.local.set("website/pages/home.md", edited);
    out = await tap(w, "website/pages/home.md");
    expect(has(out.notices, /Committed update to page “home\.md” to main/)).toBe(true); // R2 changed this (wording)
    expect(repoText(w, "src/content/pages/home.md")).toBe(edited);
    expect(w.commits).toHaveLength(2);
    expect(w.commits[1]?.providedSha, "an update must send the committed sha").toBeTruthy();
    expect(w.commits.every((c) => c.path === "src/content/pages/home.md")).toBe(true);
  });

  it("[invariant] 3 initial state is kept: an essay already live and identical is a no-op; a changed one updates", async () => {
    const path = "src/content/essays/Wrestling With Eels.md";
    const w = makeWorld({ vault: { "website/essays/Wrestling With Eels.md": ESSAY }, repo: { [path]: ESSAY } });
    let out = await tap(w, "website/essays/Wrestling With Eels.md");
    expect(has(out.notices, /No changes since the last publish/)).toBe(true);
    expect(w.commits, "nothing republished").toHaveLength(0);

    w.local.set("website/essays/Wrestling With Eels.md", ESSAY.replace("Observe", "Watch"));
    out = await tap(w, "website/essays/Wrestling With Eels.md");
    expect(has(out.notices, /Committed update to essay/)).toBe(true); // R2 changed this (wording)
    expect(repoText(w, path)).toMatch(/Can You Watch Yourself/);
  });

  it("[invariant] 4 line endings: a CRLF vault copy of an identical committed file is still a no-op", async () => {
    const path = "src/content/essays/E.md";
    const w = makeWorld({ vault: { "website/essays/E.md": ESSAY.replace(/\n/g, "\r\n") }, repo: { [path]: ESSAY } });
    const out = await tap(w, "website/essays/E.md");
    expect(has(out.notices, /No changes/)).toBe(true);
    expect(w.commits).toHaveLength(0);
  });

  it("[invariant] 5 file names: spaces, ampersand, comma, unicode and subfolders map 1:1", async () => {
    const names = ["Stop Living & Thinking in Boxes.md", "Hollywood is dead, but it may yet be reborn.md", "Über Äpfel.md", "sub/Nested note.md"];
    for (const name of names) {
      const w = makeWorld({ vault: { [`website/essays/${name}`]: ESSAY } });
      await tap(w, `website/essays/${name}`);
      expect(repoText(w, `src/content/essays/${name}`), name).toBe(ESSAY);
    }
  });

  it("[invariant] 6 validation blocks bad frontmatter before any network call", async () => {
    const bad: Record<string, string> = {
      "unquoted colon": "---\ntitle: Foo: bar\n---\nbody\n",
      "unterminated frontmatter": "---\ntitle: Foo\nbody never closes\n",
      "invalid yaml": '---\ntitle: "unclosed\nlist: [a, b\n---\nbody\n',
      "blyg fields in an essay": "---\ntitle: X\nblyg_id: 7c9wk2mhq0v3xj8tn5rzfd41bg\n---\nbody\n",
    };
    for (const [label, text] of Object.entries(bad)) {
      const w = makeWorld({ vault: { "website/essays/Bad.md": text } });
      const out = await tap(w, "website/essays/Bad.md");
      expect(out.status, label).toBe("refused");
      expect(has(out.notices, /Not published/), label).toBe(true); // wording is R2's
      expect(w.calls, `${label}: no network call`).toHaveLength(0);
    }
  });

  it("[inherited] 7 warnings: a missing title is flagged after publishing (essays only)", async () => {
    const noTitle = "---\ndescription: x\n---\nbody\n";
    let w = makeWorld({ vault: { "website/essays/NoTitle.md": noTitle } });
    let out = await tap(w, "website/essays/NoTitle.md");
    expect(has(out.notices, /Committed new essay/) && has(out.notices, /Heads-up:.*title/)).toBe(true); // R2 changed the first part (wording)
    expect(w.commits, "a warning must not block the publish").toHaveLength(1);

    w = makeWorld({ vault: { "website/pages/NoTitle.md": noTitle } });
    out = await tap(w, "website/pages/NoTitle.md");
    expect(has(out.notices, /Heads-up/), "pages do not need a title").toBe(false);
  });

  it("[inherited] 8 images: embeds missing from public/attachments are listed, using the site's lowercase rule", async () => {
    const text = "---\ntitle: T\n---\n![[Dont Look Up.jpg]]\n\n![[Present.PNG]]\n\n![[Present.PNG]]\n";
    // The images exist in the vault (as in a real one); only the repo's attachments folder lacks one of them.
    const w = makeWorld({
      vault: { "website/essays/Img.md": text, "Attachments/Dont Look Up.jpg": "x", "Attachments/Present.PNG": "x" },
      repo: { "public/attachments/present.png": "x" },
    });
    const out = await tap(w, "website/essays/Img.md");
    const heads = out.notices.find((m) => /Heads-up/.test(m)) ?? "";
    expect(heads).toMatch(/dont look up\.jpg/);
    expect(heads).not.toMatch(/present\.png/);
    expect(w.calls, "listed the attachments folder once").toContain("GET public/attachments");

    const noEmbeds = makeWorld({ vault: { "website/essays/Plain.md": ESSAY } });
    await tap(noEmbeds, "website/essays/Plain.md");
    expect(noEmbeds.calls.some((c) => c.includes("attachments")), "no embeds, no listing request").toBe(false);
  });

  it("[invariant] 9 a write race is reported (409), nothing is committed, and a re-run succeeds", async () => {
    const path = "src/content/essays/R.md";
    const w = makeWorld({ vault: { "website/essays/R.md": ESSAY + "mine\n" }, repo: { [path]: ESSAY } });
    w.beforePut = (p) => {
      w.beforePut = null;
      w.repo.set(p, { text: ESSAY + "theirs\n", sha: sha1("theirs") }); // another device wrote first
    };
    let out = await tap(w, "website/essays/R.md");
    expect(has(out.notices, /409/)).toBe(true);
    expect(w.commits).toHaveLength(0);
    out = await tap(w, "website/essays/R.md");
    expect(has(out.notices, /Committed update to essay/)).toBe(true); // R2 changed this (wording)
    expect(repoText(w, path)).toBe(ESSAY + "mine\n");
  });

  it("[invariant] 10 plain routes refuse non-Markdown files and odd paths", async () => {
    let w = makeWorld({ vault: { "website/essays/pic.png": "x" } });
    let out = await tap(w, "website/essays/pic.png", { extension: "png" });
    expect(has(out.notices, /not a Markdown file/)).toBe(true);
    w = makeWorld({ vault: { "website/essays/../x.md": "x" } });
    out = await tap(w, "website/essays/../x.md");
    expect(has(out.notices, /unusable path/)).toBe(true);
    expect(w.calls).toHaveLength(0);
  });

  it("[invariant] 11 a plain route can never write into src/content/notes", async () => {
    for (const path of ["website/essays/a.md", "website/pages/b.md", "website/essays/sub/c.md"]) {
      const w = makeWorld({ vault: { [path]: "---\ntitle: T\n---\nbody\n" } });
      await tap(w, path);
      expect(w.commits.every((c) => !c.path.startsWith("src/content/notes/")), path).toBe(true);
    }
  });

  it("[invariant] 12 Blyg route: first publish, no-op, version bump, caps", async () => {
    const path = "website/blyg/Note.md";
    const body = "Prüfung: Äöü ß — 🌿 first note";
    const w = makeWorld({ vault: { [path]: body + "\n" } });

    let out = await tap(w, path);
    const published = out.notices.find((m) => /^Committed v1 to main \(new id [0-9a-z]{26}\)\. The site deploys/.test(m)); // R2 changed this (wording)
    expect(published, JSON.stringify(out.notices)).toBeTruthy();
    const id = /new id ([0-9a-z]{26})/.exec(published ?? "")?.[1] ?? "";
    expect([...id].some((c) => "ilou".includes(c)), "Crockford alphabet only").toBe(false);
    expect(out.id).toBe(id);
    expect(w.commits).toHaveLength(1);
    expect(w.commits[0]?.path).toBe(`src/content/notes/${id}.md`);
    expect(w.commits[0]?.message).toBe(`content: publish note ${id}`);
    const committed = repoText(w, `src/content/notes/${id}.md`) ?? "";
    const fm = frontmatterOf(committed);
    expect(fm.blyg_version).toBe(1);
    expect(fm.blyg_hash).toBe(`sha256:${createHash("sha256").update(body).digest("hex")}`);
    expect((fm.blyg_changelog as { version: number }[]).map((c) => c.version)).toEqual([1]);
    expect(committed.endsWith(`\n---\n\n${body}\n`), "body committed byte for byte").toBe(true);
    expect(w.local.get(path)).toMatch(new RegExp(`blyg_id: ${id}`)); // local frontmatter written back

    out = await tap(w, path);
    expect(has(out.notices, /No changes since the last publish/)).toBe(true);
    expect(w.commits).toHaveLength(1);

    w.now = "2026-10-01T06:05:00.000Z";
    w.local.set(path, (w.local.get(path) ?? "") + "A new sentence.\n");
    out = await tap(w, path);
    expect(has(out.notices, /^Committed v2 to main\. The site deploys/)).toBe(true); // R2 changed this (wording)
    const fm2 = frontmatterOf(repoText(w, `src/content/notes/${id}.md`) ?? "");
    expect(fm2.blyg_version).toBe(2);
    expect((fm2.blyg_changelog as { version: number }[]).map((c) => c.version)).toEqual([1, 2]);
    expect(w.commits[1]?.message).toBe(`content: update note ${id} to v2`);
    expect(w.commits.every((c) => c.path.startsWith("src/content/notes/")), "the Blyg route writes only under notes/").toBe(true);

    const long = makeWorld({ vault: { [path]: "x".repeat(1001) } });
    out = await tap(long, path);
    expect(has(out.notices, /over the 1000-char fragment cap/)).toBe(true); // wording is R2's
    expect(long.calls).toHaveLength(0);

    const empty = makeWorld({ vault: { [path]: "---\ntitle: x\n---\n\n" } });
    out = await tap(empty, path);
    expect(has(out.notices, /empty/)).toBe(true);
  });

  it("[invariant] 13 Blyg route: a stale local copy publishes on top of the committed state (never a repeated version)", async () => {
    const path = "website/blyg/Stale.md";
    const w = makeWorld({ vault: { [path]: "first\n" } });
    const id = (await tap(w, path)).id ?? "";
    // another device publishes v2 and v3 straight to the repo
    const notePath = `src/content/notes/${id}.md`;
    let t = repoText(w, notePath) ?? "";
    t = t
      .replace("blyg_version: 1", "blyg_version: 3")
      .replace("\n---\n\nfirst", "\n  - version: 3\n    at: 2026-10-01T06:01:00.000Z\n    note: null\n---\n\nfirst plus theirs");
    w.repo.set(notePath, { text: t, sha: sha1(t) });
    w.local.set(path, (w.local.get(path) ?? "").replace("first", "first plus mine"));
    w.now = "2026-10-01T06:10:00.000Z";
    const out = await tap(w, path);
    expect(has(out.notices, /^Committed v4 to main\. The site deploys/)).toBe(true); // R2 changed this (wording)
    expect(out.version).toBe(4);
  });
});
