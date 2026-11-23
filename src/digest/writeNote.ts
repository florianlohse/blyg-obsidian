// What the Daily says after a manual "Write the digest" that had nothing to send, so the button never looks dead. Pure.
import type { Outcome, Written } from "./llm";

const singles = (n: number): string => `${n} single ${n === 1 ? "post is" : "posts are"} in the Mixed bag; ${n === 1 ? "it gets" : "they get"} no AI text.`;

/** `before`: the texts shown when the button was pressed; `stories`: stories on the front page; `mixed`: posts in the Mixed bag. "" when the run did something worth its own result. */
export function nothingToWriteNote(o: Pick<Outcome, "status" | "note">, before: ReadonlyArray<Written | null>, stories: number, mixed: number): string {
  if (o.note || (o.status !== "ok" && o.status !== "nothing-to-send")) return "";
  if (stories === 0 || o.status === "nothing-to-send") return `Nothing to write. ${mixed > 0 ? singles(mixed) : "There are no stories with several posts yet."}`;
  const allWritten = before.length === stories && before.every((w) => w !== null && !(w.fresh?.length ?? 0));
  return allWritten ? `Everything is already written.${mixed > 0 ? ` ${singles(mixed)}` : ""}` : "";
}
