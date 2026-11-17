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
  - **Next post:** "Read & next ›" in an open post's header marks it read and opens the next unread one in the order of the feed; with none left it goes back to the feed. In the text view you can also pull up at the end of a post: the text fades as you pull, a label shows what will happen, and letting go early does nothing. Between two posts a centred "Marked read" appears for a moment. "Back" and "Read & next ›" are large and come first in the header. On a phone the pane is measured against Obsidian's floating bottom bar, so the last lines are never hidden behind it; the reader's buttons keep their own square corners whatever the theme does to buttons.
  - **Reading surface (text view only):** a post in the text view sits on its own calm ground, with a plain quote shown with a bar and lighter type and a quote of another blyg's item (a transclusion) with its own accent bar, a faint tint and a small label ("Quote from a blyg" or "Passage from a blyg"). The new setting "Contrast of the reading surface" (reduced, normal, high; also in "Sort & filter") changes how strongly the text stands out. The web page view is never changed by a setting.
  - **Where a quote comes from:** under a quote of another blyg's item the text view names its source when the Studio can tell: a post of a blyg you read ("↗ Author · Blog": a tap opens that post in the reader, and "Back" returns to the post you were reading), or your own item. Otherwise the quote keeps its label only.
  - **Replies you can see:** an open post shows a chip "↩ …" when something visible answers it: green "↩ You" when you replied (your own item whose reply target is this post), and "↩ N" for posts of blygs you read that answer it. Tapping it lists them as cards like the feed's (yours marked and highlighted); a post of a blyg you read opens here, yours opens its note. It never asks other blygs and never counts strangers: the protocol keeps "who responded to an item you did not publish" off the wire on purpose.
  - **Posts with unfamiliar markup are drawn, not refused.** A post that carries markup the reader does not draw (a tag it does not know, a comment, a broken tag) is shown with that left out and its text kept, and a small line says formatting was left out; scripts, styles and the like are dropped with their contents. The spec's own markup is understood: text a publisher marked as generated gets a faint dotted mark (its tooltip says the disclosure is the publisher's own and not verified), and a quote keeps its origin and the author's label. The rule that nothing from a post can load or run something is unchanged.
  - **Quote sources, more:** under a quote the author's own label is used as the link text, and for a quote of another blyg's item that you do not read the line shows the blyg's host; a tap looks the item up through your Studio and opens its page in the browser.
  - **Fonts:** the serif and sans-serif choices use the system's own fonts where there are any (New York and SF on Apple devices).
  - **Feed cards** show the same reply badge as an open post (green "↩ You" when you replied).
  - **Reply preview (view-only):** a reply note starts with the line that quotes the item it answers (`![[id | label]]`), which used to show as a bare id. In the editor's Live Preview and in Reading view that line now shows the item's text in a card (your own item, an item of a blyg you read, or, for the item named in the note's `blyg_stub_of`, an item of a blyg you do not read, looked up through your Studio). Nothing is written into the note or the vault: the line stays as it is, the text is fetched when the note is shown and kept in memory for ten minutes. Another blyg's text is drawn through the reader's own filter (images wait for a tap). "Edit line" (and moving the cursor onto the line) shows the line as written; source mode always does; a line inside fenced code is left alone.
  - **Buttons follow your theme.** The reader no longer forces its own corners: buttons and the choices in "Sort & filter" take the shape your theme gives buttons (a pill in some themes) and scale from the theme's own input height, with side padding in proportion, so any shape has room for its text.
  - **Replies chip without emoji:** the replies indicator and the quote-source line use icons of Obsidian's own set instead of arrow characters (which draw as colour emoji on a phone); the chip says "You replied", "You + 2" or "3 replies".
  - **"Checked 2 min ago"** instead of a clock time, kept current while the reader is open.
  - **The reader reads less, and remembers.** Refreshing used to read the whole list again whenever the Studio's reading counter moved, which with many blygs meant dozens of full reads; measured with 20 blygs reporting, one check cost 82 requests and 7.6 MB, now 11 requests and 0.5 MB. Now: a check asks the blygs once, watches the counters every three seconds and reads the list **once** at the end; lists are read in pages of 100 (the API's maximum); a refresh reads only the newest rows and stops where it reaches what it already has, with a full read of the newest 200 now and then (at most once a minute when only read marks moved, at least every ten minutes while anything moved) so read marks from other devices still arrive; while the reader is open it looks at the counters every 30 seconds and reads the list only when they moved; opening the reader no longer asks the Studio to check the blygs (the Studio fetches them itself every half hour; **Refresh** asks it to look now); when the Studio answers with an error the reader leaves it alone for 30 seconds, doubling to 30 minutes, and says when it will try again (Refresh asks now); the open post's "next unread" and the replies chips no longer scan the whole list.
  - **A saved list:** the reader keeps the newest 200 posts (without their Markdown) in a file in the plugin's own folder, never in a note, only for the Studio they came from and for two weeks, so the feed shows at once when you open it and is brought up to date behind it. The command "Clear the reader's saved list" removes it.
  - **Known limit: the newest 200 posts.** The reader loads the newest 200 posts of everything you follow. With many blygs, older unread posts are not reachable yet; "load older" and drawing long lists in parts are planned. The status line says so when the list is cut.
  - **Credit:** this follows what Burrow (`aneeshsathe/blygger-desktop`, by Aneesh Sathe) showed in its release 0.21, "Sync reads less from the blyg": look at the Studio's change counters first, read the list only when something moved and not in a tight loop, a safety-net full read now and then, back off when the Studio fails, pages of the maximum size, and ask the blygs to be checked only on request. Thank you.
  - **Remembered:** the feed's order, blyg, length and "Unread only" choices are kept in the settings, so they are the same after a restart. A blyg you no longer read is dropped from the choices.
  - **Loading:** the first posts show as soon as they arrive, and the status line counts them ("Loading… 100 posts so far").
  - **Mentions:** each mention shows what the other blyg wrote (from your reading list, or by looking it up) and the item of yours it is about, and opens like a post in the reader. A post from a blyg your Studio does not read has no read mark and no reply here.
  - **Sidebar:** the command "Open reader in the sidebar" opens the reader beside the note you write, as well as in a tab; each keeps its own place in the feed.
  - **A calmer header:** the "checked 2 min ago" line and the Refresh button are one bar under the tabs, with the plugin's version at its end (also shown in an open post). A post's Reply, Mark read and replies chip sit together in one tray, with "Browser" apart and quieter. The font and contrast choices left the "Sort & filter" header; they are in Settings → Blyg → Reader.
  - **Replies at the end of the post:** the replies you can see (your own, highlighted, and posts of blygs you read that answer it) are listed under the post's text, where replies are read. The "↩" chip in the header jumps to them.
  - **Dismiss a mention:** each mention has a "Dismiss" button. It hides the mention in your Studio too (it is the Studio's own "hidden" state, so its web pages stop showing it as well). This needs the token permission `owner:manage`; without it the mention comes back and the reader says what is missing.
  - **Faster reply preview:** the text a reply note quotes now shows at once when the reader already holds that post (from this session's list or the saved one), no longer waiting for a chain of requests to your Studio; otherwise the two first questions to the Studio are asked together instead of one after the other, a found item is remembered by its id alone, and it is asked for as soon as the note is opened.
  - **A reader tab left open no longer slows the start of Obsidian.** Obsidian waits for a view to finish opening before it finishes restoring its layout, and the reader used to wait for the Studio's whole answer before it was "open". It now opens at once as an empty shell. The saved list, your own items and the Studio's answer are read only after the layout is ready and the app is idle, and the feed builds a first screenful of posts (30) and more as you scroll or tap "Show more posts". Measured in real Obsidian with 200 saved posts: the layout was ready as fast as with the plugin switched off, with a Studio that answers after 6 seconds too (the old reader: 6.4 s), and no stall of the main thread.
  - **Fresh:** opening or refreshing asks your Studio to look for new posts right away (at most every ten minutes on opening, every minute on Refresh) and stops waiting as soon as every blyg has answered.
  - **A post:** shown as text on its own reading surface, with its blyg and author as links and all text selectable. "Browser" opens the whole page outside Obsidian. (An earlier test build could also show a post as its author's web page inside Obsidian; that view was taken out before 1.0, so the reader makes no request for a blyg's page or stylesheets.)
  - **Read marks:** a ○ / ✓ button on every card and in a post's header marks it read or unread, and the feed changes at once. This needs a token with every permission (the extra one is "reading:state"); without it the reader says so and puts the mark back.
  - **Reply and more:** "Reply in Obsidian" (a new thread that answers the post) and "Browser" (the whole page, outside Obsidian).
- **Setting "Images in posts you read".** "Load on click" (the default) shows each image as a button that names the server it comes from and loads it only when you tap it; "Always load" draws images with the post. Loading an image tells its server that you read the post.

### Changed

- **A character counter for fragments.** The panel's status card for a fragment shows "412 / 1000 characters", following what you type (a short pause after the last key). It counts what a publish would send: properties and `%% comments %%` are not counted, links to your notes count as the ids they are sent as. It turns into a warning near the limit and over it ("1034 / 1000 characters: 34 too many"). Threads have no limit and show nothing.
- **The feed's cards show a little formatting.** A heading is shown in bold with a line break after it, bold text in bold and italic text in italics. Everything else in a card (links, lists, code) stays plain words, and the card's length and cut are as before. (Cards are built from text pieces, never from markup.)
- **Sort & filter: "My posts" and "Replies to my posts only".** The Blyg choice lists **My posts** (your own posts in the feed) beside the blygs you read, and a switch **Replies to my posts only** shows just the posts that answer one of your own items. Both count on the "Sort & filter (n)" button, are remembered, and are lifted by "Clear filters".
- **Your own posts stay in the feed after a Refresh.** A quick read of the list used to drop them until the next whole read; they are kept now.
- **The hopper filter finds your own posts too.** Choosing a hopper in Sort & filter also shows your own posts you put into it (it showed only posts of the blygs you read, so a hopper that held only your own posts looked empty).
- **"Reply to you" has its own colour.** A post that answers one of your items has a green edge and a green badge (not the accent colour of "unread"), and keeps them after you have read it.
- **Reader settings say "reader".** "Font in the reader", "Images in the reader" and a preview that says "A reader item is shown here" and that it only changes how the reader shows what you read, not how your own blyg looks.
- **Reader cards read cleaner.** The line under a card's title no longer repeats the blyg's name as the author, and each piece ("2026-10-23", "1 min read") stays whole instead of breaking across two lines on a phone.
- **A filter that matches nothing says so and offers "Clear filters".** "No post matches the choices in Sort & filter" with a button that lifts every restriction (blyg, length, unread, hopper, "Show my posts" back on) and keeps the order.
- **Less help text in the way.** The pickers' hint is "search or paste: words, or a post link"; in Settings the template and web-quote placeholders are folded under "Show the placeholders" instead of filling the descriptions.
- **Settings: the GitHub site has its own box.** What essays and pages need (owner, repository, production branch, GitHub token, deploy watching, "Check connection") is now in **Website (GitHub)**, under the switch "Publish to a GitHub-hosted site". **Advanced** keeps only the older Blyg-on-GitHub settings (preview branch, "Publish to", Blyg address, items folder).
- **Settings: typos in a plain route are flagged.** A repository folder that does not start with `src/content/`, a web address with a stray character such as `|` where the `/` belongs, and a `{site}` that would be your Studio's address now get a note under the route. Publishing is not blocked.
- **Your own posts in the feed.** The feed now shows your own published posts among the others, marked "You" (they come from the Studio's merged reading list; the newest 100 entries are looked at on a whole read of the list). They are never unread and have no read mark; an opened own post has **Open note** (the note it was published from) instead of Mark read, and Reply is off (write the follow-up in your vault). **Sort & filter → Show my posts** hides them again (on by default; remembered).
- **Wording, one name for one thing.** The panel's "Import from Studio…" is **"Sync with Studio…"**; the ribbon says "Open Blyg panel" and "Open Blyg reader"; the palette says "Reply to item…", "Mark this thread as a reply to…" and "Studio: sync with Studio (new items)" (commands keep their ids and hotkeys). The pickers all say "Search words or paste a post link…". A mention's button is "Dismiss in Studio". In the import window "Don't offer the unticked ones again" is "Hide unticked items from future imports" and its "Show" is "Show hidden items"; the hoppers window's "Save" is "Save to note" and says the Studio updates when you next send or publish.
- **Settings wording.** "Fragment character limit", "Warn for threads longer than", "Web quote Markdown", "Remove tracking parameters from pasted links", "Images in the reader" (with "Load on tap" / "Always load"), "Publish folders" with "Add publish folder", and "Studio mount (optional)" with a plain explanation ("For a Studio under a path, enter that path, e.g. /blyg"). Values and behaviour are unchanged.
- **The feed marks posts that answer your items.** A post that is a reply to one of your own items carries an accent "reply to you" badge (the plain "reply" badge stays for answers to others).
- **Sort & filter: a Hopper choice.** When you have hoppers, "Sort & filter" offers "All hoppers" or one of them: the feed then shows only the posts of the blygs you read that you put into that hopper (the Studio says which; kept for the session).
- **Faster Mentions.** What the first mentions show (the post, and the excerpt of your item they are about) is fetched in the background as soon as the list arrives, a few at a time; your item's excerpt now comes from the list of your items the reader already holds, with no request per mention.
- **Reader post view, clearer and tidier.** Nested quotes (a quote of a quote) have no boxes any more: the bar on the left carries the depth, in the accent colour, lighter with every level. Code boxes scroll sideways and wide tables scroll, so they no longer break the frame. Under the Back / Next row a hairline separates the post's own buttons, which now form one segmented control (Browser, Mark read, replies) with Reply apart at the end. The line that says where a post is from ends with a small "copy link" that copies the post's address.
- **Settings: a live preview under "Font for posts" and "Contrast of the reading surface"**, drawn with the reader's own styles, so the choice can be judged without opening the reader.
- **The quote window says what it does:** "Quote selection (N chars)" (the count follows your selection) and "Quote whole post".
- **Reply to a passage.** In an open post, select some of its text: the Reply button becomes "Reply to selection (N chars)" and the new thread quotes exactly that passage (a partial quote, protocol §10.2) under the post's quote, instead of the whole post. The passage is cut from the post's own text, so it matches what the Studio checks; if the selection cannot be found there (a picture or table in the way), the quote window opens and you choose the passage in it. With nothing selected, Reply works as before.
- **Reader post: Reply and Browser swapped.** Reply, the main action, is the accented button at the far end of the row; Browser is the first, quiet button of the tray.
- **A post your Studio has not fetched can no longer be "replied to" and then fail.** When a post is opened from a mention or a quote and the Studio follows its blyg but never imported that post (its fetch of that blyg failed), the post says so, Reply and Mark read are greyed out, and "Ask Studio to fetch" asks the Studio to fetch that blyg now (token permission `owner:manage`) and looks for the post again a few times. (Before, Reply stayed live and the publish failed with "unknown item".)
- **Reader: Refresh in the middle, status on the left, version on the right.** The "Showing the newest 200 posts; older ones are not loaded yet" line is gone. The last-updated line ("Updated 3 min ago", and after a check "Up to date · checked 2 min ago") is there from the moment the reader opens. While a check runs the status counts the blygs that have answered ("Checking blygs · 5/25"), refreshed every 1.5 seconds.
- **Panel: Withdraw and Delete draft are in Details; Hoppers… is in Work on this note;** the quote button is called "Insert quote/link".
- **The reader's feed header takes two lines, not four.** Reading, Mentions and Sort & filter share one line. Under it: the Refresh icon (it spins while a check runs; the second spinner next to the status is gone), the status or progress on the left (cut with "…" when long) and the plugin version on the right.
- **In the panel, "Insert item…" is called "Insert quote/link"**, which says what it offers. (Reply to item… in Start writing starts a new thread that answers an item; this button puts a quote or a link into the thread you are writing.)
- **The panel's next step is the status.** The button that used to sit under "Published (v1) and up to date." and say "Review update" is gone from calm notes: a published, unchanged note shows only its green status. When there is something to send, the button is inside the status card and says what it does: **Publish…**, **Publish update…**, **Publish again…** or **Send draft…** (the "…" says a preview window opens first). **Open reader** and **Import from Studio…** moved to the top; **Open on web** stands beside the status; **Hoppers…** moved into Details; **Withdraw** and **Delete draft** have a folded section of their own. "Manage Studio" is gone.
- **Fewer, clearer writing buttons.** **Reply to item…** (was "New reply thread…") starts a thread that quotes the item and declares the answer. **Insert quote/link** replaces Insert quote and Insert link: pick an item, then quote it (whole or a passage) or tap **Link only**; in a fragment it inserts a link. **Mark as reply to…** (was "Set reply target…"). "Continue thread" and "Quote in new thread" are removed (the first only moved the cursor; the second is "Reply to item…" on your own item). The command palette is unchanged.
- **The reader's feed header** has no outlined box any more: a plain, centered Refresh button with the status under it.
- **The panel is organised by what you want to do.** Under the status line and the note's next step stands **Start writing** (New fragment, New thread, and with a Studio New reply thread… and Open reader). Everything else is folded into three sections you open by tapping their titles, and they stay open while you work: **Work on this note** (Quote in new thread, Continue thread, Make thread, Set reply target…, Insert quote, Insert link), **Manage Studio** (Withdraw, Delete draft, Hoppers…, Open on web, Import from Studio) and **Details** (the facts list). A line above the status names the note and whether it is a thread or a fragment. When a note's hoppers differ from the Studio's, **Use the Studio's hoppers** stands next to the next step instead of at the bottom. Renamed: "Quote in thread" → "Quote in new thread", "Reply to item" → "New reply thread…", "Make reply" → "Set reply target…".
- **The panel puts the note's next step first.** Under the status line, before the writing buttons and the facts, stands the one button the note needs next: **Review publication**, **Review update**, **Review republication** or **Review draft** (it only opens the window that shows what would be sent; that window's own button sends), and, when the Studio's copy was changed elsewhere, **Replace this note with the online text**. Withdraw, Delete draft, Hoppers and Open on web stay below. On a phone the drawer is taller than the screen, and the button used to be below the facts list.
- **The hint under a grey "Insert quote" no longer calls a draft "published".** A note that was sent to the Studio as a draft now says so, and says it can no longer be made a thread.
- **First run: the way to connect a Studio is said in order.** Before an address and a keychain entry are set, the panel says "Connect your Studio." with four steps (enter the address; create a token in the Studio under More → Client access; save it as a keychain entry on this device and pick it; tap Check connection) and that a token lasts 30 days and has to be entered again on each device. The settings' Setup check says the same four steps and ticks the first once the address is entered. The panel then hides what needs a Studio (Insert quote, Insert link, Hoppers, Withdraw, Open on web); writing a note still works. Pressing Publish with nothing connected says "Connect your Studio first: Settings → Blyg → Studio (address and token)." instead of a list of fields, and the reader says "Connect your Studio to read followed blygs…".
- **Check connection keeps its result.** The result stays under the button while the settings it was made with are unchanged (the address, the mount or the keychain entry), with the time; changing one removes it. The toast only says "Connection checked."; the command's longer notice stays up long enough for all its lines. The check now also says what a token without owner:manage or reading:state cannot do (change hoppers, dismiss mentions, ask for new posts, mark posts read), instead of only hoppers.
- **The windows before a write say what will happen.** The question names the kind and the act: "Publish fragment?", "Publish thread?", "Publish update?", "Send private draft?", "Withdraw item?", "Delete Studio draft?", "Compare copies" and "Replace vault note?", and the button repeats it ("Publish fragment", "Publish update", "Withdraw item", "Replace vault note"). The coloured edge on the bar is red only where something goes public: a private draft, deleting a draft and the two windows about the Studio's copy have a neutral one, and none of them says "goes live". A first publication shows the Studio's rendering once (the same words again in green are gone); an update shows the word changes first and the rendering of the whole text behind "As readers will see it". In the windows for withdrawing, deleting a draft, comparing and replacing, Cancel is the plain button and holds the keyboard focus, and the choice that cannot be undone is the red one.
- **When the Studio's copy was changed there**, the window is called "Compare copies" and says what each choice does next: "Replace note from Studio" puts the Studio's text into the note and sends nothing; "Replace Studio copy from note" overwrites the Studio's working copy, and the publish window follows, so nothing goes public until you confirm there. The same words are on the panel's button (it was "Replace this note with the online text"). The notice after a withdrawal starts "Withdrawn · v3".

### Fixed

- **Reader on an iPad (tablet layout).** The list of posts was squeezed into a strip a few pixels high: the reader keeps its last line above Obsidian's floating bottom bar, and the tablet layout has that bar's element in the page but does not draw it, which was read as a bar covering the whole pane. A bar that is not drawn, or does not meet the pane, is now ignored. The phone is unchanged.

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
