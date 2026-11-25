// How a story shows that it can be tapped open, in type only (no box, no icon): its headline and summary are real buttons carrying aria-expanded, and the meta line ends in a small
// typographic marker at its right end, "+" while folded and "−" while unfolded. The marker is a button of its own (it folds and unfolds like a tap on the headline) set at the
// right end of the line by the style sheet, out of the flow: it takes no new line and no height. Shared by today's page and past editions.

/** Put the marker at the right end of a story's meta line and return `paint(open)`, which sets the open look (a class on the story, the marker, aria-expanded on the controls). `toggle` folds or unfolds the story. */
export function addStoryMark(story: HTMLElement, meta: HTMLElement, controls: readonly HTMLElement[], toggle: () => void): (open: boolean) => void {
  meta.addClass("blyg-story-metaline");
  const mark = meta.createEl("button", { cls: "blyg-story-more", text: "+", attr: { "aria-label": "Show the posts of this story", "aria-expanded": "false" } });
  mark.addEventListener("click", (e) => {
    e?.stopPropagation?.();
    toggle();
  });
  return (open: boolean): void => {
    story.toggleClass("is-open", open);
    mark.textContent = open ? "−" : "+";
    mark.setAttr("aria-label", open ? "Hide the posts of this story" : "Show the posts of this story");
    mark.setAttr("aria-expanded", String(open));
    for (const c of controls) c.setAttr("aria-expanded", String(open));
  };
}
