// R2 behaviour: the user confirms every changing write; private comments never leave the vault; links to unpublished
// notes are caught; notes published to the test channel cannot reach production by accident.
import { describe, expect, it } from "vitest";
import { deploy, has, makeWorld, repoText, tap, tapWithdraw, frontmatterOf } from "../world";

const NOTE = "website/blyg/Note.md";
const ESSAY = "website/essays/Essay.md";

describe("the confirmation step", () => {
  it("asks before a first publish, and shows the target, path, version and the whole new text", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello world\n" } });
    const out = await tap(w, NOTE);
    expect(out.status).toBe("committed");
    expect(w.previews).toHaveLength(1);
    const p = w.previews[0];
    expect(p).toMatchObject({ action: "create", channel: "production", branch: "main", toVersion: 1, before: null, after: "Hello world" });
    expect(p?.path).toMatch(/^src\/content\/notes\/[0-9a-z]{26}\.md$/);
    expect(p?.commitMessage).toBe(`content: publish note ${p?.id}`);
    expect(p?.changes).toContain("Version 1");
  });

  it("cancelling commits nothing and leaves the note untouched", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n" } });
    w.answer = false;
    const out = await tap(w, NOTE);
    expect(out).toMatchObject({ status: "cancelled", notices: ["Cancelled — nothing was committed."] });
    expect(w.commits).toHaveLength(0);
    expect(w.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(w.local.get(NOTE)).toBe("Hello\n");
  });

  it("shows the committed text as 'before' and the new text as 'after' on an update", async () => {
    const w = makeWorld({ vault: { [NOTE]: "First version\n" } });
    await tap(w, NOTE);
    w.local.set(NOTE, (w.local.get(NOTE) ?? "").replace("First version", "Second version"));
    w.previews.length = 0;
    await tap(w, NOTE);
    expect(w.previews[0]).toMatchObject({ action: "update", fromVersion: 1, toVersion: 2, before: "First version", after: "Second version" });
  });

  it("never asks when there is nothing to change", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Same\n" } });
    await tap(w, NOTE);
    w.previews.length = 0;
    const out = await tap(w, NOTE);
    expect(out.status).toBe("noop");
    expect(w.previews).toHaveLength(0);
  });

  it("never asks when the publish is refused or fails before the write", async () => {
    const w = makeWorld({ vault: { [NOTE]: "x".repeat(2000), "elsewhere/x.md": "x" } });
    await tap(w, NOTE);
    await tap(w, "elsewhere/x.md");
    expect(w.previews).toHaveLength(0);
  });

  it("asks before a plain publish, showing the whole file before and after", async () => {
    const before = "---\ntitle: T\n---\nOld body\n";
    const w = makeWorld({ vault: { [ESSAY]: before.replace("Old", "New") }, repo: { "src/content/essays/Essay.md": before } });
    await tap(w, ESSAY);
    expect(w.previews[0]).toMatchObject({ action: "plain-update", label: "essay", before, after: before.replace("Old", "New") });
    w.answer = false;
    w.local.set(ESSAY, before.replace("Old", "Newer"));
    expect((await tap(w, ESSAY)).status).toBe("cancelled");
  });

  it("asks before a withdraw, naming the id and saying it stays public", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Some words\n" } });
    const id = (await tap(w, NOTE)).id ?? "";
    w.previews.length = 0;
    w.answer = false;
    expect((await tapWithdraw(w, NOTE)).status).toBe("cancelled");
    expect(w.previews[0]).toMatchObject({ action: "withdraw", id, fromVersion: 1, toVersion: 2, before: "Some words", after: "" });
    expect(w.previews[0]?.changes.join(" ")).toContain("stays public forever");
    expect(w.repo.get(`src/content/notes/${id}.md`)?.text).not.toContain("blyg_withdrawn");
  });
});

