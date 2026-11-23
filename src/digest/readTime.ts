// How long a single post takes to read, as the digest shows it: its words at 200 words a minute, at least one minute. Local and plain: no AI.
import { plainText } from "../ui/defang";
import type { ReadingPost } from "../studio/reading";

export const WORDS_PER_MINUTE = 200;

export function digestMinutes(p: Pick<ReadingPost, "contentHtml">): number {
  const words = plainText(p.contentHtml).split(/\s+/).filter((w) => w !== "").length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
export const digestReadTime = (p: Pick<ReadingPost, "contentHtml">): string => `${digestMinutes(p)} min`;
