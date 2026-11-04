import { parseYaml, stringifyYaml, type App, type TFile } from "obsidian";
import { swapBody } from "../core/frontmatter";
import type { NoteEditPort, NoteRef, VaultPort, Yaml } from "./ports";

export const obsidianYaml: Yaml = { parse: parseYaml, stringify: stringifyYaml };

export function noteRefOf(file: TFile): NoteRef {
  return { path: file.path, name: file.name, extension: file.extension };
}

/** Vault access for the publish services. Notes are looked up by path at use time, so a renamed note is not stale. */
export function obsidianVault(app: App): VaultPort {
  const fileOf = (note: NoteRef): TFile => {
    const file = app.vault.getFileByPath(note.path);
    if (!file) throw new Error(`The note “${note.path}” no longer exists.`);
    return file;
  };
  return {
    read: (note) => app.vault.read(fileOf(note)),
    blygId: (note) => app.metadataCache.getFileCache(fileOf(note))?.frontmatter?.blyg_id as unknown,
    frontmatterValue: (note, key) => app.metadataCache.getFileCache(fileOf(note))?.frontmatter?.[key] as unknown,
    resolveLink: (target, fromPath) => {
      const file = app.metadataCache.getFirstLinkpathDest(target, fromPath);
      return file ? { path: file.path, extension: file.extension } : null;
    },
    updateFrontmatter: (note, update) => app.fileManager.processFrontMatter(fileOf(note), update),
  };
}

/** Finding notes by id and replacing a note's text (bringing a Studio's copy in). */
export function obsidianNoteEdit(app: App): NoteEditPort {
  return {
    notesWithBlygId: (id) =>
      app.vault
        .getMarkdownFiles()
        .filter((f) => app.metadataCache.getFileCache(f)?.frontmatter?.blyg_id === id)
        .map(noteRefOf),
    linkText: (note, fromPath) => {
      const file = app.vault.getFileByPath(note.path);
      return file ? app.metadataCache.fileToLinktext(file, fromPath, true) : note.path.replace(/\.md$/, "");
    },
    replaceBody: async (note, expected, replacement) => {
      const file = app.vault.getFileByPath(note.path);
      if (!file) throw new Error(`The note “${note.path}” no longer exists.`);
      await app.vault.process(file, (data) => {
        const swapped = swapBody(data, expected, replacement);
        if (swapped === null) throw new Error("The note changed meanwhile.");
        return swapped;
      });
    },
  };
}
