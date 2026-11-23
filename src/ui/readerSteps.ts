// Previous / Next in an open post, and the counter next to the read mark. Kept out of ReaderView.ts (its size is capped). A post opened from a story of the digest walks the
// posts of THAT story, in the order of its unfolded list; any other post walks the feed's order, as before.
import { setIcon } from "obsidian";
import type { ReadingPost } from "../studio/reading";

const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;

export interface Step {
  keys: string[];
  at: number;
  /** The story the walk is in ("Story: <headline>"), absent for the feed's order. */
  story?: string;
}

/** The posts of one story as the digest listed them, handed to the reader when a post is opened from that story. */
export class StoryWalk {
  private title = "";
  private posts: ReadingPost[] = [];
  set(w: { title: string; posts: readonly ReadingPost[] } | null): void {
    this.title = w?.title ?? "";
    this.posts = w ? [...w.posts] : [];
  }
  clear(): void {
    this.set(null);
  }
  /** Where `p` is in the story, or null when this is not a story's walk or `p` is not in it. */
  where(p: ReadingPost): Step | null {
    const keys = this.posts.map(keyOf);
    const at = keys.indexOf(keyOf(p));
    return at < 0 || this.posts.length < 2 ? null : { keys, at, story: this.title };
  }
  post(key: string): ReadingPost | null {
    return this.posts.find((q) => keyOf(q) === key) ?? null;
  }
}

export interface StepHooks {
  button(parent: HTMLElement, text: string, run: () => void | Promise<void>, opts: { cls?: string; disabled?: boolean; title?: string }): HTMLButtonElement;
  addIcon(el: HTMLElement, icon: string): void;
  /** Open the neighbour; `markRead`: the open one counts as read first (a long press on Next). */
  step(delta: 1 | -1, markRead: boolean): Promise<void>;
}

const LONG_PRESS_MS = 500;

/** Previous and Next, in the corner of the thumb row. A tap steps; holding Next marks the open post read and goes on. */
export function drawSteps(row: HTMLElement, where: Step, h: StepHooks): void {
  const what = where.story !== undefined ? "story" : "feed";
  const steps = row.createDiv({ cls: "blyg-reader-steps" });
  const prev = h.button(steps, "", () => h.step(-1, false), { cls: "blyg-reader-step blyg-reader-step-prev", disabled: where.at <= 0, title: `The post before this one in the ${what}` });
  h.addIcon(prev, "chevron-left");
  let longPressed = false;
  const next = h.button(steps, "Next", () => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    return h.step(1, false);
  }, { cls: "blyg-reader-step blyg-reader-step-next", disabled: where.at >= where.keys.length - 1, title: `The post after this one in the ${what}. Hold to mark this one read and go on.` });
  const icon = createSpan({ cls: "blyg-reader-icon" });
  setIcon(icon, "chevron-right");
  next.append(icon);
  let timer = 0;
  const cancel = (): void => window.clearTimeout(timer);
  next.addEventListener("pointerdown", () => {
    longPressed = false;
    timer = window.setTimeout(() => {
      longPressed = true;
      void h.step(1, true);
    }, LONG_PRESS_MS);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) next.addEventListener(ev, cancel);
  next.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** "3 of 24", or in a story "Story: <headline> · 2 of 4": where the open post is in what Next and Previous walk. */
export function stepCount(parent: HTMLElement, where: Step): void {
  const count = parent.createSpan({ cls: "blyg-reader-stepcount" });
  if (where.story !== undefined) count.createSpan({ cls: "blyg-reader-steptitle", text: `Story: ${where.story}` }).setAttr("title", where.story);
  if (where.story !== undefined) count.appendText(" · ");
  count.createEl("strong", { text: String(where.at + 1) });
  count.appendText(` of ${where.keys.length}`);
}
