// The settings row that picks the digest's editor (DG7). Only drawn while the AI layer is on.
import type { SettingGroupItem } from "obsidian";
import { EDITORS } from "../digest/editors";

export function editorRow(): SettingGroupItem {
  const options: Record<string, string> = { neutral: "Neutral (plain)", rota: "Rota (a different editor each edition)" };
  for (const e of EDITORS) options[e.id] = `${e.name}: ${e.blurb}`;
  return {
    name: "Digest editor",
    desc: "Who writes the headlines and summaries: a character with a voice, shipped with the plugin. Section names and lines stay plain. Neutral is the default; Rota picks a different editor each edition. An edition keeps the editor that wrote it: a change applies from the next edition, or at once with “Re-sort sections” (it writes the stories again and uses tokens). The editor's style is added to each request (about 100 tokens).",
    aliases: ["editor", "voice", "persona", "character", "style"],
    control: { type: "dropdown", key: "digest.editor", options },
  };
}
