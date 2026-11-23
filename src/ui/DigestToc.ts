// The digest's table of contents: the sections as a list of links, each with its byline, right under the masthead. A tap scrolls to the section.
// With more than TOC_OPEN_MAX sections it starts collapsed behind one line ("Sections (9)"). Text only (createEl({ text })), never HTML.
export const TOC_OPEN_MAX = 8;

export interface TocEntry {
  name: string;
  about?: string | undefined;
}

export function drawToc(into: HTMLElement, entries: readonly TocEntry[], go: (name: string) => void): void {
  if (entries.length === 0) return;
  const many = entries.length > TOC_OPEN_MAX;
  const box = into.createDiv({ cls: "blyg-toc" });
  let list: HTMLElement;
  if (many) {
    const d = box.createEl("details", { cls: "blyg-toc-details" });
    d.createEl("summary", { text: `Sections (${entries.length})`, cls: "blyg-toc-summary" });
    list = d.createDiv({ cls: "blyg-toc-list" });
  } else list = box.createDiv({ cls: "blyg-toc-list" });
  for (const e of entries) {
    const row = list.createDiv({ cls: "blyg-toc-row" });
    const b = row.createEl("button", { cls: "blyg-daily-link blyg-toc-link", text: e.name });
    b.addEventListener("click", () => go(e.name));
    if (e.about) row.createDiv({ cls: "blyg-toc-about", text: e.about });
  }
}
