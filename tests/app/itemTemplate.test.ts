import { describe, expect, it } from "vitest";
import { expandTemplate, newItemText, templatePath } from "../../src/app/itemTemplate";
import { NEW_THREAD_TEXT } from "../../src/app/threadCommands";

const ok = (r: ReturnType<typeof newItemText>): string => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.problem)}`);
  return r.text;
};

describe("newItemText without a template", () => {
  it("is exactly what a bare new note was before templates existed", () => {
    expect(ok(newItemText({ kind: "fragment", template: null, body: "" }))).toBe("");
    expect(ok(newItemText({ kind: "fragment", template: null, body: "Moved.\n" }))).toBe("Moved.\n");
    expect(ok(newItemText({ kind: "thread", template: null, body: "" }))).toBe(NEW_THREAD_TEXT);
    expect(ok(newItemText({ kind: "thread", template: null, body: "![[X]]\n\n" }))).toBe(`${NEW_THREAD_TEXT}![[X]]\n\n`);
  });
  it("treats a blank template as none", () => {
    expect(ok(newItemText({ kind: "thread", template: " \n", body: "" }))).toBe(NEW_THREAD_TEXT);
  });
});

describe("newItemText with a template", () => {
  it("a fragment is the template, then what the command adds after a blank line", () => {
    expect(ok(newItemText({ kind: "fragment", template: "---\ntags: [idea]\n---\n\n", body: "" }))).toBe("---\ntags: [idea]\n---\n\n");
    expect(ok(newItemText({ kind: "fragment", template: "Intro\n", body: "Moved.\n" }))).toBe("Intro\n\nMoved.\n");
    expect(ok(newItemText({ kind: "fragment", template: "Intro", body: "Moved.\n" }))).toBe("Intro\n\nMoved.\n");
    expect(ok(newItemText({ kind: "fragment", template: "Intro\n\n", body: "Moved.\n" }))).toBe("Intro\n\nMoved.\n");
  });
  it("a thread template without properties gets the thread property in front", () => {
    expect(ok(newItemText({ kind: "thread", template: "# Heading\n\n", body: "" }))).toBe("---\nblyg_kind: thread\n---\n\n# Heading\n\n");
  });
  it("a thread template with properties gets the thread property added to them, the author's lines untouched", () => {
    expect(ok(newItemText({ kind: "thread", template: "---\ntags: [idea]\ncreated: 2026-10-18\n---\n\nBody\n", body: "![[Q]]\n\n" }))).toBe(
      "---\nblyg_kind: thread\ntags: [idea]\ncreated: 2026-10-18\n---\n\nBody\n\n![[Q]]\n\n",
    );
    expect(ok(newItemText({ kind: "thread", template: "---\r\ntags: x\r\n---\r\n", body: "" }))).toBe("---\r\nblyg_kind: thread\r\ntags: x\r\n---\r\n");
  });
  it("a template that already says the right kind is left as it is", () => {
    const t = "---\nblyg_kind: thread\ntags: x\n---\n";
    expect(ok(newItemText({ kind: "thread", template: t, body: "" }))).toBe(t);
    const q = '---\nblyg_kind: "Fragment"\n---\n';
    expect(ok(newItemText({ kind: "fragment", template: q, body: "" }))).toBe(q);
  });
  it("refuses a template that says the other kind", () => {
    expect(newItemText({ kind: "fragment", template: "---\nblyg_kind: thread\n---\n", body: "" })).toEqual({ ok: false, problem: { kind: "wrong-kind", found: "thread" } });
    expect(newItemText({ kind: "thread", template: "---\nblyg_kind: fragment\n---\n", body: "" })).toEqual({ ok: false, problem: { kind: "wrong-kind", found: "fragment" } });
  });
  it("refuses a template that carries what Publish writes (a copied id would make two notes one item)", () => {
    for (const key of ["blyg_id", "blyg_version", "blyg_hash", "blyg_sources", "blyg_withdrawn", "blyg_channel"]) {
      expect(newItemText({ kind: "fragment", template: `---\n${key}: x\n---\n`, body: "" })).toEqual({ ok: false, problem: { kind: "publish-property", key } });
    }
  });
  it("refuses a properties block that never closes, instead of stacking a second one on it", () => {
    expect(newItemText({ kind: "thread", template: "---\ntags: x\n\nBody", body: "" })).toEqual({ ok: false, problem: { kind: "unclosed" } });
  });
  it("a horizontal rule in the body is not a properties block", () => {
    expect(ok(newItemText({ kind: "fragment", template: "Text\n\n---\n\nMore\n", body: "" }))).toBe("Text\n\n---\n\nMore\n");
    expect(ok(newItemText({ kind: "thread", template: "Text\n\n---\n\nMore\n", body: "" }))).toBe(`${NEW_THREAD_TEXT}Text\n\n---\n\nMore\n`);
  });
});

describe("expandTemplate", () => {
  const vars = {
    title: "Fragment 2026-10-18 0930",
    date: (f: string | undefined) => `D(${f ?? "default"})`,
    time: (f: string | undefined) => `T(${f ?? "default"})`,
  };
  it("fills title, date and time, with an optional format", () => {
    expect(expandTemplate("# {{title}}\n{{date}} {{time}}\n{{date:YYYY}} {{ time : HH }}", vars)).toBe(
      "# Fragment 2026-10-18 0930\nD(default) T(default)\nD(YYYY) T(HH)",
    );
  });
  it("leaves anything else alone", () => {
    expect(expandTemplate("<% tp.date.now() %> {{other}} {{ }}", vars)).toBe("<% tp.date.now() %> {{other}} {{ }}");
  });
});

describe("templatePath", () => {
  it("is empty for none, and adds .md when it is missing", () => {
    expect(templatePath("")).toBeNull();
    expect(templatePath("  ")).toBeNull();
    expect(templatePath("Templates/Fragment")).toBe("Templates/Fragment.md");
    expect(templatePath("/Templates/Fragment.md")).toBe("Templates/Fragment.md");
  });
});
