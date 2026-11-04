import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Just enough of Obsidian's Modal/Setting/DOM helpers for WritePreviewModal.
const registry = vi.hoisted(() => ({
  buttons: [] as { text: string; cta: boolean; destructive: boolean; click: () => void }[],
  sanitized: [] as string[],
  order: [] as string[],
  toggle: { name: "", value: null as boolean | null, set: (_v: boolean) => {} },
  fields: [] as { name: string; desc: string; placeholder: string; value: string; type: (v: string) => void }[],
}));

vi.mock("obsidian", () => {
  class FakeEl {
    cls = new Set<string>();
    text = "";
    children: FakeEl[] = [];
    constructor(public tag = "div") {}
    addClass(c: string) {
      this.cls.add(c);
    }
    setText(t: string) {
      this.text = t;
    }
    private make(tag: string, o?: { cls?: string; text?: string }) {
      const el = new FakeEl(tag);
      registry.order.push(o?.cls ?? tag);
      if (o?.cls) o.cls.split(" ").forEach((c) => el.cls.add(c));
      if (o?.text) el.text = o.text;
      this.children.push(el);
      return el;
    }
    createDiv(o?: { cls?: string; text?: string }) {
      return this.make("div", o);
    }
    createSpan(o?: { cls?: string; text?: string }) {
      return this.make("span", o);
    }
    createEl(tag: string, o?: { cls?: string; text?: string }) {
      return this.make(tag, o);
    }
    appended: unknown[] = [];
    appendChild(node: unknown) {
      this.appended.push(node);
      return node;
    }
    empty() {
      this.children = [];
    }
    all(): FakeEl[] {
      return [this, ...this.children.flatMap((c) => c.all())];
    }
  }
  class Modal {
    contentEl = new FakeEl();
    title = "";
    constructor(public app: unknown) {}
    setTitle(t: string) {
      this.title = t;
    }
    open() {
      this.onOpen();
    }
    close() {
      this.onClose();
    }
    onOpen() {}
    onClose() {}
  }
  class Setting {
    private field = { name: "", desc: "", placeholder: "", value: "", type: (_v: string) => {} };
    constructor(_el: unknown) {}
    setName(n: string) {
      this.field.name = n;
      return this;
    }
    setDesc(d: string) {
      this.field.desc = d;
      return this;
    }
    addText(cb: (t: unknown) => void) {
      registry.order.push("note-field");
      const api = {
        inputEl: { addEventListener: () => {}, scrollIntoView: () => {} },
        setPlaceholder: (p: string) => ((this.field.placeholder = p), api),
        setValue: (v: string) => ((this.field.value = v), api),
        onChange: (fn: (v: string) => void) => ((this.field.type = fn), api),
      };
      cb(api);
      registry.fields.push(this.field);
      return this;
    }
    addToggle(cb: (t: unknown) => void) {
      const api = {
        setValue: (v: boolean) => ((registry.toggle.value = v), api),
        onChange: (fn: (v: boolean) => void) => ((registry.toggle.set = fn), api),
      };
      registry.toggle.name = this.field.name;
      cb(api);
      return this;
    }
    addButton(cb: (b: unknown) => void) {
      const b = { text: "", cta: false, destructive: false, click: () => {} };
      const api = {
        setButtonText: (t: string) => ((b.text = t), api),
        setCta: () => ((b.cta = true), api),
        setDestructive: () => ((b.destructive = true), api),
        onClick: (fn: () => void) => ((b.click = fn), api),
      };
      cb(api);
      registry.buttons.push(b);
      return this;
    }
  }
  const sanitizeHTMLToDom = (html: string) => (registry.sanitized.push(html), { sanitized: html });
  return { Modal, Setting, sanitizeHTMLToDom };
});

import { WritePreviewModal } from "../src/ui/WritePreviewModal";
import type { Confirmation, WritePreview } from "../src/publish/types";

const preview = (over: Partial<WritePreview> = {}): WritePreview => ({
  action: "update", channel: "production", branch: "main", path: "src/content/notes/x.md", noteName: "Note.md", label: "Blyg note",
  id: "x", fromVersion: 1, toVersion: 2, before: "old text", after: "new text", changes: ["Version 1 → 2"], links: [], blygNote: false, commitMessage: "content: update note x to v2", ...over,
});

