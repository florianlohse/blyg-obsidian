// The Daily's past editions: the day switcher and a past edition drawn read-only from its saved record (src/digest/history.ts).
// Everything is put on the page as text (createEl({ text })), never HTML. Posts open in the reader only when the reader still holds them.
import type { PastEdition } from "../digest/history";
import { authorOf } from "../digest/storyMeta";
import type { ReadingPost } from "../studio/reading";

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
export function drawPast(root: HTMLElement, rec: PastEdition, byId: ReadonlyMap<string, ReadingPost>, open: (p: ReadingPost) => void): void {
  root.createDiv({ cls: "blyg-daily-meta", text: `Read-only: the edition of ${editionDate(rec.id)}, as it was written.` });
  const row = (into: HTMLElement, id: string): void => {
    const p = byId.get(id);
    const r = into.createDiv({ cls: "blyg-daily-row blyg-daily-member" });
    if (p) r.createEl("button", { cls: "blyg-daily-link blyg-daily-who", text: authorOf(p) }).addEventListener("click", () => open(p));
    else {
      r.createDiv({ cls: "blyg-daily-who", text: rec.who[id] ?? "A post" });
      r.createDiv({ cls: "blyg-daily-meta blyg-past-gone", text: `(${NOT_IN_LIST})` });
    }
  };
  const story = (into: HTMLElement, i: number): void => {
    const s = rec.stories[i];
    if (!s) return;
    const card = into.createDiv({ cls: "blyg-daily-cluster blyg-story" });
    const title = card.createEl("button", { cls: "blyg-daily-link blyg-daily-headline blyg-story-headline", text: s.headline });
    if (s.summary) card.createDiv({ cls: "blyg-story-summary", text: s.summary });
    card.createDiv({ cls: "blyg-daily-meta", text: `${s.posts.length} ${s.posts.length === 1 ? "post" : "posts"}` });
    const list = card.createDiv({ cls: "blyg-daily-members" });
    let shown = false;
    title.addEventListener("click", () => {
      shown = !shown;
      list.empty();
      if (shown) for (const id of s.posts) row(list, id);
    });
  };
  const box = (title: string): HTMLElement => {
    const s = root.createDiv({ cls: "blyg-daily-section" });
    s.createEl("h3", { text: title });
    return s;
  };
  if (rec.sections && rec.sections.length > 0) {
    const placed = new Set<number>();
    const placedPosts = new Set<string>();
    for (const sec of rec.sections) {
      const b = box(sec.name);
      for (const i of sec.stories) if (!placed.has(i) && !!placed.add(i)) story(b, i);
      for (const id of sec.posts) if (!placedPosts.has(id) && !!placedPosts.add(id)) row(b, id);
    }
    const lost = rec.stories.map((_, i) => i).filter((i) => !placed.has(i));
    if (lost.length > 0) {
      const b = box("Other");
      for (const i of lost) story(b, i);
    }
    const loose = rec.singles.filter((id) => !placedPosts.has(id));
    if (loose.length > 0) {
      const b = box("Mixed bag");
      for (const id of loose) row(b, id);
    }
    return;
  }
  const front = box("Front page");
  rec.stories.forEach((_, i) => story(front, i));
  if (rec.singles.length > 0) {
    const b = box("Mixed bag");
    for (const id of rec.singles) row(b, id);
  }
}
