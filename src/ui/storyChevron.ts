// The chevron of a story card: the visible sign that a story can be tapped open (it points down when folded and turns up when unfolded). Shared by today's page and past editions.
// The card is a subtle box (styles.css `.blyg-story`); the chevron is a real button so it can be tapped and read out ("Show the posts of this story" / "Hide ...").
import { setIcon } from "obsidian";

/** Add the chevron to `card` and return `paint(open)`, which sets the open look (a class and aria-expanded on the card's controls). `toggle` is called by a tap on the chevron. */
export function addChevron(card: HTMLElement, controls: readonly HTMLElement[], toggle: () => void): (open: boolean) => void {
  const chev = card.createEl("button", { cls: "blyg-story-chevron clickable-icon", attr: { "aria-label": "Show the posts of this story", title: "Show the posts of this story" } });
  setIcon(chev, "chevron-down");
  chev.addEventListener("click", toggle);
  return (open: boolean): void => {
    card.toggleClass("is-open", open);
    for (const c of [chev, ...controls]) c.setAttr("aria-expanded", String(open));
    const label = open ? "Hide the posts of this story" : "Show the posts of this story";
    chev.setAttr("aria-label", label);
    chev.setAttr("title", label);
  };
}