describe("the commit record carries what deploy watching needs", () => {
  it("publish, withdraw and plain writes report the commit sha and the branch they went to", async () => {
    const w = makeWorld({
      vault: { [NOTE]: "Hello\n", [ESSAY]: "---\ntitle: T\n---\nBody\n" },
      settings: { channel: "preview", branch: "preview" },
    });
    const published = await tap(w, NOTE);
    const essay = await tap(w, ESSAY);
    const withdrawn = await tapWithdraw(w, NOTE);
    for (const out of [published, essay, withdrawn]) {
      expect(out.status).toBe("committed");
      expect(out.commit?.branch).toBe("preview");
      expect(out.commit?.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(new Set([published.commit?.sha, essay.commit?.sha, withdrawn.commit?.sha]).size).toBe(3);
  });

  it("a refused or unchanged publish has no commit to watch", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n" } });
    await tap(w, NOTE);
    expect((await tap(w, NOTE)).commit).toBeUndefined();
    w.answer = false;
    expect((await tap(w, ESSAY)).commit).toBeUndefined();
  });
});

describe("honest messages and the target branch", () => {
  it("says 'committed' and names the branch, never 'live'", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n", [ESSAY]: "---\ntitle: T\n---\nBody\n" } });
    const notices = [...(await tap(w, NOTE)).notices, ...(await tap(w, ESSAY)).notices].join(" ");
    expect(notices).toContain("Committed v1 to main");
    expect(notices).toContain("The site deploys after its checks pass");
    expect(notices.toLowerCase()).not.toContain("live");
  });

  it("on preview: writes to the preview branch, says so, and says the preview site deploys", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Hello\n" }, settings: { channel: "preview", branch: "preview" } });
    const out = await tap(w, NOTE);
    expect(out.notices[0]).toMatch(/^Committed v1 to preview \(new id [0-9a-z]{26}\)\. The preview site deploys after its checks pass/);
    expect(w.commits.every((c) => c.branch === "preview")).toBe(true);
    expect(w.previews[0]).toMatchObject({ channel: "preview", branch: "preview" });
  });
});

describe("Obsidian comments are never published", () => {
  it("strips %%…%%, tells the user how many, and the committed file never contains them", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Public line %%my private thought%% more public\n%%\nwhole private block\n%%\nEnd\n" } });
    const out = await tap(w, NOTE);
    const id = out.id ?? "";
    const committed = repoText(w, `src/content/notes/${id}.md`) ?? "";
    expect(committed).not.toContain("private");
    expect(committed).toContain("Public line  more public\nEnd");
    expect(has(out.notices, /Left out 2 Obsidian comments/)).toBe(true);
    expect(w.previews[0]?.after).not.toContain("private");
  });

  it("adding or editing a comment alone is 'no changes' (it never reaches the site)", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Body\n" } });
    await tap(w, NOTE);
    w.local.set(NOTE, (w.local.get(NOTE) ?? "") + "%%a new private comment%%\n");
    const out = await tap(w, NOTE);
    expect(out.status).toBe("noop");
    expect(w.commits).toHaveLength(1);
  });

  it("a comment opening that never closes refuses the publish, before any network call", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Fine\nthen %% oops, never closed\nmore\n", [ESSAY]: "---\ntitle: T\n---\nBody %% never closed\n" } });
    for (const path of [NOTE, ESSAY]) {
      const out = await tap(w, path);
      expect(out.status, path).toBe("refused");
      expect(out.notices[0]).toMatch(/never closes/);
    }
    expect(w.calls).toHaveLength(0);
  });

  it("plain routes: comments are stripped from the body, never from the frontmatter, and the rest is copied as is", async () => {
    const text = "---\ntitle: T\n---\nPublic %%private%% text\n";
    const w = makeWorld({ vault: { [ESSAY]: text } });
    await tap(w, ESSAY);
    expect(repoText(w, "src/content/essays/Essay.md")).toBe("---\ntitle: T\n---\nPublic  text\n");
  });

  it("comments inside code are kept (they are literal there)", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Use `%%` like this:\n```\n%%keep%%\n```\n" } });
    const out = await tap(w, NOTE);
    const committed = repoText(w, `src/content/notes/${out.id}.md`) ?? "";
    expect(committed).toContain("`%%`");
    expect(committed).toContain("%%keep%%");
  });
});

describe("block ids are never published", () => {
  it("a Blyg note and a plain route lose a trailing ^id, hidden Resurface marks included, and the id alone is 'no changes'", async () => {
    const w = makeWorld({ vault: { [NOTE]: "A thought. %%[[Topic]] \u2B50\uFE0F%% ^ab12cd\n", [ESSAY]: "---\ntitle: T\n---\nEssay text. ^e55ay\n" } });
    const out = await tap(w, NOTE);
    const committed = repoText(w, `src/content/notes/${out.id}.md`) ?? "";
    expect(committed).toContain("A thought.");
    expect(committed).not.toMatch(/\^ab12cd|Topic|\u2B50/);
    expect(w.previews[0]?.after).not.toContain("^ab12cd");
    await tap(w, ESSAY);
    expect(repoText(w, "src/content/essays/Essay.md")).toBe("---\ntitle: T\n---\nEssay text.\n");
    // starring (a change inside the hidden comment) or adding an id later changes nothing that is published
    w.local.set(NOTE, (w.local.get(NOTE) ?? "").replace("\u2B50\uFE0F%% ^ab12cd", "\u2B50\uFE0F\u2B50\uFE0F%% ^zz99"));
    expect(w.local.get(NOTE)).toContain("^zz99");
    expect((await tap(w, NOTE)).status).toBe("noop");
  });
});

