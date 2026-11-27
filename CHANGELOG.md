# Changelog

All notable changes to the Blyg plugin. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
`x.y.z` for releases, `x.y.z-rc.N` for release candidates (public pre-releases of the same build) and `x.y.z-dev.N` for development pre-releases (see `docs/RELEASING.md`).

The public release job (`release-public.yml`) refuses a version that has no `## [x.y.z]` section here, and the text of that section
becomes the release notes. Write entries for people who use the plugin, not for the code.

## [Unreleased]

- **Works with Studio 0.73 (API contract 7).** The plugin accepted Studios up to 0.72 (contract 6) and refused newer ones. It now speaks contract 7 as well, tested against Studio 0.51.0 and 0.73.1. Private items (the Studio's notebook) are shown as not publishable from here and nothing is sent for them; a publish from the plugin always asks for a public publish, even if your Studio's default is private.
- **Draft selected words as a fragment or thread (experimental).** Select your own words in a note and choose "Draft as Blyg fragment" or "Draft as Blyg thread" in the editor menu (or the matching commands). The words are copied into a new draft that opens for editing; your note stays as it is and nothing is published. "Back to note" returns to the original words. A selection with a quote of another post is offered as a thread and keeps the quote whole; if it cuts through a quote you are asked first. Part of Settings → Experimental features → "Send passage to note".
- **Send a passage to a note (experimental).** Select text in an open post and tap **Send to note** (a bar at the foot of the reader). Pick a note from the folders you chose in Settings (several allowed, recent ones first), then a heading, and the passage is written there as a native Blyg quote, ready for you to write your reaction below it; **Open note** takes you there. Publishing a thread from that note later shows the quote with its source and only the words you selected. Switch it on under Settings → Experimental features → "Send passage to note".
- **A tidier open post and Daily (experimental).** In an open post the counter ("Feed · 9 of 38", "Digest · <heading> · 4 of 12") is on the first line, at the right, and its numbers are never cut; Save is a bookmark symbol (outline, filled once saved) next to the read mark, and Previous and Next are icons. A small filled bookmark before a post's details replaces the word "saved" on cards, in the Daily and in the open post. In the Daily a story ends its line with "+" (then "−") to unfold it, each post in it has its own read mark, "Mark story read" is the last item of an unfolded story, and a headline no longer turns blue when pressed. A small line above the stories shows what the edition cost in dollars and who edited it (nothing is shown when the AI wrote nothing), the permanent cost line under "Written by" is gone, and the Daily's menu lists its actions as rows. The feed's header has a menu button at the right of its first row (Sort & filter, Sources, Settings), and the feed shows a thin spinner while it loads for the first time.
- **The Daily: read posts dim in place.** A post you have read stays where it is, in a lighter colour; a story whose posts are all read has its headline and summary lighter too. Nothing is hidden or folded, and the edition is the same on all your devices.
- **Next and Previous walk the whole list you came from.** From the Daily they go through every post of the page, top to bottom, singles included and read ones too, not only one story; from the feed they go through the feed as shown (its order, choices or Saved view). The counter counts the same list and says which one: "Digest 4 of 12", "Feed 9 of 38".
- **One Refresh.** In the Daily, Refresh fetches new posts and, when "Write the digest automatically" is on, also writes the texts that are missing for new or changed stories (within the daily token ceiling). With that setting off it sends nothing to your AI provider and says so in one line. "Write the digest" and "Re-sort sections" moved into an "Advanced" part of the Daily's menu.

- **Fixes in the open post.** A post marked read in the open post, when you came from the Daily, now shows as read in the Daily and when you open it again. The header of an open post no longer shifts while it settles. A save that fails for want of a connection puts Save back with a short line, and tapping it again tries again. The feed says "Loading…" until its first list has arrived instead of "nothing to show".
- **Save posts for later (experimental).** Press and hold a post in the feed or the Daily and choose "Save for later", or tap "Save" in an open post. Saved posts get a small "saved" mark, and a "Saved" choice under Sort & filter shows only them (the shelf holds 50 posts; when it is full the plugin says so and drops nothing). The list lives on your Studio's shelf, so your other devices and the Studio's web app share it. It needs a Studio with the shelf and a token with the permission "owner:manage"; without them the plugin says so in one line. Switch it on under Settings → Experimental features → "Save posts for later".
- **The reader can go further back.** "Load older posts" at the end of the feed reads 200 older posts at a time from your Studio, up to 5000. Long feeds stay quick: only the cards near the screen are drawn.

## [1.0.0] — 2026-11-18

**Read the blygs you follow, answer them, and publish your own, without leaving your notes.** Blyg connects Obsidian to a Blygger Studio you own, on your desktop, iPad and iPhone.

### What's new since 0.11

**The reader (experimental).** "Open reader" shows the posts of the blygs your Studio follows as a feed of cards: who wrote it, how long ago, how long it takes to read, what is unread, what answers you.

- Sort by newest, oldest or reading time; filter by blyg, length, unread, or replies to your posts.
- Posts open as text on their own calm reading surface, with quotes shown as bars and their source named.
- Previous and Next at the foot of a post. Hold Next to mark the post read and go on.
- **Reply to what you just read:** select a passage and Reply starts a new thread that quotes exactly that passage.
- Replies you can see, mentions of your items (with Dismiss), and read marks that follow you between devices.
- It opens at once from a saved list and then catches up, so a long list does not slow Obsidian's start.

**A panel organised by what you want to do.** The note's next step comes first, as one button (Review publication, Review update, Review draft). The writing buttons are grouped under "Start writing", and the rest is folded under "Work on this note" and "Details". A fragment shows a live character counter.

**Pictures in your notes.** Images you embed from your vault are uploaded with the item, and the publish window now shows them as readers will see them, scaled to fit the window.

**Clearer setup.** "Connect your Studio" lists the steps in order, and the token step says which permissions to tick.

### Good to know

- You need your own **Blygger Studio**, version 0.51.0 or newer. Every change is tested against Studio 0.51.0 and the newest release (0.62.0 at this release).
- Needs Obsidian 1.13.0 or newer. It works on mobile.
- Your token lives only in Obsidian's keychain. For read marks in the reader and for dismissing mentions, create a token with **every permission ticked**; an existing token keeps working for publishing.
- The reader loads the newest 200 posts of the blygs you follow. Loading older posts is planned.
- No settings migration is needed.

**Rollback:** install the previous release (0.11.0) from its GitHub page.

## [0.11.0] — 2026-11-12

You can now put images in your Studio notes. Nothing else changes, and your settings carry over unchanged.

### Added

- **Images in Studio notes.** A note can embed an image from your vault, `![[photo.png]]`, `![[photo.png|a red door]]` (the text after the bar is the image's description) or `![a red door](photo.png)`, and publishing uploads it to your Studio with the item. The window shows how many images go up and how big they are. PNG, JPEG, GIF, WebP and SVG up to 5 MB are accepted, and the image has to be inside the folder of the note's route (or below it); an image that is missing, outside that folder, too big or of another kind (an iPhone HEIC photo, for example) stops the publish before anything is sent, with the line it is on. Publishing the same note again uploads nothing it does not have to, and the panel tells you about a problem image before you tap Publish. Images work in Studio routes only; the older GitHub-hosted routes still refuse them.

## [0.10.1] — 2026-11-11

The quote picker is easier to use when you paste something. Nothing else changes, and your settings carry over unchanged.

### Added

- **Settings survive a missing settings file.** If the settings file is missing or empty (a plugin folder replaced by an update tool, or a vault restored), the settings (token entry names, Studio address, routes) are restored from a copy this device keeps in the app's local storage, and a notice says so. Tokens stay in the keychain.
- **A new thread starts right under its properties.** The blank line (two, in fact) that a new thread note started with is gone: the cursor starts on the first line under the properties.
- **A reply starts with the quote, and your cursor below it.** A reply note (Reply to item, or "Reply" in the reader) starts with the quote of the item you answer, right under the properties, and the cursor waits under it after one blank line. The short-lived setting "Write a reply above the quote" is gone. (This also removes the second blank line a reply used to have above the quote.)
- **Paste an item's id.** In "Insert quote", "Insert link" and when you start a reply, you can paste the id the reader's "Copy id" gives you (the whole `[[id | "…"]]` text, or the id alone) instead of the item's address. It finds your own items and items of the blygs your Studio is subscribed to. For any other blyg, paste the item's address ("Copy url"); the picker says so.

### Changed

- **A clear "Looking up…" while an address or id is looked up.** A line with a spinner shows above the list, and the list is greyed and cannot be chosen from until the answer is in, so it is plain that you are meant to wait a moment.

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
