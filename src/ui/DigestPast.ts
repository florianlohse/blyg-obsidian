// The Daily's past editions: the day switcher and a past edition drawn read-only from its saved record (src/digest/history.ts).
// Everything is put on the page as text (createEl({ text })), never HTML. Posts open in the reader only when the reader still holds them.
import type { PastEdition } from "../digest/history";
import { authorOf } from "../digest/storyMeta";
import type { ReadingPost } from "../studio/reading";
import { byLine, topicOf } from "../digest/singleLine";
import { drawToc, type TocEntry } from "./DigestToc";
import { addStoryMark } from "./storyOpen";
import { MIXED_BAG, TOP_STORIES, sectionLabel } from "../digest/labels";

export const NOT_IN_LIST = "no longer in the reader's list";
export const editionDate = (id: number): string => new Date(id).toLocaleDateString(undefined, { dateStyle: "medium" });

/** Previous/next arrows and a list of the editions' dates (today's first). `ids`: newest first; `current`: the edition shown. */
export function drawSwitcher(into: HTMLElement, ids: readonly number[], current: number, pick: (id: number) => void): void {
  const at = ids.indexOf(current);
  const bar = into.createDiv({ cls: "blyg-daily-switcher" });
  const older = bar.createEl("button", { text: "‹", cls: "blyg-daily-btn", attr: { title: "Previous edition", "aria-label": "Previous edition" } });
  const select = bar.createEl("select", { cls: "blyg-daily-select", attr: { "aria-label": "Edition" } });
  ids.forEach((id, i) => {
    const o = select.createEl("option", { text: i === 0 ? `${editionDate(id)} (today's edition)` : editionDate(id), attr: { value: String(id) } });
    if (id === current) o.setAttr("selected", "true");
  });
  select.addEventListener("change", () => pick(Number(select.value)));
  const newer = bar.createEl("button", { text: "›", cls: "blyg-daily-btn", attr: { title: "Next edition", "aria-label": "Next edition" } });
  const older1 = ids[at + 1];
  const newer1 = ids[at - 1];
  if (older1 === undefined) older.setAttr("disabled", "true");
  else older.addEventListener("click", () => pick(older1));
  if (newer1 === undefined) newer.setAttr("disabled", "true");
  else newer.addEventListener("click", () => pick(newer1));
}

/** A past edition, read-only: sections with their stories (headline, summary, posts) and single posts. */
export interface PastHooks {
  open: (p: ReadingPost) => void;
  /** A section's box was drawn (so the table of contents and the reader's chip can scroll to it). */
  section: (name: string, el: HTMLElement) => void;
  go: (name: string) => void;
}

