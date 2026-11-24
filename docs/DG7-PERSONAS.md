# DG7: digest editors (authored personas) — plan

Status: built (selection: setting `digest.editor` = neutral | editor id | rota; no per-section columnists). See docs/ARCHITECTURE.md, "Editors (DG7)". Behind the existing features `daily` / `digest-ai`.

## Idea
The digest's headlines and summaries are written in the voice of an **editor**: a small cast of characters written by the plugin's author and shipped with the plugin. New editors arrive in plugin updates. No user-written persona text, no persona generated from subscriptions (both would put someone's text into the system prompt).

## Decisions taken
- Authored, versioned cast; no custom field. (Removes the prompt-injection surface of free text.)
- Start with 3 editors; each is an id, a name, a one-line blurb for the picker, and a style paragraph (about 400 characters, plain text, reviewed like code).
- Voice applies to story **headline and summary only**. The sections pass (names, bylines, "<Author> on <topic>" lines), the JSON shapes and the validation stay neutral.
- Untrusted-data defences unchanged: the persona paragraph goes in the system prompt AFTER the data rules, and says it sets voice only and never overrides them.

## Open questions (author's call)
1. Selection: a picker in the settings, or a rota (the edition id picks the editor, "Today's editor: …" under the masthead), or both (picker with a "Rota" choice).
2. Which 3 editors. Prefer editors with a beat or a constraint (a harbour-master, a forecaster, a crossword setter) over moods (snarky, funny).
3. Whether the editor can differ per section later (columnists).

## Design
- `src/digest/editors.ts`: `EDITORS: readonly { id, name, blurb, voice }[]`, `EDITORS_VERSION`, `editorFor(setting, editionId)` (pure; "neutral" is always available and is the default).
- `src/digest/llm.ts`: the story-text system prompt gets `voiceLine(editor)` appended; **cache key** = story id + post set + prompt version + model + editor id + `EDITORS_VERSION`, so switching or revising an editor regenerates the text and never shows the old voice. Prompt version bumped.
- Edition record: `EditionRec.editor?: string` (the editor that wrote it), so a past edition and its history show who wrote it. A later write in the same edition keeps the edition's editor (no mixed voices in one page); changing the setting applies from the next edition, or via "Re-write" (manual, costs tokens, uses the confirm line).
- Setting: `digest.editor` ("neutral" default, an editor id, or "rota"), settings schema + migration + settings UI row. Unknown ids fall back to neutral.
- UI: "Today's editor: <name>" muted line under the masthead when not neutral; a tap on a story's headline keeps the current behaviour, and the post's own first sentence stays reachable (members list) so a missed joke never hides the post.
- Estimate/confirm line unchanged in shape (persona text adds roughly 100 tokens per request; counted in the estimate).

## Tests
- Pure: `editorFor` (rota is deterministic per edition id, unknown id gives neutral); every editor's `voice` passes a length cap and has no markup, no URL, no instruction to ignore rules (a lint-style test over the shipped list).
- Request: system prompt contains the voice line after the data rules; the sections request contains no voice line; the user content is unchanged.
- Cache: changing editor or `EDITORS_VERSION` changes the key; same editor hits the cache.
- Record/history: editor stored and read back; old records without it read as neutral.
- View: the "Today's editor" line is drawn only when not neutral; text only.

## Risks
- A joke voice can bury meaning: mitigated by neutral default, per-edition editor shown, the first sentence one tap away.
- Voices can drift in quality between models: the editor paragraph is reviewed against real output before shipping (author does this, not the plugin).
- Rota may surprise people: shown under the masthead, and the picker can pin one editor.

## Device steps (when built)
1. Pick an editor (or Rota) in settings, write the digest: headlines and summaries are in that voice; section names and "Author on topic" lines are not.
2. Switch editor: the current edition keeps its voice, the next edition (or Re-write) uses the new one.
3. A past edition shows who wrote it.
