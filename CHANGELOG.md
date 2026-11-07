# Changelog

All notable changes to the Blyg plugin. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
`x.y.z` for releases, `x.y.z-rc.N` for release candidates (public pre-releases of the same build) and `x.y.z-dev.N` for development pre-releases (see `docs/RELEASING.md`).

The public release job (`release-public.yml`) refuses a version that has no `## [x.y.z]` section here, and the text of that section
becomes the release notes. Write entries for people who use the plugin, not for the code.

## [Unreleased]

## [0.10.0] — 2026-11-07

One new command, for quoting a web page. Nothing changes in how the plugin publishes or reads, and your settings carry over unchanged.

### Added

- **Insert web quote (plain Markdown).** Quote a passage from any web page, a Substack post for example: paste the passage and the page's address into a small form and get an ordinary Markdown quote with an italic source link under it. The link's text can be an alias you type; without one the address is shown shortened. Tracking parameters (`utm_…` and the like, and Substack's share parameters) are taken out of the address. Your text is kept if the app is closed while you go to the browser to copy the address. It is not a blyg item: nothing is checked, fetched or sent, and it works in any note.
- **Settings → Web quote** holds a template for the whole block, with `{quote}`, `{link}`, `{alias}` and `{url}`, so you decide where the quote, the link and any blank line go. By default the source is an italic line directly under the quote, with no blank line between.

## [0.9.1] — 2026-11-06

A small maintenance release: nothing changes in how the plugin publishes or reads.

### Added

- Issue forms for bug reports and ideas, and a security policy (`SECURITY.md`), in the repository, so a report arrives with the details that matter (versions, device, Studio).

### Changed

- The README says that pull requests are not accepted for now; ideas and fixes go into an issue.
- Development builds (the test flavour, `Blyg (dev)`, numbered `x.y.z-dev.N`) connect only to test Studios (an address ending in `.workers.dev`, or localhost), so they can never
  publish to a real Studio, and the settings say so on top. A development build does nothing while the real plugin is enabled (it says so; only one can run at a time),
  and a fresh development install starts with the test folder `Studio test/` instead of `blyg/`. None of this changes the plugin you install from here.

## [0.9.0] — 2026-11-06

The first public release (a beta). Install it through BRAT from `florianlohse/blyg-obsidian` (see the README). Release candidates are published first as
pre-releases `0.9.0-rc.N`; the text of this section is the release notes of both.

**Publish to your own Blygger Studio from Obsidian, on desktop and mobile.**

### Added

- Fragments and threads from folders you choose, with a preview of what will change before every send; failures leave a draft and your note untouched.
- Quotes (whole or a passage) and replies as stubs; find an item by pasting its address.
- Drafts-only folders, pull the Studio's copy into a note, import items written in the Studio, withdraw, delete a draft, hoppers.
- **Studio-only mode:** no GitHub account, repository or token needed.

### Changed

- Speaks **Studio API contract 5**: needs **Studio 0.51.0 or newer** (tested with Studio 0.51.0 to 0.53.0, API contract 5.2 to 5.4); older Studios are refused before anything is sent. If you ran 0.7.x, update the Studio first.
- Settings: **Advanced → Also publish to a GitHub-hosted site** is now a switch. Switching it on shows the GitHub settings right below it, in the
  same box; switching it off hides them again. Nothing you typed is deleted. If you already use a GitHub-hosted site, the switch starts on.
- A thread that is a reply now says so in plain words: the panel shows **Stub: a reply to …**, and so does the send window.
- **Studio: repost this note**, **Studio: list reposted items** and the panel's **Repost to Studio** button are only offered when you also
  use a GitHub-hosted site (they move an old GitHub-site item into the Studio). Everyone else no longer sees them.
- A Studio whose API is a newer minor version than the one this plugin was tested with is no longer reported as a warning: "Check connection"
  shows a muted note, and the panel shows at most one small muted line. Newer minor versions only add things and are accepted; a newer major
  version is still refused.
- The plugin id is now **`blyg`** (was `obsidian-blyg`). Existing early users are taken over once from the old install.

### Fixed

- The panel's **Created** and **Updated** rows for a published item now show the dates the Studio reports (they showed "—").

### Security

- A trailing dot no longer lets `localhost.`, `x.local.` or `x.internal.` pass the private-network refusal when reading other blygs.
- A Studio token that ended up inside an error text is now removed from the log.

**Needs:** Obsidian 1.13.0+, a Studio token with `owner:read owner:draft owner:publish` (30-day lifetime, kept in Obsidian's keychain).

**Known gaps:** no images, no mentions list, no reader stream, tokens renewed by hand every 30 days.
**Planned:** mentions, images, OAuth sign-in, community-plugin listing after a beta period (1.0.0).

## [0.7.0] and earlier

Released only to the author's own devices (0.0.1–0.7.0, from `obsidian-blyg`). Not documented here; the project history is private.