export function drawPast(root: HTMLElement, rec: PastEdition, byId: ReadonlyMap<string, ReadingPost>, hooks: PastHooks): void {
  const open = hooks.open;
  root.createDiv({ cls: "blyg-daily-meta", text: `Read-only: the edition of ${editionDate(rec.id)}, as it was written.` });
  const row = (into: HTMLElement, id: string): void => {
    const p = byId.get(id);
    const r = into.createDiv({ cls: "blyg-daily-row blyg-daily-member" });
    if (p) {
      r.createEl("button", { cls: "blyg-daily-link blyg-daily-who", text: authorOf(p) }).addEventListener("click", (e) => {
        e?.stopPropagation?.();
        open(p);
      });
      r.addEventListener("click", () => open(p)); // a tap anywhere on the post's area
    } else {
      r.createDiv({ cls: "blyg-daily-who", text: rec.who[id] ?? "A post" });
      r.createDiv({ cls: "blyg-daily-meta blyg-past-gone", text: `(${NOT_IN_LIST})` });
    }
  };
  /** Draws a story; returns the posts it holds (what the contents count). */
  const story = (into: HTMLElement, i: number): number => {
    const s = rec.stories[i];
    if (!s) return 0;
    const card = into.createDiv({ cls: "blyg-daily-cluster blyg-story" });
    const title = card.createEl("button", { cls: "blyg-daily-link blyg-daily-headline blyg-story-headline", text: s.headline });
    const summary = s.summary ? card.createEl("button", { cls: "blyg-daily-link blyg-story-summary", text: s.summary }) : null;
    const meta = card.createDiv({ cls: "blyg-daily-meta", text: `${s.posts.length} ${s.posts.length === 1 ? "post" : "posts"}` });
    const list = card.createDiv({ cls: "blyg-daily-members" });
    let shown = false;
    const paintOpen = addStoryMark(card, meta, [title, ...(summary ? [summary] : [])]);
    const toggle = (): void => {
      shown = !shown;
      list.empty();
      paintOpen(shown);
      if (shown) for (const id of s.posts) row(list, id);
    };
    paintOpen(false);
    title.addEventListener("click", toggle);
    summary?.addEventListener("click", toggle); // the summary does what the headline does
    return s.posts.length;
  };
  /** A single post, as on today's page: the content line in bold, "by <Author>" in italics; a post the reader no longer holds is told so. */
  const single = (into: HTMLElement, id: string): number => {
    const p = byId.get(id);
    const r = into.createDiv({ cls: "blyg-daily-row blyg-story-mixed" });
    const main = r.createDiv({ cls: "blyg-story-main" });
    const line = rec.lines?.[id];
    if (p) {
      const text = line ? topicOf(line, p) : "";
      main.createEl("button", { cls: "blyg-daily-link blyg-story-who blyg-story-line", text: text || byLine(p) }).addEventListener("click", (e) => {
        e?.stopPropagation?.();
        open(p);
      });
      if (text) main.createDiv({ cls: "blyg-story-by", text: byLine(p) });
      r.addEventListener("click", () => open(p));
    } else {
      main.createDiv({ cls: "blyg-daily-who", text: line ?? rec.who[id] ?? "A post" });
      main.createDiv({ cls: "blyg-daily-meta blyg-past-gone", text: `(${NOT_IN_LIST})` });
    }
    return 1;
  };
  // The contents are made from the headings as they are drawn (one line per heading, in that order, counting what is drawn under it), then put in the slot above the first.
  const toc: TocEntry[] = [];
  const tocSlot = root.createDiv();
  const box = (title: string, about?: string): HTMLElement => {
    const s = root.createDiv({ cls: "blyg-daily-section" });
    s.createEl("h3", { text: title });
    if (about) s.createDiv({ cls: "blyg-section-about", text: about });
    hooks.section(title, s);
    toc.push({ name: title, count: 0 });
    return s;
  };
  /** Posts drawn under the heading drawn last. */
  const drew = (n: number): void => {
    const last = toc[toc.length - 1];
    if (last) last.count += n;
  };
  if (rec.sections && rec.sections.length > 0) {
    const placed = new Set<number>();
    const placedPosts = new Set<string>();
    for (const sec of rec.sections) {
      const b = box(sectionLabel(sec.name), sec.about);
      // The same order as today's page (digest/order.ts): stories by their newest post (records from before that was kept stay as they were), single posts as recorded (newest first).
      const stories = [...sec.stories].sort((x, y) => (rec.stories[y]?.newest ?? 0) - (rec.stories[x]?.newest ?? 0) || x - y);
      for (const i of stories) if (!placed.has(i) && !!placed.add(i)) drew(story(b, i));
      for (const id of sec.posts) if (!placedPosts.has(id) && !!placedPosts.add(id)) drew(single(b, id));
    }
    const lost = rec.stories.map((_, i) => i).filter((i) => !placed.has(i));
    if (lost.length > 0) {
      const b = box("Other");
      for (const i of lost) drew(story(b, i));
    }
    const loose = rec.singles.filter((id) => !placedPosts.has(id));
    if (loose.length > 0) {
      const b = box(MIXED_BAG);
      for (const id of loose) drew(single(b, id));
    }
  } else {
    // An edition without sections: its stories are the Top stories (what the page drew as the lead).
    const front = box(TOP_STORIES);
    rec.stories.forEach((_, i) => drew(story(front, i)));
    if (rec.singles.length > 0) {
      const b = box(MIXED_BAG);
      for (const id of rec.singles) drew(single(b, id));
    }
  }
  if ((rec.sections && rec.sections.length > 0) || toc.length > 1) drawToc(tocSlot, toc, hooks.go); // one plain heading needs no contents
}
