# AGENTS.md — Blyg for Obsidian

An Obsidian plugin (TypeScript) that publishes to a Blygger blyg and reads and responds to other blygs. This file is for coding agents and contributors; people who use the plugin start at `README.md`.
One maintainer. Most work is done in cloud agent sessions and tested on an iPad or iPhone, so anything that needs a person must be doable on a phone.

## Commands

```bash
npm ci
npm run lint && npm test && npm run build   # must pass before every commit
npm run dev                                 # esbuild watch -> main.js
```

Test layers, the parity suite and the UI scenarios: `docs/TESTING.md`. Architecture and settings: `docs/ARCHITECTURE.md`. Security notes: `SECURITY.md`.

## Invariants (flag it if one needs revisiting, do not change it silently)

- **Mobile first.** `manifest.json` has `"isDesktopOnly": false`. No Node or Electron APIs in `src/` (`fs`, `path`, `os`, `child_process`, `electron`, Node `crypto`); use Web APIs and Obsidian's API. Network only through Obsidian's `requestUrl`. Lint enforces this.
- **Nothing setup-specific in code.** Repositories, branches, origins, routes, folders and caps are settings with generic defaults. A real person's values never appear in code, tests, fixtures or docs; use placeholders such as `example.com` and `your-site-repo`.
- **Secrets only in Obsidian's keychain** (`app.secretStorage`). Settings store the entry's name, never its value. Never log a token, put it in a URL, or write it to a file.
- **Fail closed.** A path that matches no route is refused. A publish that cannot be verified as safe is refused before any network call.
- **The local note changes only after the remote write succeeded.**
- **Protocol promises are permanent.** A published id is served forever, versions only go up, withdrawal is an end cap, never a delete. Test against a preview channel or a throwaway Studio, never with throwaway items on a live blyg.
- **Borrowed code keeps its licence notice** in the file header.

## Working here

- Branch from `main` as `claude/<topic>` (or your own name); open a pull request into `main`; never push to `main` directly.
- Every pull request body has two sections, checked by CI (`.github/pull_request_template.md`): `## User-facing note` (what people who use the plugin will notice, or `none`) and `## Device steps` (0 to 3 steps the maintainer does on a device, or `none: covered by tests`).
- **This repository is public: every push is a publication.** Commit messages and pull request bodies describe the code and may name plan IDs; they carry no internal reasoning, no private names and no secrets. Before you push, run the leak scan (the same one CI runs):

  ```bash
  node scripts/public-scan.mjs --tree . --commits origin/main..HEAD --history origin/main..HEAD
  ```

  CI (`public-guard.yml`) scans the files, the pull request title and body, the commit messages and what every commit added, and runs gitleaks over the files and the commits. A red scan is fixed at the cause, never by editing the scan.
- Dev builds: a merge into `main` that changes the plugin's build inputs (`scripts/dev-gate.mjs`) is also built as a dev build and published to a separate repository for testers (`dev-build.yml`). Nothing to do by hand.
- Releases: the maintainer merges the pull request "Release x.y.z"; the release workflow does the rest. Do not start a release workflow by hand. See `docs/RELEASING.md` if present.
