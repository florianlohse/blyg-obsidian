// Wikilinks and embeds in a note's text, outside code (docs/SECURITY.md §2, "links to private notes").
import { BLYG_ID_PATTERN } from "./ids";

export interface WikiLink {
  /** The note name part of the link: no `|alias`, no `#heading` or `#^block`. */
  target: string;
  embed: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Same length as `text`, with fenced code blocks and inline code replaced by spaces (newlines kept). */
export function maskCode(text: string): string {
  const lines = text.split("\n");
  let fence: { char: string; length: number } | null = null;
  const masked = lines.map((line) => {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1]?.[0] === fence.char && (m[1]?.length ?? 0) >= fence.length && line.trim() === m[1]) fence = null;
      return " ".repeat(line.length);
    }
    if (m) {
      fence = { char: m[1]?.[0] ?? "`", length: m[1]?.length ?? 3 };
      return " ".repeat(line.length);
    }
    // inline code on this line
    return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (span) => " ".repeat(span.length));
  });
  return masked.join("\n");
}

/** Every `[[…]]` / `![[…]]` outside code, once per distinct target. Links to Blyg ids (`[[<26-char id>]]`) are skipped. */
export function extractWikilinks(text: string): WikiLink[] {
  const masked = maskCode(text);
  const seen = new Set<string>();
  const links: WikiLink[] = [];
  for (const m of masked.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)) {
    const raw = text.slice((m.index ?? 0) + (m[1]?.length ?? 0) + 2, (m.index ?? 0) + m[0].length - 2);
    const target = (raw.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
    if (target === "" || BLYG_ID_PATTERN.test(target)) continue;
    const embed = m[1] === "!";
    const key = `${embed ? "!" : ""}${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ target, embed });
  }
  return links;
}
