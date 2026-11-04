# Changelog

All notable changes to the Blyg plugin. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
`x.y.z` for releases, `x.y.z-rc.N` for release candidates (public pre-releases of the same build) and `x.y.z-dev.N` for development pre-releases (see `docs/RELEASING.md`).

The public release job (`release-public.yml`) refuses a version that has no `## [x.y.z]` section here, and the text of that section
becomes the release notes. Write entries for people who use the plugin, not for the code.

## [Unreleased]

### Added

- Development builds: a second build flavour, `blyg-dev` ("Blyg (dev)"), can sit next to the real plugin in a test vault with its own
  settings. Development pre-releases are numbered `x.y.z-dev.N`.

## [0.9.0] — 2026-11-04

The first public release (a beta). Install it through BRAT from `florianlohse/blyg-obsidian` (see the README). Release candidates are published first as
pre-releases `0.9.0-rc.N`; the text of this section is the release notes of both.

**Publish to your own Blygger Studio from Obsidian, on desktop and mobile.**

### Added

- Fragments and threads from folders you choose, with a preview of what will change before every send; failures leave a draft and your note untouched.
- Quotes (whole or a passage) and replies as stubs; find an item by pasting its address.
- Drafts-only folders, pull the Studio's copy into a note, import items written in the Studio, withdraw, delete a draft, hoppers.
- **Studio-only mode:** no GitHub account, repository or token needed.

### Changed

- Speaks **Studio API contract 5**: needs **Studio 0.51.0 or newer**; older Studios are refused before anything is sent. If you ran 0.7.x, update the Studio first.
- The plugin id is now **`blyg`** (was `obsidian-blyg`). Existing early users are taken over once from the old install.

### Security

- A trailing dot no longer lets `localhost.`, `x.local.` or `x.internal.` pass the private-network refusal when reading other blygs.
- A Studio token that ended up inside an error text is now removed from the log.

**Needs:** Obsidian 1.13.0+, a Studio token with `owner:read owner:draft owner:publish` (30-day lifetime, kept in Obsidian's keychain).

**Known gaps:** no images, no mentions list, no reader stream, tokens renewed by hand every 30 days.
**Planned:** mentions, images, OAuth sign-in, community-plugin listing after a beta period (1.0.0).

## [0.7.0] and earlier

Released only to the author's own devices (0.0.1–0.7.0, from `obsidian-blyg`). Not documented here; the project history is private.
