// The digest's table of contents, set like the contents column of a newspaper: the section's name, a dotted leader, and the number of items ("3 items") at the right, muted, where a page
// number would be (the stories' posts and the single posts it holds). The byline stays under the section's heading, not here. A tap scrolls to the section.
// One line per heading the page draws, in the order it draws them, made from the page itself (DigestView.section, DigestPast.box), so the contents cannot differ from the page.
// Counts: Top stories, sections and the Mixed bag count POSTS (a story's posts, single posts); Letters, Corrections and Retractions count their rows (one row each), under the same word "items".
// With more than TOC_OPEN_MAX sections it starts collapsed behind one line ("Sections (9)"). Text only (createEl({ text })), never HTML.
export const TOC_OPEN_MAX = 8;

export interface TocEntry {
  name: string;
  /** How many posts the section holds (the posts of its stories plus its single posts). */
  count: number;
}

export function drawToc(into: HTMLElement, entries: readonly TocEntry[], go: (name: string) => void): void {
  if (entries.length === 0) return;
  const many = entries.length > TOC_OPEN_MAX;
  const box = into.createDiv({ cls: "blyg-toc" });
  let list: HTMLElement;
  if (many) {
    const d = box.createEl("details", { cls: "blyg-toc-details" });
    d.createEl("summary", { text: `Contents (${entries.length})`, cls: "blyg-toc-summary" });
    list = d.createDiv({ cls: "blyg-toc-list" });
  } else list = box.createDiv({ cls: "blyg-toc-list" });
  for (const e of entries) {
    const b = list.createEl("button", { cls: "blyg-daily-link blyg-toc-row blyg-toc-link", attr: { title: `${e.count} ${e.count === 1 ? "post" : "posts"} in ${e.name}` } });
    b.createSpan({ cls: "blyg-toc-name", text: e.name });
    b.createSpan({ cls: "blyg-toc-leader", attr: { "aria-hidden": "true" } });
    b.createSpan({ cls: "blyg-toc-count", text: `${e.count} ${e.count === 1 ? "item" : "items"}` });
    b.addEventListener("click", () => go(e.name));
  }
}
