// S20 "Insert web quote": what the form does, with just enough of Obsidian's Modal/Setting to run it: Insert waits for a usable quote and
// address, the draft is kept as you type (the iPhone can end the app while you copy the address) and comes back, Paste takes the address out of a
// shared text, and a failed insert keeps the window and the draft.
import { beforeEach, describe, expect, it, vi } from "vitest";

const reg = vi.hoisted(() => ({
  buttons: [] as { text: string; disabled: boolean; click: () => void }[],
  fields: new Map<string, { inputEl: { value: string }; change: (v: string) => void }>(),
  texts: [] as { cls: string; text: string }[],
  notices: [] as string[],
  store: new Map<string, string>(),
}));

vi.mock("obsidian", () => {
  class El {
    texts = reg.texts;
    constructor(public cls = "") {}
    addClass() {}
    setText(t: string) {
      reg.texts.push({ cls: this.cls, text: t });
    }
    createDiv(o?: { cls?: string; text?: string }) {
      const el = new El(o?.cls ?? "");
      if (o?.text) el.setText(o.text);
      return el;
    }
    empty() {}
  }
  class Modal {
    contentEl = new El();
    constructor(public app: unknown) {}
    setTitle() {}
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
    private name = "";
    constructor(_el: unknown) {}
    setName(n: string) {
      this.name = n;
      return this;
    }
    setDesc() {
      return this;
    }
    setClass() {
      return this;
    }
    private input(cb: (t: unknown) => void) {
      const inputEl = { value: "", rows: 0, inputMode: "", addEventListener: () => {}, scrollIntoView: () => {} };
      const api = {
        inputEl,
        setPlaceholder: () => api,
        setValue: (v: string) => ((inputEl.value = v), api),
        onChange: (fn: (v: string) => void) => (reg.fields.set(this.name, { inputEl, change: fn }), api),
      };
      cb(api);
      return this;
    }
    addTextArea(cb: (t: unknown) => void) {
      return this.input(cb);
    }
    addText(cb: (t: unknown) => void) {
      return this.input(cb);
    }
    addButton(cb: (b: unknown) => void) {
      const b = { text: "", disabled: false, click: () => {} };
      const api = {
        setButtonText: (t: string) => ((b.text = t), api),
        setCta: () => api,
        setDisabled: (d: boolean) => ((b.disabled = d), api),
        onClick: (fn: () => void) => ((b.click = fn), api),
      };
      cb(api);
      reg.buttons.push(b);
      return this;
    }
  }
  class Notice {
    constructor(m: string) {
      reg.notices.push(m);
    }
  }
  return { Modal, Setting, Notice };
});

import { DEFAULT_WEB_QUOTE, DRAFT_KEY } from "../src/core/webQuote";
import { openWebQuote } from "../src/ui/WebQuoteModal";