describe("links to notes that no route publishes", () => {
  const vault = {
    [NOTE]: "See [[Private Plan]] for details\n",
    "Private Plan.md": "secret",
    "website/essays/Other essay.md": "---\ntitle: O\n---\nx\n",
    "Attachments/pic.png": "png",
  };

  it("blocks by default on a blyg route and names the offending links, before any network call", async () => {
    const w = makeWorld({ vault });
    const out = await tap(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toContain("[[Private Plan]]");
    expect(w.calls).toHaveLength(0);
    expect(w.previews).toHaveLength(0);
  });

  it("allows links to notes inside any route (essays may link to each other), Blyg ids and same-note headings", async () => {
    // Since R3 a `[[<blyg id>]]` is an item link: the link check leaves it alone, and it must name a published item.
    const target = "7c9wk2mhq0v3xj8tn5rzfd41bg";
    const w = makeWorld({
      repo: { [`src/content/notes/${target}.md`]: `---\nblyg_id: ${target}\nblyg_version: 1\nblyg_created: 2026-10-01T00:00:00.000Z\nblyg_hash: sha256:00\nblyg_changelog: []\n---\n\nTarget words.\n` },
      vault: {
        ...vault,
        [NOTE]: "Links: [[Other essay]] [[7c9wk2mhq0v3xj8tn5rzfd41bg]] [[#Heading]]\n",
      },
    });
    deploy(w, target, "<p>Target words.</p>");
    expect((await tap(w, NOTE)).status).toBe("committed");
    const essay = makeWorld({ vault: { ...vault, [ESSAY]: "---\ntitle: T\n---\nSee [[Other essay]] and [[Other essay#Part|that]]\n" } });
    expect((await tap(essay, ESSAY)).status).toBe("committed");
  });

  it("blocks links to notes that do not exist yet (dead text now, a leaked title if the note is created outside the folders later)", async () => {
    const w = makeWorld({ vault: { ...vault, [NOTE]: "See [[Future idea]] and [[Another one]]\n" } });
    const out = await tap(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toContain("[[Future idea]] (no such note yet)");
    expect(out.notices[0]).toContain("[[Another one]] (no such note yet)");
    expect(w.calls).toHaveLength(0);
    expect(w.previews).toHaveLength(0);
    const essay = makeWorld({ vault: { ...vault, [ESSAY]: "---\ntitle: T\n---\nSee [[Not written yet]]\n" } });
    expect((await tap(essay, ESSAY)).status).toBe("refused");
  });

  it("names both kinds of problem in one refusal", async () => {
    const w = makeWorld({ vault: { ...vault, [NOTE]: "[[Private Plan]] and [[Future idea]]\n" } });
    const out = await tap(w, NOTE);
    expect(out.notices[0]).toContain("[[Private Plan]] (not in a publish folder)");
    expect(out.notices[0]).toContain("[[Future idea]] (no such note yet)");
  });

  it("once the note exists inside a publish folder the same text publishes", async () => {
    const w = makeWorld({ vault: { ...vault, [NOTE]: "See [[Future idea]]\n" } });
    expect((await tap(w, NOTE)).status).toBe("refused");
    w.local.set("website/essays/Future idea.md", "---\ntitle: F\n---\nx\n");
    expect((await tap(w, NOTE)).status).toBe("committed");
  });

  it("blocks on plain routes too, and ignores links inside code", async () => {
    const w = makeWorld({ vault: { ...vault, [ESSAY]: "---\ntitle: T\n---\nSee [[Private Plan]]\n" } });
    expect((await tap(w, ESSAY)).status).toBe("refused");
    const code = makeWorld({ vault: { ...vault, [ESSAY]: "---\ntitle: T\n---\nWrite `[[Private Plan]]` to link\n" } });
    expect((await tap(code, ESSAY)).status).toBe("committed");
  });

  it("'warn' publishes and adds a heads-up; 'off' neither warns nor blocks", async () => {
    const warn = makeWorld({ vault, settings: { outsideLinks: "warn" } });
    const out = await tap(warn, NOTE);
    expect(out.status).toBe("committed");
    expect(has(out.notices, /Heads-up:.*\[\[Private Plan\]\]/)).toBe(true);
    const missing = makeWorld({ vault: { ...vault, [NOTE]: "See [[Future idea]]\n" }, settings: { outsideLinks: "warn" } });
    const out3 = await tap(missing, NOTE);
    expect(out3.status).toBe("committed");
    expect(has(out3.notices, /Heads-up:.*\[\[Future idea\]\] \(no such note yet\)/)).toBe(true);
    const off = makeWorld({ vault, settings: { outsideLinks: "off" } });
    const out2 = await tap(off, NOTE);
    expect(out2.status).toBe("committed");
    expect(has(out2.notices, /Heads-up/)).toBe(false);
  });

  it("a link inside a comment does not count (the comment is stripped first)", async () => {
    const w = makeWorld({ vault: { ...vault, [NOTE]: "Public %%see [[Private Plan]]%%\n" } });
    expect((await tap(w, NOTE)).status).toBe("committed");
  });
});

describe("notes published to the preview channel cannot reach production by accident", () => {
  it("stamps a local marker on preview, and production refuses the note with a clear message and no network call", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Scratch\n" }, settings: { channel: "preview", branch: "preview" } });
    await tap(w, NOTE);
    expect(w.local.get(NOTE)).toMatch(/blyg_channel: preview/);
    const prod = makeWorld({ vault: { [NOTE]: w.local.get(NOTE) ?? "" } });
    const out = await tap(prod, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices[0]).toMatch(/published to the preview \(test\) channel/);
    expect(prod.calls).toHaveLength(0);
    expect((await tapWithdraw(prod, NOTE)).status).toBe("refused");
  });

  it("the marker never reaches the committed file", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Scratch\n" }, settings: { channel: "preview", branch: "preview" } });
    const out = await tap(w, NOTE);
    const fm = frontmatterOf(repoText(w, `src/content/notes/${out.id}.md`) ?? "");
    expect(fm).not.toHaveProperty("blyg_channel");
  });

  it("the test channel can republish and withdraw its own notes (marker stays)", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Scratch\n" }, settings: { channel: "preview", branch: "preview" } });
    await tap(w, NOTE);
    w.local.set(NOTE, (w.local.get(NOTE) ?? "") + "More\n");
    expect((await tap(w, NOTE)).status).toBe("committed");
    expect((await tapWithdraw(w, NOTE)).status).toBe("committed");
    expect(w.local.get(NOTE)).toMatch(/blyg_channel: preview/);
  });

  it("a note published to production carries no channel marker", async () => {
    const w = makeWorld({ vault: { [NOTE]: "Real\n" } });
    await tap(w, NOTE);
    expect(w.local.get(NOTE)).not.toMatch(/blyg_channel/);
  });
});

