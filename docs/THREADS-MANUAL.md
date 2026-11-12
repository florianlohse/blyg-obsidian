# Threads — a manual (plugin 0.1.6)

For the maintainer, on the iPad or iPhone. What threads are, how to write one, what the plugin refuses and why. The step-by-step *test*
is `docs/R3-DEVICE-TEST.md`; this is the everyday reference.

## Words used here (the protocol's own)

An **item** is anything you publish. A **fragment** is a short item; a **thread** is a long item that quotes other items. A **blyg** is your whole
publication. **Note** means only a file in your vault. (Decided with the maintainer 2026-10-16: the plugin says fragment, thread and item, not "Blyg note".)

## What a thread is

A **fragment** is a short note (up to 1,000 characters). A **thread** is a longer note that can **quote** your other published
notes. The quotes are copied into the thread when you publish and stay as they were (a *snapshot*), even if the quoted note
changes later. Readers of your blyg see the thread with the quotes inside it, each marked as a quote.

- A **whole quote** copies the whole quoted note.
- A **passage** copies only the words you select.
- A **link** is only a pointer, not a copy: it shows as the first words of the other note, in quotes, and goes to its page.

Threads have no length limit (the plugin only warns above 50,000 characters).

A thread is **one item that grows**: it has its own id, versions and changelog like any note. To continue your own thread, you edit
it and publish again; that is a new version of the same thread (the protocol's own words: "a serial republished for years").

## The side panel's Write buttons

Open the panel (paper-plane icon, or command "Blyg: Open panel"). Under the status line:

| Button | Does | Live when |
|---|---|---|
| **New thread** | a new thread note in your Blyg folder, cursor ready | always |
| **New fragment** | a new fragment in your Blyg folder, cursor ready | always |
| **Quote in thread** | a new thread that starts with a quote of the open note, cursor ready | a Blyg note is open |
| **Continue thread** | puts the cursor at the end of the open thread, after a blank line | a thread is open |
| **Make thread** | turns the open fragment into a thread (property `blyg_kind: thread`); an automatic name "Fragment …" becomes "Thread …" (a name you chose stays) | a fragment that has **never been published** (a published item's kind never changes) |
| **Insert quote** | choose one of your published notes and quote it (whole or a passage) at the cursor | a thread is open |
| **Insert link** | a link to one of your published notes at the cursor | a Blyg note is open |

Outside your Blyg folders the panel shows only the status information and the two New buttons; the buttons that act on a Blyg note appear
only when one is open, and are grayed out (clearly faint) where they do not apply, e.g. Continue thread on a fragment. (The same actions are in the command palette: "Blyg: New
thread", "New fragment", "Insert quote", "Insert link to item", "Make this note a thread".)

### Templates for new items

In **Settings → Blyg → Templates** you can name a note in your vault (e.g. `Templates/Fragment.md`) as the starting point of every new fragment, and
another for every new thread. The template is used **every time** the plugin creates an item: New fragment, New thread, Quote in thread, and the
note that "Moving a selection" (below) creates. What the command adds (the quote, the moved text) comes after the template. Leave a field empty for a
bare note, as before.

- Placeholders (the ones of Obsidian's Templates plugin): `{{title}}` (the new note's name), `{{date}}`, `{{time}}`, and `{{date:YYYY-MM-DD}}`-style formats.
  Anything else, Templater's `<% %>` included, is copied as written.
- A thread template does not need `blyg_kind: thread`; the plugin adds it. A template may not set the other kind, nor any other `blyg_` property
  (Publish writes those; a copied id would turn two notes into one item).
- If the template cannot be used (not found, unreadable, or one of the problems above), **no note is created** and a notice says why. Clear the field to
  get bare notes back.
- Keep the template notes outside your publish folders, or the template itself can be published (Settings warns).

### Moving a selection into a new item

Select text in any note, then tap **New fragment** or **New thread** (panel or palette). The selected text is **moved** into the new item, and
an embed of it, `![[New item name]]`, stands in its place. You stay where you are; Obsidian's undo brings the text back. A thread that embeds
the new item can only be published after the new item is (Publish tells you).

It works from a **thread** and from any note **outside your publish folders**. It is refused from an **essay or page** (they are copied to the site as
they are, so the embed would show as plain text and break the deploy) and from a **fragment** (a fragment cannot quote). If the moved text is longer
than a fragment may be (1,000 characters), you are told; open the new item and tap **Make thread**.

*Make thread* (panel button, or "Make this note a thread" in the palette) turns a note you have **not** published yet into a thread. Once a note is published, its kind
can never change; that is a protocol rule and the plugin refuses to bend it.

## How quotes look in your notes

In your vault a quote is an ordinary Obsidian embed with the **name of the quoted note**: `![[My note about time]]`. Obsidian shows
the quoted note right there, in the editor and in Reading view, and keeps the link when you rename the note. When you publish, the
plugin turns the name into the note's id for the site; your vault note keeps the names. A link is the same idea: `[[My note about time]]`
becomes a link to its page.

- For a **passage**, the line `![[Name]]` is followed by lines starting with `>`: that is the selected text. In Obsidian you will see the
  whole embedded note and then the passage under it (known quirk: Obsidian shows the whole note for any embed).
- **A quoted note must be published first.** If it isn't, Publish refuses and names it ("“Draft” is not published yet").
- What the vault shows is the quoted note's **current** text; what is published is the version **published** at the time. If you edited
  a quoted note and did not publish it, the thread still publishes the older version.

## Quoting your own notes

1. Open a thread. Put the cursor where the quote should go.
2. Panel → **Insert quote** → choose one of your published notes (newest first; the list shows the first words).
3. A window shows that note's text as readers see it. Either tap **Quote the selection** (first press and hold in the text and drag the
   handles over the passage) or **Quote the whole item**.

Things to know:

- **Do not retype a passage.** The site shows quotation marks and apostrophes as curly characters (“ ’). A passage you type with straight
  ones (" ') does not match, and the plugin refuses it. The window copies the exact characters, so use it.
- A passage can be several paragraphs; they stay separate paragraphs.
- The `>` lines are plain text. If you add Markdown inside them (`*emphasis*`, links, lists), the plugin refuses with the reason. Emphasis
  in the *source* does not matter: a passage is always copied as plain text.
- The same note can be quoted twice. A thread can quote another thread (it nests), but not one that quotes it back.
- Only notes that are **already published** can be quoted. Not drafts, not withdrawn notes.

## Linking

Panel → **Insert link**. When you publish, the link is stored with its label (the first ~60 characters of the other note in “quotes”)
and that label is frozen: it does not change if the other note is edited. Your essay links, `[[Essay name]]`, work as before: only a link
to a **Blyg note** is an item link.

## Publishing

Before you tap Publish, the **panel already tells you** what the plugin would refuse, in one line: an empty note, a fragment over its limit ("Too long for
a fragment: 1,254 characters, the limit is 1,000. Shorten it, or make it a thread."), links the site cannot honour, an embed the site cannot show, a
quoted item that is not published yet, a fragment that quotes. Publish is then switched off until it is fixed.

Panel → **Publish** (or **Update**). The window lists *Quotes in this thread* (whole or passage, which note, which version, new / moved /
unchanged) and *Links to other items*, then the text changes. **Commit** writes it. The panel then watches the deploy.

**When a quoted note changes:** the thread keeps the old copy until you tap **Update**. Then the window says "moves from v1 to v2",
the new copy is taken, and the thread gets a new version even if you did not touch its own text. The panel does not tell you in
advance that a quoted note has a newer version (judgment: it would need a network read on every panel refresh).

**Update with nothing changed** says "No changes" and does not contact the site.

## Withdrawing

Panel → **Withdraw**. The thread's text and quotes are emptied; its address stays up as "withdrawn" forever, and so does its id. The note
in your vault keeps its text. Publishing again brings it back as a new version.

## When the plugin says no

| It says | Meaning | What to do |
|---|---|---|
| "“X” is not published yet" | you quote or link a note that has no id yet | publish X first |
| "no published item … on main" | the id is not one of your published notes on that branch | publish it there first, or remove the line |
| "… is withdrawn" | you withdrew that note | take the quote or link out |
| "is an essay or a page" | only Blyg notes can be quoted | remove it |
| "the site shows notes as plain text … an embed" | an `![[…]]` that is not a whole line quoting a published Blyg note: inline in a sentence, an image, a stray bracket or backtick next to it (the site would show literal brackets and refuse to deploy it) | remove it or put it on its own line; an image is not a quote: to publish a picture, embed it in a note of a Studio route, from that route's folder (older GitHub-hosted routes cannot publish images) |
| "embeds a heading, a block or a size" | `![[Note#Heading]]` etc. | embed the whole note, or use Insert quote |
| "committed but the site does not serve it yet" / "still serves v1" | the quoted note's newest version is not deployed | wait a minute or two, publish again |
| "the quoted passage is not in …" (+ curly-quote hint) | the words are not in that version of the note | use **Insert quote** again |
| "this passage cannot be published as written" | Markdown inside a quote | delete the `>` lines, insert the passage again |
| "a code block" / "indented" / "a backtick" | the plugin cannot be sure whether a quote is inside code | take the code out, or move the quote to its own paragraph |
| "only a thread can do" | a fragment contains a quote line | make it a thread before the first publish, or remove the line |
| "would quote itself through …" | thread A quotes B which quotes A | remove one of them |
| "already published as a fragment/thread" | the kind of a published note cannot change | start a new note |

All of these are checked **before** anything is written; a refusal never leaves a half-published thread.

## Quoting other people's threads (and other blygs)

**Not possible yet.** Right now a thread can only quote *your own* published notes. This is by design in the protocol: you may quote only
what you have already read ("quoting follows reading"), so quoting someone else needs the plugin to read their blyg first. That is planned
in two steps (`docs/plans/R4-reader.md`, `docs/plans/R5-respond.md`; nothing of it is built):

1. **R4, the reader:** subscribe to other blygs and read their items inside Obsidian (kept in the plugin's own storage, never in your vault).
2. **R5, respond:** from an item in the reader, one tap starts a thread that quotes it (whole or a selected passage), or links to it.
   Publishing freezes their words into your thread, with their address and version, and the site tells their blyg about the response.

If the author later withdraws a quoted item, you must remove the quote before you can republish (the protocol's rule, unless you quote a
*pinned* version), and a response that quotes without any words of your own will be blocked (your decision of 2026-10-06). Until then, the
nearest thing is an ordinary web link to their page in your text.

## Where things live

The thread's file in the site repo is `src/content/notes/<id>.md`: your text (with ids in place of names) plus the frozen quotes and links
in its properties. Its page is `/blyg/t/<id>/`. Your vault note holds only your text and the id/version stamps, not the copies.
