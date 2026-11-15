# Changelog

All notable changes to the Blyg plugin. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
`x.y.z` for releases, `x.y.z-rc.N` for release candidates (public pre-releases of the same build) and `x.y.z-dev.N` for development pre-releases (see `docs/RELEASING.md`).

The public release job (`release-public.yml`) refuses a version that has no `## [x.y.z]` section here, and the text of that section
becomes the release notes. Write entries for people who use the plugin, not for the code.

## [Unreleased]

### Added

- **Reader (experimental).** The command "Open reader" (and "Open blyg reader" in the mobile menu, beside "Open blyg publisher") opens a tab with the posts of the blygs your Studio reads, and the mentions of your items. The header with the tabs, the controls and each post's buttons stays in place while you scroll; its spinning ring and status line show when something is loading.
  - **Feed:** cards with the blyg, the author, how long ago, how long it takes to read, thread / reply / unread badges, the quoted words and the start of the text. "Sort & filter" (closed at first, so the header stays slim) opens the choices: newest, oldest, shortest or longest read first; one blyg; posts under 2 minutes, 2 to 5, or over 5; only unread; the font of a post's content; and whether posts open as their web page or as text. The feed ends with the plugin's version.
  - **Font:** a new setting "Font for posts" (serif, sans-serif or monospace, from the fonts your device has; none is downloaded) sets the type of a post in the text view; the interface keeps Obsidian's, and the web page view is never changed by it.
  - **Next post:** "Read & next ›" in an open post's header (both views) marks it read and opens the next unread one in the order of the feed; with none left it goes back to the feed. In the text view you can also pull up at the end of a post: the text fades as you pull, a label shows what will happen, and letting go early does nothing. Between two posts a centred "Marked read" appears for a moment. "Back" and "Read & next ›" are large and come first in the header. On a phone the pane is measured against Obsidian's floating bottom bar, so the last lines are never hidden behind it; the reader's buttons keep their own square corners whatever the theme does to buttons.
  - **Reading surface (text view only):** a post in the text view sits on its own calm ground, with a plain quote shown with a bar and lighter type and a quote of another blyg's item (a transclusion) with its own accent bar, a faint tint and a small label ("Quote from a blyg" or "Passage from a blyg"). The new setting "Contrast of the reading surface" (reduced, normal, high; also in "Sort & filter") changes how strongly the text stands out. The web page view is never changed by a setting.
  - **Where a quote comes from:** under a quote of another blyg's item the text view names its source when the Studio can tell: a post of a blyg you read ("↗ Author · Blog": a tap opens that post in the reader, and "Back" returns to the post you were reading), or your own item. Otherwise the quote keeps its label only.
  - **Replies you can see:** an open post shows a chip "↩ …" when something visible answers it: green "↩ You" when you replied (your own item whose reply target is this post), and "↩ N" for posts of blygs you read that answer it. Tapping it lists them as cards like the feed's (yours marked and highlighted); a post of a blyg you read opens here, yours opens its note. It never asks other blygs and never counts strangers: the protocol keeps "who responded to an item you did not publish" off the wire on purpose.
  - **Posts with unfamiliar markup are drawn, not refused.** A post that carries markup the reader does not draw (a tag it does not know, a comment, a broken tag) is shown with that left out and its text kept, and a small line says formatting was left out; scripts, styles and the like are dropped with their contents. The spec's own markup is understood: text a publisher marked as generated gets a faint dotted mark (its tooltip says the disclosure is the publisher's own and not verified), and a quote keeps its origin and the author's label. The rule that nothing from a post can load or run something is unchanged.
  - **Quote sources, more:** under a quote the author's own label is used as the link text, and for a quote of another blyg's item that you do not read the line shows the blyg's host; a tap looks the item up through your Studio and opens its page in the browser.
  - **Fonts:** the serif and sans-serif choices use the system's own fonts where there are any (New York and SF on Apple devices).
  - **Feed cards** show the same reply badge as an open post (green "↩ You" when you replied).
  - **Reply preview (view-only):** a reply note starts with the line that quotes the item it answers (`![[id | label]]`), which used to show as a bare id. In the editor's Live Preview and in Reading view that line now shows the item's text in a card (your own item, an item of a blyg you read, or, for the item named in the note's `blyg_stub_of`, an item of a blyg you do not read, looked up through your Studio). Nothing is written into the note or the vault: the line stays as it is, the text is fetched when the note is shown and kept in memory for ten minutes. Another blyg's text is drawn through the reader's own filter (images wait for a tap). "Edit line" (and moving the cursor onto the line) shows the line as written; source mode always does; a line inside fenced code is left alone.
  - **Remembered:** the feed's order, blyg, length and "Unread only" choices are kept in the settings, so they are the same after a restart. A blyg you no longer read is dropped from the choices.
  - **Loading:** the first posts show as soon as they arrive, and the status line counts them ("Loading… 100 posts so far").
  - **Mentions:** each mention shows what the other blyg wrote (from your reading list, or by looking it up) and the item of yours it is about, and opens like a post in the reader. A post from a blyg your Studio does not read has no read mark and no reply here.
  - **Sidebar:** the command "Open reader in the sidebar" opens the reader beside the note you write, as well as in a tab; each keeps its own place in the feed.
  - **Fresh:** opening or refreshing asks your Studio to look for new posts right away (at most every ten minutes on opening, every minute on Refresh) and stops waiting as soon as every blyg has answered.
  - **A post:** as its author's web page inside Obsidian, trimmed to the post (the blyg's own look, without its menus, header and links; no scripts run), with the text shown at once while the page loads; or as text ("As text" / "As web page"). Its blyg and author are links. A page that cannot be shown falls back to text. All text can be selected.
  - **Read marks:** a ○ / ✓ button on every card and in a post's header marks it read or unread, and the feed changes at once. This needs a token with every permission (the extra one is "reading:state"); without it the reader says so and puts the mark back.
  - **Reply and more:** "Reply in Obsidian" (a new thread that answers the post) and "Browser" (the whole page, outside Obsidian).
