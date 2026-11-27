# Changelog

All notable changes to the Blyg plugin. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
`x.y.z` for releases, `x.y.z-rc.N` for release candidates (public pre-releases of the same build) and `x.y.z-dev.N` for development pre-releases (see `docs/RELEASING.md`).

The public release job (`release-public.yml`) refuses a version that has no `## [x.y.z]` section here, and the text of that section
becomes the release notes. Write entries for people who use the plugin, not for the code.

## [Unreleased]

## [1.1.0] — 2026-11-27

**Works with Studio 0.73.** Studio 0.51.0 or newer, tested against 0.51.0 and 0.73.1. The plugin used to refuse Studios newer than 0.72; it now accepts 0.73 (API contract 7). Private items in the Studio (its notebook) are not published, edited or withdrawn from the plugin, and a publish from the plugin always asks for a public publish, even if your Studio's default is private.

**Read and save.** Three features that were behind a switch are now part of the plugin: the Daily, Save for later and Reception. Everything else that is new is still experimental and off until you switch it on.

### What's new

**The Daily.** A newspaper page of what the blygs you follow posted. Open it from the ribbon, the command "Open Daily", or the Feed | Digest switch in the reader.

- Stories (several posts on one subject) come first, single posts follow, and corrections to posts you may have read are listed apart. A new edition starts at the first open after your Digest time (default 07:00; set it in the Daily's menu or in Settings → Daily). The date under the title opens older editions (a small ▾ appears when there are some), shown read-only with a way back to today; the date is always written in English.
- Tap a story's "+" to unfold it. Posts you have read stay in place, in a lighter colour. Press and hold a post or story for a quick menu (open, reply, save for later, mark read or unread); one press opens one menu.
- Next and Previous in an open post walk the whole list you came from, and the counter says which ("Digest 4 of 12", "Feed 9 of 38"). Back returns to where you were.
- One Refresh: the circle in the header is the only update action, in the Daily and in the feed. It fetches new posts, and the line under the date tells how it went ("Fetching new posts…", "3 new posts, grouped · as of 09:52", "Nothing new · checked 09:52"). It sends nothing to an AI unless the AI summary is on, you have agreed, and "Write the digest automatically" is on.
- The Daily's menu (the hamburger) has four rows: Digest time, Write automatically (while the AI summary is on), Show what the digest sent, and Settings. A line "Digest billing this month" shows a rough estimate of what the AI writes cost this month across your devices (a guess, not a bill; it shows nothing when it cannot be worked out). Writing by hand and re-sorting are commands in the command palette: "Write the digest" and "Re-sort digest sections".
- **Daily sync between devices, new.** The edition and what you have read are shared between your devices through the plugin's settings file, so they need your vault sync to carry it. The masthead says "Synced from 2 devices" when it did.
- **An optional AI summary** (Settings → Daily digest → Use an AI model). It is off until you turn it on, asks once for your agreement ("The text of posts from blygs you follow is sent to <host> to write the digest. You can see what was sent afterwards under Show what the digest sent."), and uses your own API key from Obsidian's keychain. Before a manual "Write the digest" (command palette) it shows one line with the stories, posts, requests, about how many tokens and a rough cost. **What is sent:** for each story of several posts, the text of its posts (up to 20 posts, each cut at 4,000 characters) with the authors' display names; and, when there are at least four stories, sections requests that group the stories and place single posts. They send the headlines and summaries the AI wrote for the stories and, for each single post, its author's display name and its first lines (300 characters at most); the confirm line then says "the author and the first lines of N single posts go along". **Never sent:** your notes, your Studio token, your API key. "Show what the digest sent" lists each run and keeps the request text as sent for the last three. A daily token ceiling (Settings) limits automatic writing; "Write the digest" by hand is never blocked by it, but its tokens count.

**Save for later.** Press and hold a post in the feed or the Daily and choose "Save for later", or tap the bookmark in an open post. Saved posts carry a small bookmark, and "Saved" under Sort & filter shows only them. The list lives on your Studio's shelf, so your other devices and the Studio's web app share it. The shelf holds 50 posts; when it is full the plugin says so and drops nothing.

**Reception.** For a note you published, see who quoted or answered it. Words in your text that others quoted are underlined with a count, and a "Reception" section at the end of the note, in editing and in Reading view, lists who quoted a paragraph, the whole note, or replied, with a short preview. Tap a mark to see who and when. Open one of your own posts in the reader and a "Reception (N)" list at its foot shows who quoted or answered it, with a short excerpt; tap a row to open that reply. It is only drawn, never written into your note; switch the marks and the section on or off under Settings → Marginalia.

**Also better.** Posts you open count as read: a post that has been open for about a second is marked read (Settings → Blyg → Reader → "Mark posts as read when I open them", on by default; your own posts are never marked, and the manual read mark works as before). "Load older posts" at the end of the feed reads 200 older posts at a time, up to 5000 posts in all. A tidier open post (the counter on the first line, Save as a bookmark, Previous and Next as icons). A post marked read in the open post shows as read in the Daily. A failed save can be tried again.

### Still experimental

Off until you switch them on under Settings → Experimental features: **Send passage to note** (with drafting selected words as a fragment or thread), **New items from a thread** (the Studio's `![[+ passage]]` and `[[+ idea]]`), and **Open a shared address**. They keep improving; this release does not promote them.

### Good to know

- **Save for later** needs a token with every permission ticked (it uses `owner:manage`) and a Studio that offers the shelf (Studio 0.67.0 or newer; the plugin says so in one line when yours does not).
- **Reception** works best on blygs you follow.
- **Marking posts as read when you open them is on by default** and needs the token permission to change read marks; turn it off in Settings → Blyg → Reader.
- The AI summary sends text to the provider you choose (by default `api.anthropic.com`) only after you agree and only when you ask for it by hand or switch on automatic writing. Single posts go along (author and first lines) in the sections requests, not in the story texts.
- Needs Obsidian 1.13.0 or newer. It works on mobile.
- If you had switched the Daily, Save for later or Marginalia on or off under Experimental features: those switches are gone, the features are on, and nothing you saved is lost. The AI summary stays off until you turn it on.
- No settings migration is needed.

**Rollback:** install the previous release (1.0.0) from its GitHub page.

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
