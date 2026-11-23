// What a single post's line says in the digest: the CONTENT first. The AI line used to read "<Author> on <topic>"; the author is shown on its own line now ("by <Author>"),
// so the stored lines keep working: a leading "<Author> on " that matches the post's author is cut off, any other line is shown as it is. Pure.
import { firstSentence } from "./cluster";
import { ownWords } from "./quotes";
import { authorOf } from "./storyMeta";
import type { ReadingPost } from "../studio/reading";

const upper = (s: string): string => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** The line without a leading "<Author> on " (the author is the post's, case as it was sent); other lines are returned as they are. */
export function topicOf(line: string, p: ReadingPost): string {
  const t = line.trim();
  for (const name of [authorOf(p), (p.authorName ?? "").trim(), p.subscriptionTitle]) {
    if (name !== "" && t.startsWith(`${name} on `) && t.length > name.length + 4) return upper(t.slice(name.length + 4).trim());
  }
  return t;
}

/** The bold line of a single post: the AI line's topic, else the post's first sentence; "" when it has neither. */
export function contentLine(p: ReadingPost, line?: string): string {
  const fromAi = line ? topicOf(line, p) : "";
  return fromAi !== "" ? fromAi : firstSentence(ownWords(p));
}

/** The standfirst under it. */
export const byLine = (p: ReadingPost): string => `by ${authorOf(p)}`;