const app = {
  loadLocalStorage: (k: string) => reg.store.get(k) ?? null,
  saveLocalStorage: (k: string, v: string | null) => (v === null ? reg.store.delete(k) : reg.store.set(k, v)),
};
const button = (text: string) => {
  // the latest button with this text (a form opened again adds its own)
  const b = [...reg.buttons].reverse().find((x) => x.text === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
};
const type = (field: string, value: string) => {
  const f = reg.fields.get(field);
  if (!f) throw new Error(`no field ${field}`);
  f.inputEl.value = value;
  f.change(value);
};
const open = (selection = "", insert: (b: string) => boolean = () => true) => openWebQuote(app as never, DEFAULT_WEB_QUOTE, selection, insert);

beforeEach(() => {
  reg.buttons.length = 0;
  reg.fields.clear();
  reg.texts.length = 0;
  reg.notices.length = 0;
  reg.store.clear();
  vi.unstubAllGlobals();
});

describe("the web quote form", () => {
  it("offers Insert only once there is a quote and a usable address, and shows the block as it will be written", () => {
    open();
    expect(button("Insert").disabled).toBe(true);
    type("Quote", "A passage");
    expect(button("Insert").disabled).toBe(true);
    type("Link", "ftp://nope");
    expect(button("Insert").disabled).toBe(true);
    expect(reg.texts.filter((t) => t.cls.includes("problem")).at(-1)?.text).toBe("Only http:// and https:// addresses are accepted."); // next to the link field
    type("Link", "https://example.substack.com/p/slug?r=1&utm_medium=web");
    expect(button("Insert").disabled).toBe(false);
    expect(reg.texts.some((t) => t.text === "> A passage\n> *[example.substack.com/p/slug](https://example.substack.com/p/slug)*")).toBe(true);
  });

  it("inserts the block, clears the draft and closes", () => {
    const insert = vi.fn(() => true);
    open("", insert);
    type("Quote", "Line one\nLine two");
    type("Link", "https://example.com/post");
    type("Alias (optional)", "A post");
    expect(reg.store.has(DRAFT_KEY)).toBe(true);
    button("Insert").click();
    expect(insert).toHaveBeenCalledWith("> Line one\n> Line two\n> *[A post](https://example.com/post)*");
    expect(reg.store.has(DRAFT_KEY)).toBe(false);
  });

  it("keeps the window and the draft when the note could not take the block", () => {
    const insert = vi.fn(() => false);
    open("", insert);
    type("Quote", "q");
    type("Link", "https://example.com/");
    button("Insert").click();
    button("Insert").click(); // still open: a second try is possible
    expect(insert).toHaveBeenCalledTimes(2);
    expect(reg.store.has(DRAFT_KEY)).toBe(true);
  });

  it("keeps the draft as you type, and brings it back when the form is opened again", () => {
    open();
    type("Quote", "Half a thought");
    type("Link", "https://example.com/a");
    button("Cancel").click();
    expect(reg.store.has(DRAFT_KEY)).toBe(true);
    reg.notices.length = 0;
    reg.fields.clear();
    open();
    expect(reg.fields.get("Quote")?.inputEl.value).toBe("Half a thought");
    expect(reg.fields.get("Link")?.inputEl.value).toBe("https://example.com/a");
    expect(reg.notices).toContain("Draft restored");
    expect(button("Insert").disabled).toBe(false);
  });

  it("takes the selection as the quote and keeps the rest of an earlier draft", () => {
    reg.store.set(DRAFT_KEY, JSON.stringify({ quote: "old quote", link: "https://example.com/a", alias: "Old" }));
    open("Selected in the note");
    expect(reg.fields.get("Quote")?.inputEl.value).toBe("Selected in the note");
    expect(reg.fields.get("Link")?.inputEl.value).toBe("https://example.com/a");
    expect(reg.fields.get("Alias (optional)")?.inputEl.value).toBe("Old");
  });

  it("says nothing about a draft when there is none, or only a selection", () => {
    open("Just a selection");
    expect(reg.notices).not.toContain("Draft restored");
  });

  it("Clear empties the fields and the draft", () => {
    open();
    type("Quote", "q");
    type("Link", "https://example.com/");
    button("Clear").click();
    expect(reg.store.has(DRAFT_KEY)).toBe(false);
    expect(reg.fields.get("Quote")?.inputEl.value).toBe("");
    expect(button("Insert").disabled).toBe(true);
  });

  it("Paste takes the address out of a shared text with a title, and says if the clipboard is refused", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: () => Promise.resolve("A post title\nhttps://example.com/post?utm_source=x\nmore") } });
    open();
    button("Paste").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(reg.fields.get("Link")?.inputEl.value).toBe("https://example.com/post?utm_source=x");
    vi.stubGlobal("navigator", { clipboard: { readText: () => Promise.reject(new Error("blocked")) } });
    button("Paste").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(reg.notices.some((n) => n.startsWith("The clipboard could not be read"))).toBe(true);
  });
});