// Found on the iPad (2026-10-07, 0.0.4): right after a withdraw, "publish again" said "No changes" and an edit offered
// "version 3 → 4" although v4 (the withdrawal) was already committed. The app's HTTP layer had cached the earlier read.
describe("reads right after our own write are never stale", () => {
  const NOTE2 = "website/blyg/Note.md";

  it("withdraw, then publish again (no edit): un-withdraws as a new version, with the withdrawn text as 'before'", async () => {
    const w = makeWorld({ vault: { [NOTE2]: "Some words\n" } });
    w.httpCache = true;
    const first = await tap(w, NOTE2);
    expect(first.version).toBe(1);
    expect((await tapWithdraw(w, NOTE2)).version).toBe(2);

    w.previews.length = 0;
    const again = await tap(w, NOTE2);
    expect(again.status).toBe("committed");
    expect(again.version).toBe(3);
    expect(w.previews[0]).toMatchObject({ action: "update", fromVersion: 2, toVersion: 3, before: "" });
    expect(w.previews[0]?.changes).toContain("The item is no longer withdrawn");
  });

  it("publish, edit, publish, edit, publish within a minute: every publish builds on the one before", async () => {
    const w = makeWorld({ vault: { [NOTE2]: "One\n" } });
    w.httpCache = true;
    await tap(w, NOTE2);
    for (const [from, to, version] of [["One", "Two", 2], ["Two", "Three", 3], ["Three", "Four", 4]] as const) {
      w.local.set(NOTE2, (w.local.get(NOTE2) ?? "").replace(from, to));
      const out = await tap(w, NOTE2);
      expect(out, `${from} → ${to}`).toMatchObject({ status: "committed", version });
      expect(w.previews.at(-1)).toMatchObject({ fromVersion: version - 1, before: from, after: to });
    }
  });

  it("every read asks for a fresh answer: a no-cache header and a URL nobody has asked before", async () => {
    const w = makeWorld({ vault: { [NOTE2]: "One\n", "website/essays/E.md": "---\ntitle: T\n---\nBody ![[a.png]]\n", "Attachments/a.png": "x" } });
    await tap(w, NOTE2);
    w.local.set(NOTE2, (w.local.get(NOTE2) ?? "").replace("One", "Two"));
    await tap(w, NOTE2);
    await tap(w, NOTE2); // no-op: reads the committed file again
    await tap(w, "website/essays/E.md"); // reads the file and, after the commit, the attachments folder
    const reads = w.requests.filter((r) => r.method === "GET");
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const r of reads) {
      expect(r.headers["Cache-Control"], r.url).toBe("no-cache");
      expect(new URL(r.url).searchParams.get("_"), r.url).toBeTruthy();
    }
    expect(new Set(reads.map((r) => r.url)).size).toBe(reads.length); // no two reads share a URL, so none can be answered from a cache
  });
});

