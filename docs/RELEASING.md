# Releasing

How a change becomes a dev build, and how a release is made. One maintainer; every step that needs a person is doable from a phone. Workflows are in `.github/workflows/`; the scripts they use are in `scripts/`.

**Do not start a release workflow by hand.** The release is the maintainer's merge of the pull request "Release x.y.z".

## Two flavours of one codebase

| | `blyg` | `blyg-dev` |
|---|---|---|
| Plugin id / name | `blyg` / "Blyg" | `blyg-dev` / "Blyg (dev)" |
| For | real vaults | the maintainer's test vault, against a test Studio |
| Published by | `release.yml`, as a release of this repository | `dev-build.yml`, as a release of a separate dev-builds repository |
| Version | `x.y.z` | `x.y.z-dev.N` |

The code is identical. `scripts/flavour.mjs` derives the dev manifest at build time (id `<id>-dev`, name `<name> (dev)`), so different ids mean separate plugin folders and settings. Both flavours cannot run in one vault: the dev build stays idle while the real plugin is enabled. A dev build only talks to test Studios (the address must end in `.workers.dev` or be local; `src/studio/devLock.ts`), because a published id is permanent.

## Dev builds (`dev-build.yml`)

A merge into `main` that changes a build input (listed in `scripts/dev-gate.mjs`) makes a dev build; a merge of docs or workflows only makes none. Three jobs keep the token away from dependency code:

- `gate` decides whether to build, by comparing with the `Source commit:` line in the newest dev-builds release. No secret.
- `build` installs, lints, tests, builds and assembles the dev files. No secret.
- `publish` holds the only secret (a fine-grained token limited to the dev-builds repository) in the environment `dev-builds`, restricted to `main`, and creates the release `x.y.z-dev.N`, marked Latest.

Settings (repository variables): `DEV_BUILDS_REPO` (`owner/name` of the dev-builds repository; unset in a fork means nothing runs), `DEV_AUTO_RELEASE=false` (stops the automatic builds). "Run workflow" on `main` always builds. BRAT's "Latest" is the highest-semver release that is not a pre-release, which is why dev builds are normal releases in a repository of their own.

## Preparing a release

On the maintainer's "prepare release patch" (or minor, major), a session:

1. Runs `node scripts/prepare-release.mjs --bump patch --body-out <file> --dry` to look. `--since <commit>` names the commit of the last release if no earlier pull request titled "Release x.y.z" exists.
2. Runs it again without `--dry`: it bumps `manifest.json`, `package.json`, `package-lock.json` and `versions.json`, writes the `## [x.y.z]` section of `CHANGELOG.md` from the merged pull requests' `## User-facing note` sections, and writes the pull request body (a checklist).
3. Rewrites the generated notes for readers, reads by hand any pull request without the two sections, commits, pushes and opens the pull request titled exactly `Release x.y.z`.
4. CI, the leak guard and the release dry run run on it. `release-pr-ticked.yml` fails while a checklist box is unticked.
5. The maintainer runs the listed device steps, ticks the boxes and merges.

A release with no change for users is not made.

## What the merge does

`release-on-merge.yml` runs on every push to `main`. Its `plan` job (`scripts/release-plan.mjs`) says yes only if GitHub links the pushed commit to a merged pull request titled `Release x.y.z` (the title decides, not the commit message), every checklist box is ticked, `manifest.json` says x.y.z and `CHANGELOG.md` has `## [x.y.z]`. Anything that looks like a release but is not in order fails the run loudly; fix it and re-run the jobs. Every other push does nothing. If the plan says yes, `dispatch` starts `release.yml` and nothing more.

`release.yml` on dispatch repeats the checks strictly, runs lint and tests, builds, and the `publish` job creates a draft release at the verified commit with `main.js`, `manifest.json` and `styles.css`, then publishes it. It needs no secret (it uses the run's own token) and runs only while the repository variable `PUBLIC_RELEASE_ENABLED` is exactly `true` (anything else is the emergency off-switch), on `main`, in the environment `public-release`. On a pull request the same workflow is a dry run: checks, leak scan, a production build and the assembled files; it publishes nothing.

## The release gate (a release is refused without these)

`scripts/release-gate.mjs` runs in the verify job of `release.yml` on every release dispatch; the publish job needs that job, so a red gate publishes nothing. It reads GitHub's own records, never text a contributor can edit.

1. **The right commit.** `release-on-merge.yml` passes the merge commit's SHA to the dispatch; the run refuses if the checkout is any other commit (main moved on), or is not the merge commit of the pull request "Release x.y.z".
2. **Your confirmed Obsidian preview.** After you run the official review preview on the release candidate, comment on the release pull request, from your own account (the gate accepts only a comment by the repository owner):

   ```
   Obsidian preview: <the full 40-character commit SHA> Completed errors=0
   ```

   `Failed`, `Incomplete`, errors above 0, a short SHA, a comment older than 7 days or a comment by anyone else do not count; the newest such comment decides. The pull request body gives the candidate SHA; copy it whole.
3. **Same tree.** The reviewed commit must have the same git tree as the commit being released. The merge commit has another SHA than the pull request head, but the same tree if nothing changed; any source or version change after your scan blocks the release. Scan again and comment again.
4. **Required CI on that commit:** `check`, `guard`, `verify`, `declares`, `ticked`, `e2e (pinned)`, `e2e (newest)`, `obsidian-smoke`, `obsidian-ui`, each with its own successful result (skipped, cancelled, pending or missing blocks). `ci.yml` has no `continue-on-error`.
5. **Newest Obsidian.** `obsidian-ui-newest` runs on the release pull request as well as on pushes. It stays advisory: if it failed, comment `Newest Obsidian UI accepted: <full SHA>` to go ahead; if it is missing or still running, wait.

On the release pull request the same checks run as warnings (the "Release gate" step of the `verify` job, see its summary), so you can see what is missing before you merge.

**If a release is blocked:** read the run's summary (each line says what is missing), fix that (comment, wait for CI, scan the new candidate), then "Re-run jobs" on the "Release on merge" run of the merge. If the tree changed, open a new release pull request. The emergency off-switch `PUBLIC_RELEASE_ENABLED` is unchanged and nothing waives a failed or missing preview.

Not covered by the gate, by design: whether the preview you confirmed is true (it is your statement, bound to a SHA and tree), and released-asset attestations (a preview cannot show them).

## Guards on every push

This repository is public, so every push is a publication. `public-guard.yml` scans the files, the pull request title and body, commit messages and what each commit added, against the generic list in `.github/release/public-needles.txt` and a private list held as a repository secret, and runs gitleaks (pinned, checksummed). A red scan is fixed at its cause, never by editing the scan. Before pushing, run the same scan locally (`AGENTS.md`).
