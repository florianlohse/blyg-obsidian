// The reader's two doors to following a blyg (HK7): a "Following" button in the feed's header (opens "Blygs I follow"), and, on a post of a blyg the
// Studio does not read, a row that says so with a "Follow this blyg" button. Drawing only; the steps are in app/followFlow.ts.
import type { ReadingPost } from "../studio/reading";
import { followText, type FollowOutcome } from "../app/followFlow";

/** What the reader asks of the plugin for following. `ReaderHost` extends this. */
export interface FollowHost {
  /** Open "Blygs I follow" (with an address already typed in, when one is given). */
  openFollowed(prefill?: string): void;
  /** Follow the blyg at this address (a plain blyg at once; anything else is said to need the full screen). */
  followBlyg(origin: string): Promise<FollowOutcome>;
}

/** A post of a blyg this Studio does not read (a mention's post, a quoted source, an address that was opened): not your own, and no subscription holds it. */
export const isUnfollowedPost = (p: Pick<ReadingPost, "own" | "subscriptionId" | "origin">): boolean => p.own !== true && p.subscriptionId === "" && p.origin !== null && p.origin !== "";

/** The "Following" button of the feed header. */
export function drawFollowedButton(parent: HTMLElement, host: FollowHost): void {
  parent.createEl("button", { cls: "blyg-reader-btn blyg-reader-followbtn", text: "Following", attr: { title: "The blygs your Studio follows: follow one, rename it, or stop" } }).addEventListener("click", () => host.openFollowed());
}

/** Under an open post of an unfollowed blyg: what that means, and the button that follows it. Nothing for any other post. */
export function drawFollowNote(parent: HTMLElement, p: ReadingPost, host: FollowHost): HTMLElement | null {
  if (!isUnfollowedPost(p) || p.origin === null) return null;
  const origin = p.origin;
  const note = parent.createDiv({ cls: "blyg-reader-fetchnote blyg-reader-follownote" });
  const text = note.createSpan({ text: `${followText.unfollowedNote} ` });
  const button = note.createEl("button", { cls: "blyg-reader-btn", text: followText.followButton, attr: { title: "Ask your Studio to follow this blyg" } });
  button.addEventListener("click", () => {
    button.disabled = true;
    void host.followBlyg(origin).then((out) => {
      switch (out.kind) {
        case "followed":
          text.setText(followText.following(out.title));
          button.remove();
          return;
        case "already":
          text.setText(followText.already);
          button.remove();
          return;
        case "modal":
          button.disabled = false;
          host.openFollowed(out.url);
          return;
        case "problem":
          text.setText(`${out.message} `);
          button.disabled = false;
      }
    });
  });
  return note;
}
