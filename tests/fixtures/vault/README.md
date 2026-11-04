# Fixture vault (CC0)

A tiny vault for `tests/e2e/obsidian/smoke.mjs`: the plugin is loaded in real Obsidian on a copy of it, and a draft is sent to a local Studio.

- The notes are an invented author's, copied from the demo vault's `Blyg/` folder (CC0 1.0, <https://creativecommons.org/publicdomain/zero/1.0/>).
  Nothing here is real, personal or private. Do not add notes that are not CC0.
- `plugin-data.template.json` becomes the plugin's `data.json` at run time (`data.json` itself is git-ignored); the script fills in the local
  Studio's address. The Studio token is put into Obsidian's keychain at run time, never into a file.
- Edge cases are made by the test during a run, never committed here.
