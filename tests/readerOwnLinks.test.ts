// I: a link to one of the reader's own items is recognised by the id in its path; only a web link counts.
import { describe, expect, it } from "vitest";
import { ownItemIdOf } from "../src/ui/readerOwnLinks";

const ID = "01HZX3K9M2Q7R8S4T5V6W7X8Y9";

describe("ownItemIdOf", () => {
  it("finds the id in a published item's address", () => {
    expect(ownItemIdOf(`https://example.com/blyg/t/${ID}/`)).toBe(ID);
    expect(ownItemIdOf(`https://example.com/f/${ID}`)).toBe(ID);
  });
  it("is null for a link without an id, a short or long token, or a non-web link", () => {
    expect(ownItemIdOf("https://example.com/about/")).toBeNull();
    expect(ownItemIdOf("https://example.com/t/abc123/")).toBeNull();
    expect(ownItemIdOf(`https://example.com/t/${ID}X/`)).toBeNull();
    expect(ownItemIdOf(`mailto:${ID}`)).toBeNull();
    expect(ownItemIdOf("#")).toBeNull();
    expect(ownItemIdOf("")).toBeNull();
  });
});

import { routeOwnLinks } from "../src/ui/readerOwnLinks";

describe("routeOwnLinks", () => {
  class FakeElement {
    constructor(private readonly href: string) {}
    closest(): FakeElement { return this; }
    getAttribute(): string { return this.href; }
  }
  const setup = (href: string, opens: boolean) => {
    (globalThis as unknown as { Element: unknown }).Element = FakeElement;
    let handler: ((e: unknown) => void) | null = null;
    const body = { addEventListener: (_: string, h: (e: unknown) => void) => void (handler = h) } as unknown as HTMLElement;
    const opened: string[] = [];
    const web: string[] = [];
    routeOwnLinks(body, async (id) => (opened.push(id), opens), (u) => void web.push(u));
    const ev = { target: new FakeElement(href), prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    handler!(ev);
    return { ev, opened, web };
  };
  it("opens the note for an own item's address and leaves the web alone", async () => {
    const r = setup(`https://example.com/t/${ID}/`, true);
    await new Promise((x) => setTimeout(x, 0));
    expect(r.ev.prevented).toBe(true);
    expect(r.opened).toEqual([ID]);
    expect(r.web).toEqual([]);
  });
  it("falls back to the web link when no note holds the id", async () => {
    const r = setup(`https://example.com/t/${ID}/`, false);
    await new Promise((x) => setTimeout(x, 0));
    expect(r.web).toEqual([`https://example.com/t/${ID}/`]);
  });
  it("does nothing for a link with no id", () => {
    const r = setup("https://example.com/about/", true);
    expect(r.ev.prevented).toBe(false);
    expect(r.opened).toEqual([]);
  });
});
