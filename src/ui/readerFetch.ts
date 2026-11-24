// "Ask Studio to fetch" in an open post: the Studio fetches that blyg, then the post is looked for again a few times. Kept out of ReaderView.ts (its size is capped).
import type { ReadResult } from "./ReaderView";
import type { ReadingPost } from "../studio/reading";

export interface FetchHost {
  resyncBlyg(p: ReadingPost): Promise<ReadResult>;
  isImported(p: ReadingPost): Promise<boolean | null>;
}
export interface FetchScreen {
  /** A line in the reader's status row. */
  say(text: string): void;
  /** False once the reader is closed. */
  alive(): boolean;
  /** The Studio holds the post now. */
  fetched(): void;
}

export async function askStudioToFetch(host: FetchHost, p: ReadingPost, screen: FetchScreen): Promise<void> {
  screen.say("Asking your Studio to fetch this blyg…");
  const done = await host.resyncBlyg(p);
  if (!done.ok) {
    screen.say(done.message);
    return;
  }
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => window.setTimeout(r, 2500));
    if (!screen.alive()) return;
    if ((await host.isImported(p)) === true) {
      screen.say("Your Studio has fetched this post.");
      screen.fetched();
      return;
    }
  }
  screen.say("The Studio has not fetched this post yet. Try again in a minute.");
}
