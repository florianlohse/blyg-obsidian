// Previous / Next in an open post, and the counter next to the read mark. Kept out of ReaderView.ts (its size is capped). One rule: Next and Previous walk ALL the posts of the list
// the open post was opened from, in that list's order, whatever the entry point. From the digest that list is the Daily's page top to bottom (every story's posts, then the
// singles, read ones included); from the feed it is the feed as it is shown (its order, filter or Saved view). The counter counts that same list and names it ("Digest 4 of 12").
import { setIcon } from "obsidian";
import type { ReadingPost } from "../studio/reading";

const keyOf = (p: ReadingPost): string => `${p.subscriptionId}/${p.remoteId}`;

export type StepMode = "digest" | "feed";

export interface Step {
  keys: string[];
  at: number;
  /** Which list the walk is in: the Daily's order or the feed's. */
  mode: StepMode;
}

/** The Daily's posts in the order the page shows them, handed to the reader when a post is opened from the digest. */
export class DigestWalk {
  private posts: ReadingPost[] = [];
  set(posts: readonly ReadingPost[] | null): void {
    const seen = new Set<string>();
    this.posts = (posts ?? []).filter((p) => !seen.has(keyOf(p)) && !!seen.add(keyOf(p)));
  }
  clear(): void {
    this.set(null);
  }
  /** Where `p` is in the digest's order, or null when no digest list is held or `p` is not on it. */
  where(p: ReadingPost): Step | null {
    const keys = this.posts.map(keyOf);
    const at = keys.indexOf(keyOf(p));
    return at < 0 ? null : { keys, at, mode: "digest" };
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
  const what = where.mode === "digest" ? "digest" : "feed";
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

/** "Feed 3 of 24" or "Digest 4 of 12": where the open post is in what Next and Previous walk (the mode word is the existing title span, kept short). */
export function stepCount(parent: HTMLElement, where: Step): void {
  const count = parent.createSpan({ cls: "blyg-reader-stepcount" });
  count.createSpan({ cls: "blyg-reader-steptitle", text: where.mode === "digest" ? "Digest" : "Feed" });
  const num = count.createSpan({ cls: "blyg-reader-stepnum" });
  num.appendText(" ");
  num.createEl("strong", { text: String(where.at + 1) });
  num.appendText(` of ${where.keys.length}`);
}