describe("the preview shows how each link was judged", () => {
  const vault = {
    "Notes/Private Plan.md": "secret",
    "website/essays/Real essay.md": "---\ntitle: R\n---\nx\n",
    "Attachments/pic.png": "png",
  };

  it("classifies published, outside, file and unresolved links (with 'warn', so the window opens)", async () => {
    // An essay: its text is copied as it is, so an image embed is fine there (in a Blyg note it would break the site's deploy).
    const w = makeWorld({
      vault: { ...vault, [ESSAY]: "---\ntitle: T\n---\nSee [[Real essay]], [[Private Plan]], ![[pic.png]] and [[Nowhere]].\n" },
      settings: { outsideLinks: "warn" },
    });
    await tap(w, ESSAY);
    const links = w.previews[0]?.links ?? [];
    expect(links.map((l) => [l.target, l.kind])).toEqual([
      ["Real essay", "published"],
      ["Private Plan", "outside"],
      ["pic.png", "file"],
      ["Nowhere", "unresolved"],
    ]);
    expect(links[0]?.path).toBe("website/essays/Real essay.md");
    expect(w.previews[0]?.blygNote).toBe(false);
  });

  it("a link to a note inside a publish folder is allowed even from a Blyg note, and is shown as such", async () => {
    const w = makeWorld({ vault: { ...vault, [NOTE]: "Read [[Real essay]].\n" } });
    const out = await tap(w, NOTE);
    expect(out.status).toBe("committed");
    expect(w.previews[0]?.links).toEqual([{ target: "Real essay", embed: false, kind: "published", path: "website/essays/Real essay.md" }]);
  });

  it("even with the check off the window still tells the truth about each link", async () => {
    const w = makeWorld({ vault: { ...vault, [NOTE]: "See [[Private Plan]].\n" }, settings: { outsideLinks: "off" } });
    await tap(w, NOTE);
    expect(w.previews[0]?.links[0]).toMatchObject({ target: "Private Plan", kind: "outside" });
  });

  it("plain routes list their links too, but do not claim they turn into plain text", async () => {
    const w = makeWorld({ vault: { ...vault, [ESSAY]: "---\ntitle: T\n---\nSee [[Real essay]]\n" } });
    await tap(w, ESSAY);
    expect(w.previews[0]?.links.map((l) => l.kind)).toEqual(["published"]);
    expect(w.previews[0]?.blygNote).toBe(false);
  });
});


describe("links written with a folder path", () => {
  it("are flagged in the preview (the site resolves by name only) and still judged by the note they point at", async () => {
    const w = makeWorld({
      vault: {
        "website/blyg/Note.md": "See [[website/essays/Essay|the essay]] and [[Essay]] and [[Notes/Private]].\n",
        "website/essays/Essay.md": "---\ntitle: E\n---\nBody\n",
        "Notes/Private.md": "private\n",
      },
      settings: { outsideLinks: "warn" },
    });
    const out = await tap(w, "website/blyg/Note.md");
    expect(out.status).toBe("committed");
    const links = w.previews[0]?.links ?? [];
    expect(links.find((l) => l.target === "website/essays/Essay")).toMatchObject({ kind: "published", folder: true, path: "website/essays/Essay.md" });
    expect(links.find((l) => l.target === "Essay")).toMatchObject({ kind: "published" });
    expect(links.find((l) => l.target === "Essay")?.folder).toBeUndefined();
    expect(links.find((l) => l.target === "Notes/Private")).toMatchObject({ kind: "outside", folder: true });
  });
});
