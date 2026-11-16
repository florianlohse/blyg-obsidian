// S15: the reply preview: which lines of a note are quote directives, and how the item they point at is found. Pure; the drawing is measured in real Obsidian
// (tests/e2e/obsidian/scenarios/reply-preview.mjs).
import { describe, expect, it } from "vitest";
import type { StudioClient } from "../src/studio/client";
import { paragraphsOf, previewOfPost, resolvePreview } from "../src/studio/previewResolver";
import type { ReadingPost } from "../src/studio/reading";
import { findDirectives } from "../src/core/previewDirectives";

const ID = "2mhdb5wr1k5agypd4tspkyhst0";

describe("findDirectives", () => {
  it("finds a line that is only the directive, with or without a label, and says where it is", () => {
    const text = `Intro\n![[${ID}]]\nbetween\n  ![[${ID} | My label ]]  \nend`;
    const got = findDirectives(text);
    expect(got.map((d) => [d.id, d.label])).toEqual([[ID, ""], [ID, "My label"]]);
    expect(text.slice(got[0]?.from, got[0]?.to)).toBe(`![[${ID}]]`);
    expect(text.slice(got[1]?.from, got[1]?.to)).toBe(`  ![[${ID} | My label ]]  `);
  });
  it("leaves out what is not one: text around it, another alphabet, a version, a note's name, an indented code block", () => {
    for (const line of [`see ![[${ID}]] here`, `![[${ID.toUpperCase()}]]`, `![[${ID}@v2]]`, "![[A note]]", `![[${ID.slice(1)}]]`, `    ![[${ID}]]`, `[[${ID}]]`, `![[${ID} | a]] more`, `![[${"i".repeat(26)}]]`]) {
      expect(findDirectives(line), line).toEqual([]);
    }
  });
  it("leaves a directive inside fenced code alone, and finds the next one after the fence", () => {
    const text = `\`\`\`\n![[${ID}]]\n\`\`\`\n![[${ID}]]\n~~~md\n![[${ID}]]\n~~~\n`;
    const got = findDirectives(text);
    expect(got).toHaveLength(1);
    expect(text.slice(got[0]?.from, got[0]?.to)).toBe(`![[${ID}]]`);
    expect(got[0]?.from).toBe(text.indexOf(`\n![[${ID}]]\n~~~md`) + 1);
  });
  it("is fast on a long note", () => {
    const t0 = Date.now();
    findDirectives(`word `.repeat(400_000));
    findDirectives(`![[${ID}]]\n`.repeat(20_000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("paragraphsOf", () => {
  it("turns the owner's words into escaped paragraphs and line breaks, nothing more", () => {
    expect(paragraphsOf("One <b>line</b>\nsame para\n\n\nSecond & last")).toBe("<p>One &lt;b&gt;line&lt;/b&gt;<br>same para</p><p>Second &amp; last</p>");
    expect(paragraphsOf("  \n\n")).toBe("");
  });
});

const ok = <T,>(value: T) => ({ kind: "ok" as const, value });
const gone = { kind: "not-found" as const, status: 404, message: "x" };
const broke = { kind: "error" as const, status: 500, message: "x" };
const fake = (over: Partial<Record<"getItem" | "search" | "getImported" | "peekItem", unknown>>): StudioClient =>
  ({ getItem: async () => gone, search: async () => ok({ items: [] }), getImported: async () => gone, peekItem: async () => gone, ...over }) as unknown as StudioClient;

describe("resolvePreview", () => {
  it("an item of the owner: its published words; a draft: the working copy as paragraphs", async () => {
    const published = await resolvePreview(fake({ getItem: async () => ok({ status: "public", version: 2, contentMd: "md", published: { contentHtml: "<p>published</p>" } }) }), ID, null);
    expect(published).toEqual({ kind: "ready", item: { who: "Your item", html: "<p>published</p>", own: true, draft: false, withdrawn: false } });
    const draft = await resolvePreview(fake({ getItem: async () => ok({ status: "draft", version: 0, contentMd: "a <b>draft</b>", published: null }) }), ID, null);
    expect(draft).toMatchObject({ kind: "ready", item: { who: "Your item (a draft)", html: "<p>a &lt;b&gt;draft&lt;/b&gt;</p>", own: true, draft: true } });
  });
  it("an item held from a blyg the Studio reads: found by its exact id, with the blyg's title; a withdrawn one says so", async () => {
    const hit = { id: ID, subscriptionId: "s1", sourceTitle: "Blog B" };
    const got = await resolvePreview(fake({ search: async () => ok({ items: [{ id: "other", subscriptionId: "s9" }, hit] }), getImported: async () => ok({ state: "current", contentHtml: "<p>held</p>" }) }), ID, null);
    expect(got).toEqual({ kind: "ready", item: { who: "Blog B", html: "<p>held</p>", own: false, draft: false, withdrawn: false } });
    const withdrawn = await resolvePreview(fake({ search: async () => ok({ items: [hit] }), getImported: async () => ok({ state: "tombstone", contentHtml: "<p>old</p>" }) }), ID, null);
    expect(withdrawn).toMatchObject({ kind: "ready", item: { withdrawn: true, html: "" } });
  });
  it("an item of a blyg the Studio does not read: looked up by the note's own hint of where it lives, never without one", async () => {
    const peek = async (origin: string) => ok({ origin, id: ID, kind: "fragment", version: 1, contentHtml: "<p>peeked</p>", url: "u", subscriptionId: null });
    expect(await resolvePreview(fake({ peekItem: peek }), ID, "https://far.example")).toMatchObject({ kind: "ready", item: { who: "far.example", html: "<p>peeked</p>" } });
    expect(await resolvePreview(fake({ peekItem: peek }), ID, null)).toEqual({ kind: "missing" });
    expect(await resolvePreview(fake({ peekItem: async (origin: string) => ok({ origin, id: ID, kind: "withdrawn", version: 1, contentHtml: "x", url: "", subscriptionId: null }) }), ID, "https://far.example")).toMatchObject({ item: { withdrawn: true, html: "" } });
  });
  it("says it could not ask, rather than that the item is missing, when the Studio fails", async () => {
    expect(await resolvePreview(fake({ getItem: async () => broke }), ID, null)).toMatchObject({ kind: "unavailable" });
    expect(await resolvePreview(fake({ search: async () => broke }), ID, null)).toMatchObject({ kind: "unavailable" });
    expect(await resolvePreview(fake({ search: async () => ok({ items: [{ id: ID, subscriptionId: "s1", sourceTitle: "B" }] }), getImported: async () => broke }), ID, null)).toMatchObject({ kind: "unavailable" });
    expect(await resolvePreview(fake({ peekItem: async () => broke }), ID, "https://far.example")).toMatchObject({ kind: "unavailable" });
  });
});

describe("speed", () => {
  it("asks whether it is the owner's own item and whether it is held at the same time, not one after the other", async () => {
    const started: string[] = [];
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => (release = resolve));
    const client = fake({
      getItem: async () => {
        started.push("getItem");
        await slow;
        return gone;
      },
      search: async () => {
        started.push("search");
        return ok({ items: [{ id: ID, subscriptionId: "s1", sourceTitle: "Blog B" }] });
      },
      getImported: async () => ok({ state: "current", contentHtml: "<p>held</p>" }),
    });
    const pending = resolvePreview(client, ID, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["getItem", "search"]); // search began while the first answer was still out
    release(undefined);
    expect(await pending).toMatchObject({ kind: "ready", item: { who: "Blog B", html: "<p>held</p>" } });
  });
  it("an own item still wins over a held one with the same id, and a failing first question still says it could not ask", async () => {
    const hit = { id: ID, subscriptionId: "s1", sourceTitle: "Blog B" };
    const both = await resolvePreview(fake({ getItem: async () => ok({ status: "public", version: 1, contentMd: "m", published: { contentHtml: "<p>mine</p>" } }), search: async () => ok({ items: [hit] }) }), ID, null);
    expect(both).toMatchObject({ kind: "ready", item: { own: true, html: "<p>mine</p>" } });
    expect(await resolvePreview(fake({ getItem: async () => broke, search: async () => ok({ items: [hit] }) }), ID, null)).toMatchObject({ kind: "unavailable" });
  });
  it("a post the reader already holds is previewed from itself, a withdrawn one with no text", () => {
    const post = { subscriptionTitle: "Blog B", contentHtml: "<p>words</p>", withdrawn: false } as unknown as ReadingPost;
    expect(previewOfPost(post)).toEqual({ who: "Blog B", html: "<p>words</p>", own: false, draft: false, withdrawn: false });
    expect(previewOfPost({ ...post, withdrawn: true })).toMatchObject({ withdrawn: true, html: "" });
  });
});