- **Settings "Open posts as" and "Images in posts you read".** "Open posts as": "Web page" (the default) or "Text". For text, "Images in posts you read": "Load on click" (the default) shows each image as a button that names the server it comes from and loads it only when you tap it; "Always load" draws images with the post. Loading an image, or a post's web page, tells its server that you read the post. A post whose markup the reader does not recognise is not drawn as text; it offers "Open in browser" instead.

## [0.11.0] — 2026-11-12

You can now put images in your Studio notes. Nothing else changes, and your settings carry over unchanged.

### Added

- **Images in Studio notes.** A note can embed an image from your vault, `![[photo.png]]`, `![[photo.png|a red door]]` (the text after the bar is the image's description) or `![a red door](photo.png)`, and publishing uploads it to your Studio with the item. The window shows how many images go up and how big they are. PNG, JPEG, GIF, WebP and SVG up to 5 MB are accepted, and the image has to be inside the folder of the note's route (or below it); an image that is missing, outside that folder, too big or of another kind (an iPhone HEIC photo, for example) stops the publish before anything is sent, with the line it is on. Publishing the same note again uploads nothing it does not have to, and the panel tells you about a problem image before you tap Publish. Images work in Studio routes only; the older GitHub-hosted routes still refuse them.

## [0.10.1] — 2026-11-11

The quote picker is easier to use when you paste something. Nothing else changes, and your settings carry over unchanged.

### Added

- **Settings survive a missing settings file.** If the settings file is missing or empty (a plugin folder replaced by an update tool, or a vault restored), the settings (token entry names, Studio address, routes) are restored from a copy this device keeps in the app's local storage, and a notice says so. Tokens stay in the keychain.
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
