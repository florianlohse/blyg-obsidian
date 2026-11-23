// How a story shows that it can be tapped open, in type only (no box, no icon): its headline and summary are real buttons carrying aria-expanded, and the meta line ends in a small typographic mark ("›") that is hidden from screen readers.
// Shared by today's page and past editions.

/** Put the tap mark at the end of a story's meta line and return `paint(open)`, which sets the open look (a class on the story, aria-expanded on its controls). */
export function addStoryMark(story: HTMLElement, meta: HTMLElement, controls: readonly HTMLElement[]): (open: boolean) => void {
  meta.createSpan({ cls: "blyg-story-more", text: "›", attr: { "aria-hidden": "true" } });
  return (open: boolean): void => {
    story.toggleClass("is-open", open);
    for (const c of controls) c.setAttr("aria-expanded", String(open));
  };
}
