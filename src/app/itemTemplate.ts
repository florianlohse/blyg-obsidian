// Templates for new items ("New fragment", "New thread", "Quote in thread", the extracted selection): the text of a new note is the
// author's template file from the vault, then whatever the command adds (a quote, the moved selection). Pure: src/main.ts reads the file
// and creates the note. The plugin's own property (`blyg_kind: thread`) is kept out of the author's hands: a template may carry it, but
// not contradict it, and may not carry the properties Publish writes (a copied id would make two notes one item).
import { extractFrontmatterBlock } from "../core/frontmatter";
import { NEW_THREAD_TEXT } from "./threadCommands";

export type ItemKind = "fragment" | "thread";

export type TemplateProblem =
  /** The properties block is opened but never closed. */
  | { kind: "unclosed" }
  /** The template carries a property only Publish may write. */
  | { kind: "publish-property"; key: string }
  /** The template says it is the other kind of item. */
  | { kind: "wrong-kind"; found: string };

/** What a placeholder in a template turns into. `format` is a moment.js format ("YYYY-MM-DD"), absent for a bare `{{date}}`. */
export interface TemplateVars {
  title: string;
  date: (format: string | undefined) => string;
  time: (format: string | undefined) => string;
}

/**
 * The placeholders of Obsidian's own Templates plugin that matter here: `{{title}}`, `{{date}}`, `{{time}}`, with an optional
 * `{{date:FORMAT}}` / `{{time:FORMAT}}`. Anything else (including Templater's `<% %>`) is left as it is. Applied to the template only, never
 * to what a command adds.
 */
export function expandTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_all, name: string, format: string | undefined) => {
    const which = name.toLowerCase();
    if (which === "title") return vars.title;
    const fmt = format === undefined || format.trim() === "" ? undefined : format.trim();
    return which === "date" ? vars.date(fmt) : vars.time(fmt);
  });
}

const KEY_LINE = /^([A-Za-z_][\w-]*)\s*:(.*)$/;

const unquote = (value: string): string => value.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();

/** Compose the text of a new note, or say what is wrong with the template. `template` is null when none is set. */
export function newItemText(opts: { kind: ItemKind; template: string | null; body: string }): { ok: true; text: string } | { ok: false; problem: TemplateProblem } {
  const { kind, template, body } = opts;
  if (template === null || template.trim() === "") return { ok: true, text: kind === "thread" ? `${NEW_THREAD_TEXT}${body}` : body };

  let head = template;
  const block = extractFrontmatterBlock(template);
  if (block === null) {
    if (/^---[ \t]*\r?\n/.test(template)) return { ok: false, problem: { kind: "unclosed" } };
    if (kind === "thread") head = `${NEW_THREAD_TEXT}${template}`;
  } else {
    let declared: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      const m = KEY_LINE.exec(line);
      if (m === null) continue;
      const key = m[1] as string;
      if (key === "blyg_kind") declared = unquote(m[2] as string);
      else if (key.startsWith("blyg_")) return { ok: false, problem: { kind: "publish-property", key } };
    }
    if (declared !== null && declared !== kind) return { ok: false, problem: { kind: "wrong-kind", found: declared } };
    if (declared === null && kind === "thread") {
      const eol = /^---[ \t]*(\r?\n)/.exec(template)?.[1] ?? "\n";
      const open = /^---[ \t]*\r?\n/.exec(template)?.[0] ?? "---\n";
      head = `${open}blyg_kind: thread${eol}${template.slice(open.length)}`;
    }
  }

  if (body === "") return { ok: true, text: head };
  // The command's text starts on a line of its own, after a blank line.
  const gap = head.endsWith("\n\n") || head.endsWith("\r\n\r\n") ? "" : head.endsWith("\n") ? "\n" : "\n\n";
  return { ok: true, text: `${head}${gap}${body}` };
}

/** The path to look a template up by: Obsidian note paths end in ".md", but typing the name without it should work too. */
export function templatePath(setting: string): string | null {
  const trimmed = setting.trim().replace(/^\/+/, "");
  if (trimmed === "") return null;
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}