function open(p: WritePreview) {
  registry.toggle.name = "";
  registry.toggle.value = null;
  registry.buttons.length = 0;
  registry.fields.length = 0;
  const answers: Confirmation[] = [];
  const modal = new WritePreviewModal({} as never, p, (v) => answers.push(v));
  modal.open();
  const texts = (modal.contentEl as unknown as { all(): { text: string; cls: Set<string> }[] }).all();
  return { modal, answers, texts, buttons: [...registry.buttons], fields: [...registry.fields], title: (modal as unknown as { title: string }).title };
}

beforeEach(() => ((registry.toggle.name = ""), (registry.toggle.value = null), (registry.buttons.length = 0), (registry.sanitized.length = 0), (registry.fields.length = 0)));

describe("WritePreviewModal", () => {
  it("offers Cancel and Commit to <branch>; Commit confirms, once", () => {
    const { answers, buttons } = open(preview());
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Commit to main"]);
    expect(buttons[1]?.cta).toBe(true);
    buttons[1]?.click();
    buttons[1]?.click();
    expect(answers).toEqual([true]);
  });

  it("Cancel declines", () => {
    const { answers, buttons } = open(preview());
    buttons[0]?.click();
    expect(answers).toEqual([false]);
  });

  it("closing the window any other way (back swipe, Escape) declines, never confirms", () => {
    const { modal, answers } = open(preview());
    modal.close();
    expect(answers).toEqual([false]);
  });

  it("states the target loudly: production and preview look different", () => {
    const prod = open(preview());
    expect(prod.texts.some((t) => t.cls.has("blyg-where-production") && /Production — your real site · branch “main”/.test(t.text))).toBe(true);
    const test = open(preview({ channel: "preview", branch: "preview" }));
    expect(test.texts.some((t) => t.cls.has("blyg-where-preview") && /Preview — test channel · branch “preview”/.test(t.text))).toBe(true);
    expect(test.buttons.map((b) => b.text)).toEqual(["Cancel", "Commit to preview"]);
  });

  it("only the middle of the window scrolls: the target bar stays on top, the buttons stay at the bottom", () => {
    type El = { cls: Set<string>; text: string; children: El[]; all(): El[] };
    const long = Array.from({ length: 40 }, (_, i) => `[[Note ${i}]]`).join(" ");
    const { modal } = open(
      preview({
        blygNote: true,
        before: "old",
        after: long,
        links: Array.from({ length: 12 }, (_, i) => ({ target: `Note ${i}`, embed: false, kind: "published" as const, path: `website/essays/Note ${i}.md` })),
        commitMessage: "content: update note ".repeat(10),
      }),
    );
    const root = modal.contentEl as unknown as El;
    expect(root.cls.has("blyg-preview")).toBe(true);
    expect(root.children.map((c) => [...c.cls].find((x) => x.startsWith("blyg-")))).toEqual(["blyg-where", "blyg-scroll", "blyg-footer"]);
    const [bar, scroll] = root.children as [El, El, El];
    const inScroll = scroll.all().map((e) => e.text).join("|");
    expect(inScroll).toContain("content: update note");
    expect(inScroll).toContain("Links in this text");
    expect(inScroll).toContain("Changes:");
    expect(bar.all().map((e) => e.text).join("|")).not.toContain("Links in this text");
  });

  it("the stylesheet makes the window a column whose middle scrolls, and gives nothing inside it a scroll area of its own", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const rule = (selector: string): string => new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule(".blyg-preview")).toMatch(/display:\s*flex/);
    expect(rule(".blyg-preview")).toMatch(/flex-direction:\s*column/);
    expect(rule(".blyg-preview")).toMatch(/max-height:/);
    expect(rule(".blyg-preview .blyg-scroll")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".blyg-preview .blyg-scroll")).toMatch(/min-height:\s*0/);
    expect(rule(".blyg-preview .blyg-footer")).toMatch(/flex:\s*none/);
    expect(rule(".blyg-preview .blyg-diff")).not.toMatch(/overflow-[xy]|overflow:|max-height/);
  });

  it("shows where it writes, the commit message and what changes", () => {
    const { texts } = open(preview());
    const all = texts.map((t) => t.text).join("|");
    expect(all).toContain("src/content/notes/x.md");
    expect(all).toContain("content: update note x to v2");
    expect(all).toContain("Version 1 → 2");
    expect(all).toContain("Changes: +1 word, −1 word");
  });

  it("a withdrawal is a destructive action with the permanence warning and no diff", () => {
    const { texts, buttons } = open(preview({ action: "withdraw", before: "words", after: "", changes: ["The id x stays public forever, as “withdrawn”"] }));
    expect(buttons[1]).toMatchObject({ text: "Withdraw", destructive: true });
    expect(texts.some((t) => t.cls.has("blyg-warning"))).toBe(true);
    expect(texts.some((t) => t.cls.has("blyg-diff"))).toBe(false);
  });

  it("a new item shows its text as new; a very long text skips the word-by-word view", () => {
    const fresh = open(preview({ action: "create", before: null, after: "Brand new words", changes: ["Version 1"] }));
    expect(fresh.texts.some((t) => t.text === "New text")).toBe(true);
    expect(fresh.texts.some((t) => t.cls.has("blyg-diff-add") && t.text === "Brand new words")).toBe(true);
    const long = open(preview({ before: "a ".repeat(15000), after: "b ".repeat(15000) }));
    expect(long.texts.some((t) => /word-by-word view is skipped/.test(t.text))).toBe(true);
  });

  it("the target bar never uses the class names of the 0.0.4 stylesheet (a stale stylesheet once painted it as an empty block)", () => {
    const { texts } = open(preview());
    expect(texts.some((t) => t.cls.has("blyg-target") || t.cls.has("blyg-target-preview") || t.cls.has("blyg-target-production"))).toBe(false);
  });

  it("lists every link with its verdict, marking one outside the publish folders, and says what the site does with wikilinks in Blyg notes", () => {
    const { texts } = open(
      preview({
        blygNote: true,
        links: [
          { target: "Essay", embed: false, kind: "published", path: "website/essays/Essay.md" },
          { target: "Private", embed: false, kind: "outside", path: "Notes/Private.md" },
          { target: "pic.png", embed: true, kind: "file", path: "Attachments/pic.png" },
          { target: "Nowhere", embed: false, kind: "unresolved" },
        ],
      }),
    );
    const all = texts.map((t) => t.text).join("|");
    expect(all).toContain("[[Essay]] → website/essays/Essay.md — in a publish folder");
    expect(all).toContain("[[Private]] → Notes/Private.md — NOT in a publish folder");
    expect(all).toContain("![[pic.png]] → Attachments/pic.png — a file, not a note");
    expect(all).toContain("[[Nowhere]] → no such note in your vault");
    expect(texts.some((t) => t.cls.has("blyg-link-outside") && t.text.includes("Private"))).toBe(true);
    expect(all).toContain("become links to essays, found by name");
  });

  it("says when a link carries a folder path (the site uses only the name), but not for embeds", () => {
    const { texts } = open(
      preview({
        blygNote: true,
        links: [
          { target: "website/essays/Essay", embed: false, kind: "published", path: "website/essays/Essay.md", folder: true },
          { target: "Attachments/pic.png", embed: true, kind: "file", path: "Attachments/pic.png", folder: true },
          { target: "Plain", embed: false, kind: "published", path: "website/essays/Plain.md" },
        ],
      }),
    );
    const lines = texts.map((t) => t.text);
    expect(lines.find((t) => t.startsWith("[[website/essays/Essay]]"))).toContain("written with a folder path");
    expect(lines.find((t) => t.startsWith("![[Attachments/pic.png]]"))).not.toContain("folder path");
    expect(lines.find((t) => t.startsWith("[[Plain]]"))).not.toContain("folder path");
  });

  it("shows no links section when the text has none", () => {
    const { texts } = open(preview());
    expect(texts.some((t) => t.text === "Links in this text")).toBe(false);
  });

  it("lists a thread's quotes and links as text: whole or passage, new or moved, and what the passage says", () => {
    const { texts } = open(
      preview({
        label: "thread",
        blygNote: true,
        thread: {
          quotes: [
            { id: "7c9wk2mhq0v3xj8tn5rzfd41bg", version: 3, kind: "fragment", passage: null, excerpt: "Time moves down the stack", change: "new" },
            { id: "1vgtgz0gq5b2c9k7d3m8r4n6xy", version: 2, kind: "thread", passage: "Stigmergy is what a protocol looks like", excerpt: "x", change: "moved", fromVersion: 1 },
          ],
          itemLinks: [{ id: "3d7mnhr5g0kq8v2wxb4tjy6fz9", label: "“Micro Time…”", isNew: true }],
        },
      }),
    );
    const lines = texts.map((t) => t.text);
    expect(lines).toContain("Quotes in this thread");
    expect(lines).toContain("whole · fragment 7c9wk2mh… v3 · new — “Time moves down the stack”");
    expect(lines).toContain("passage · thread 1vgtgz0g… v2 · moved from v1 to v2 — “Stigmergy is what a protocol looks like”");
    expect(lines).toContain("Links to other items");
    expect(lines).toContain("3d7mnhr5… — shown as “Micro Time…”");
    expect(texts.find((t) => t.text.startsWith("passage · thread"))?.cls.has("blyg-quote-moved")).toBe(true);
  });

  it("shows nothing extra for a note without quotes or links", () => {
    const { texts } = open(preview({ thread: { quotes: [], itemLinks: [] } }));
    expect(texts.some((t) => /Quotes in this|Links to other items/.test(t.text))).toBe(false);
  });

  it("for a publish through a Studio: names the Studio loudly, shows its rendering through the sanitiser, and says Publish", () => {
    const { texts, buttons, answers } = open(
      preview({ channel: "production", branch: "https://studio.test", path: "https://studio.test/f/abc/", commitMessage: "", studio: { host: "https://studio.test", html: "<p>Hi <img src=x onerror=alert(1)></p>" } }),
    );
    expect(texts.some((t) => t.cls.has("blyg-where-studio") && t.text === "Studio — https://studio.test · goes live at once")).toBe(true);
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Publish"]);
    expect(texts.some((t) => t.text === "Item")).toBe(true);
    expect(texts.some((t) => t.text === "Commit message" || t.text === "Writes to")).toBe(false);
    expect(texts.some((t) => t.text === "As readers will see it")).toBe(true);
    // foreign HTML only ever goes through Obsidian's sanitiser, never in as text or markup of ours
    expect(registry.sanitized).toEqual(["<p>Hi <img src=x onerror=alert(1)></p>"]);
    expect(texts.some((t) => t.text.includes("onerror"))).toBe(false);
    buttons[1]?.click();
    expect(answers).toEqual([true]);
  });

  it("a Studio publish with nothing rendered shows no empty box", () => {
    const { texts } = open(preview({ studio: { host: "https://studio.test", html: "  " } }));
    expect(texts.some((t) => t.text === "As readers will see it")).toBe(false);
    expect(registry.sanitized).toEqual([]);
  });

  it("the change note stands at the top of the window, above the diff and the rendering, where the phone's keyboard does not cover it", () => {
    registry.order.length = 0;
    open(preview({ branch: "https://studio.test", path: "https://studio.test/f/abc/", commitMessage: "", studio: { host: "https://studio.test", html: "<p>Hi</p>", askNote: true } }));
    const at = (name: string): number => registry.order.indexOf(name);
    expect(at("note-field")).toBeGreaterThan(-1);
    expect(at("note-field")).toBeLessThan(at("blyg-diff"));
    expect(at("note-field")).toBeLessThan(at("blyg-studio-render"));
    expect(at("blyg-footer")).toBeGreaterThan(at("blyg-diff"));
  });

  describe("the windows of a drafts-only route", () => {
    const draftWindow = (over: Partial<WritePreview> = {}): WritePreview =>
      preview({ action: "draft", branch: "https://studio.test", path: "(new draft)", commitMessage: "", before: null, changes: ["Nothing goes live: a draft is visible only to you in the Studio."], studio: { host: "https://studio.test", html: "<p>Hi</p>" }, ...over });

    it("a draft says it goes nowhere, offers no change note, and the button says Send draft", () => {
      const { title, texts, buttons, fields, answers } = open(draftWindow());
      expect(title).toBe("Send a draft to your Studio");
      expect(texts.some((t) => /draft only, nothing goes live/.test(t.text))).toBe(true);
      expect(texts.some((t) => /goes live at once/.test(t.text))).toBe(false);
      expect(texts.some((t) => t.cls.has("blyg-warning") && /^Nothing goes live\./.test(t.text))).toBe(true);
      expect(fields).toEqual([]);
      expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Send draft"]);
      buttons[1]?.click();
      expect(answers).toEqual([true]);
    });

    it("deleting a draft is a destructive choice that defaults to keeping it", () => {
      const del = preview({ action: "delete-draft", branch: "https://studio.test", path: "https://studio.test/f/abc/", commitMessage: "", before: "The draft.", after: "", changes: ["The draft is deleted from the Studio."], studio: { host: "https://studio.test", html: "" } });
      const { title, texts, buttons, answers } = open(del);
      expect(title).toBe("Delete this draft");
      expect(texts.some((t) => /deletes a draft that was never published/.test(t.text))).toBe(true);
      expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Delete draft"]);
      expect(buttons[0]?.cta).toBe(true);
      expect(buttons[1]?.destructive).toBe(true);
      buttons[0]?.click();
      expect(answers).toEqual([false]);
    });
  });

  describe("a Studio update", () => {
    const studioUpdate = (over: Partial<WritePreview> = {}, askNote = true): WritePreview =>
      preview({ branch: "https://studio.test", path: "https://studio.test/t/abc/", commitMessage: "", label: "thread", studio: { host: "https://studio.test", html: "<p>Hi</p>", askNote }, ...over });

    it("offers an optional change note and sends it with the confirmation", () => {
      const { buttons, answers, fields, title } = open(studioUpdate());
      expect(title).toBe("Publish a new version to your Studio");
      expect(fields).toHaveLength(1);
      expect(fields[0]).toMatchObject({ name: "Change note (optional)", placeholder: "What changed?" });
      fields[0]?.type("fixed a typo");
      buttons[1]?.click();
      expect(answers).toEqual([{ note: "fixed a typo" }]);
    });

    it("an empty note is still an answer with a note field (the service treats it as none); Cancel is plain no", () => {
      const yes = open(studioUpdate());
      yes.buttons[1]?.click();
      expect(yes.answers).toEqual([{ note: "" }]);
      const no = open(studioUpdate());
      no.fields[0]?.type("never sent");
      no.buttons[0]?.click();
      expect(no.answers).toEqual([false]);
    });

    it("a first version has no note field and answers a plain yes", () => {
      const { fields, buttons, answers, title } = open(studioUpdate({ action: "create", before: null }, false));
      expect(title).toBe("Publish a new thread to your Studio");
      expect(fields).toEqual([]);
      buttons[1]?.click();
      expect(answers).toEqual([true]);
    });

    it("lists what a thread quotes, as the Studio resolved it: own or another blyg, whole or passage, by the label the note gave it", () => {
      const { texts } = open(
        studioUpdate({
          studio: {
            host: "https://studio.test",
            html: "",
            askNote: false,
            quotes: [
              { id: "7c9wk2mhq0v3xj8tn5rzfd41bg", version: 3, passage: null, remote: false, label: null },
              { id: "095s4h48j67mnbf6hq8vatc2d4", version: 1, passage: "Quotable sentence here.", remote: true, label: "Blog B: Remote fragment" },
            ],
          },
        }),
      );
      const lines = texts.map((t) => t.text);
      expect(lines).toContain("Quotes in this thread");
      expect(lines).toContain("whole · 7c9wk2mh… v3 · your Studio");
      expect(lines).toContain("passage · Blog B: Remote fragment v1 · another blyg — “Quotable sentence here.”");
    });
  });

  it("a repost's note field starts with where the item came from, and sends it unless the user changes it", () => {
    const repost = (): WritePreview =>
      preview({ action: "create", before: null, branch: "https://studio.test", path: "(new item)", commitMessage: "", studio: { host: "https://studio.test", html: "<p>x</p>", askNote: true, noteDefault: "Reposted from old.example/ — first published 2026-10-01", repost: { id: "a0000000000000000000000077", origin: "https://old.example/", version: 3 } } });
    const untouched = open(repost());
    expect(untouched.fields[0]?.value).toBe("Reposted from old.example/ — first published 2026-10-01");
    untouched.buttons[1]?.click();
    expect(untouched.answers).toEqual([{ note: "Reposted from old.example/ — first published 2026-10-01" }]);
    const edited = open(repost());
    edited.fields[0]?.type("Moved from the old blyg");
    edited.buttons[1]?.click();
    expect(edited.answers).toEqual([{ note: "Moved from the old blyg" }]);
  });

  it("a repost says it is a new item and what happens to the old one", () => {
    const { texts, title, buttons } = open(
      preview({ action: "create", before: null, branch: "https://studio.test", path: "(new item)", commitMessage: "", studio: { host: "https://studio.test", html: "<p>x</p>", askNote: false, repost: { id: "a0000000000000000000000077", origin: "https://old.example/blyg/", version: 3 } } }),
    );
    expect(title).toBe("Repost to your Studio");
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Publish"]);
    expect(texts.some((t) => t.cls.has("blyg-warning") && /new item, with a new address and today’s date.*a0000000000000000000000077, version 3 at https:\/\/old.example\/blyg\/\) stays where it is/.test(t.text))).toBe(true);
  });

  describe("the window for work done in the Studio", () => {
    const conflict = (): WritePreview =>
      preview({
        action: "studio-conflict",
        branch: "https://studio.test",
        path: "https://studio.test/f/abc/",
        commitMessage: "",
        before: "Written in the Studio.",
        after: "Written in Obsidian.",
        changes: [],
        studio: { host: "https://studio.test", html: "" },
      });

    it("explains, shows the Studio's copy against the note, and defaults to keeping the Studio's work", () => {
      const { texts, buttons, title, fields } = open(conflict());
      expect(title).toBe("The Studio’s copy was changed there");
      expect(texts.some((t) => t.cls.has("blyg-warning") && /edited in the Studio since this note last sent it/.test(t.text))).toBe(true);
      expect(texts.some((t) => t.cls.has("blyg-diff"))).toBe(true);
      expect(texts.some((t) => /^Changes: \+/.test(t.text))).toBe(true);
      expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Replace this note with the online text", "Replace the online copy with this note"]);
      expect(buttons[0]?.cta).toBe(true);
      expect(buttons[2]?.destructive).toBe(true);
      expect(fields).toEqual([]);
      expect(texts.some((t) => t.text === "As readers will see it")).toBe(false);
    });

    it("Overwrite confirms with a plain yes; Cancel and closing decline", () => {
      const yes = open(conflict());
      yes.buttons[2]?.click();
      expect(yes.answers).toEqual([true]);
      const no = open(conflict());
      no.buttons[0]?.click();
      expect(no.answers).toEqual([false]);
      const closed = open(conflict());
      closed.modal.close();
      expect(closed.answers).toEqual([false]);
    });

    it("Replace the note's text answers with the pull choice, not with a yes to overwriting", () => {
      const pull = open(conflict());
      pull.buttons[1]?.click();
      expect(pull.answers).toEqual([{ note: "", pull: true }]);
    });
  });

  describe("the window for taking the Studio's copy into the note", () => {
    const pulling = (over: Partial<WritePreview> = {}): WritePreview =>
      preview({
        action: "studio-pull",
        branch: "https://studio.test",
        path: "https://studio.test/f/abc/",
        commitMessage: "",
        before: "The note.",
        after: "The Studio.",
        changes: ["Nothing is sent to the Studio."],
        studio: { host: "https://studio.test", html: "" },
        ...over,
      });

    it("says that nothing is sent, shows both texts, and defaults to keeping the note", () => {
      const { texts, buttons, title, fields } = open(pulling());
      expect(title).toBe("Replace this note with the online text");
      expect(texts.some((t) => t.cls.has("blyg-warning") && /Nothing is sent to the Studio/.test(t.text))).toBe(true);
      expect(texts.some((t) => t.cls.has("blyg-diff"))).toBe(true);
      expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Replace this note with the online text"]);
      expect(buttons[0]?.cta).toBe(true);
      expect(buttons[1]?.destructive).toBe(true);
      expect(fields).toEqual([]);
    });

    it("with block ids it lists them and offers to write them to the note; the answer carries the choice", () => {
      const withIds = () => pulling({ blockIds: [{ id: "ab12cd", excerpt: "First thought." }] });
      const on = open(withIds());
      expect(on.texts.some((t) => t.cls.has("blyg-warning") && /1 block id.*\^ab12cd/.test(t.text))).toBe(true);
      expect(registry.toggle).toMatchObject({ name: "Write the ids to the end of the note", value: true });
      on.buttons[1]?.click();
      expect(on.answers).toEqual([{ note: "", appendIds: true }]);
      const off = open(withIds());
      registry.toggle.set(false);
      off.buttons[1]?.click();
      expect(off.answers).toEqual([{ note: "", appendIds: false }]);
      const none = open(pulling());
      expect(registry.toggle.value).toBeNull();
      none.buttons[1]?.click();
      expect(none.answers).toEqual([true]);
    });

    it("Replace confirms with a plain yes; Cancel and closing decline", () => {
      const yes = open(pulling());
      yes.buttons[1]?.click();
      expect(yes.answers).toEqual([true]);
      const closed = open(pulling());
      closed.modal.close();
      expect(closed.answers).toEqual([false]);
    });
  });
});
