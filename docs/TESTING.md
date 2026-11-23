# Testing

Cloud sessions cannot run Obsidian and usually cannot reach the live site or other blygs from the shell. So most
behaviour is proven with fakes in Node, and a short, scripted device walkthrough on the maintainer's iPad closes each
increment.

## Layers

1. **Core unit tests** (Node, no Obsidian): ids (length, alphabet, randomness source injected), `normalizeContentMd`
   (must equal the site's `src/lib/blyg.ts` byte for byte — keep a shared fixture list: input → expected output →
   expected hash), hashing, frontmatter build/parse, route matching, YAML validation rules, directive grammar (inert in
   code spans/blocks, attached blockquote vs detached, `@vN` refused), selection normalisation (§10.2 text-content
   rule), version-bump rule, closure check.
2. **Parity suite** (R1.3–R2): the 13 scenarios of `reference/legacy-macro/test-obsidian-macro.mjs`, re-expressed
   against the plugin's services with the same kinds of fakes (vault, metadata cache, `processFrontMatter`, notices,
   GitHub contents API with sha → 409/422 races, deterministic clock and random). Same inputs, same commits, same
   messages (wording may improve where R2 says so — then the test asserts the new wording deliberately).
   *Convention (R1.3):* each parity test is tagged `[invariant]` (protocol, contract or safety rule — never change the
   assertion) or `[inherited]` (only what the macro did — R2 may change it); assertions on wording carry
   `// R2 changes this`. Withdraw has no legacy tests; its scenarios are in `tests/publish/services.test.ts`.
3. **Service tests** with fakes for later increments: thread resolution and snapshots (R3), resolver and poller with a
   fake HTTP world incl. redirects, 304, 429, identity changes (R4), respond drafts (R5), mentions mapping (R6).
4. **Contract fixtures**: tests write the exact files the plugin would commit into `tests/fixtures/out/` (gitignored; fragments by
   `tests/publish/services.test.ts` "contract fixtures", threads by `tests/publish/threads.test.ts` "contract fixtures for the
   site's own build"). When the site repo is available, **`scripts/site-check.sh [path-to-site-repo]`** copies them into a scratch
   copy of the site and runs the site's own `astro build`, `check-build.mjs` and `test-threads.mjs` over them, in three passes
   (the threads quote the HTML the site really served, taken from the first build; a thread inside a thread; a withdrawn thread).
   That is the end-to-end proof that the site accepts what the plugin writes. Run 2026-10-10: passes (12 notes, 51 pages).
   *Also done once, by hand, 2026-10-10:* the plugin's quote subset (`core/quote.ts`) against the site's real remark pipeline
   (`selectionFromQuote`) on 160,000 generated quotes (random strings over the characters that matter, and a prose-like alphabet):
   no quote the plugin accepts gives a different selection, and every passage the picker writes comes back from the real parser
   unchanged. That run found that a bare web address swallows backslashes in GitHub-flavoured Markdown (fixed, and pinned by a test).
   The generator was a throwaway script; re-create it from `tests/core/thread-core.test.ts` if the quote code changes.
4b. **Reference-client check** *(planned, E3: `docs/plans/E3-studio-test-partner.md`)*: a pinned Blygger Studio started
   locally in the session (`wrangler dev`, throwaway secrets, `ALLOW_PRIVATE_FETCH` for localhost only) subscribes to the site
   build that layer 4 makes and must import every item without flags; and Studio's own published output is snapshotted into
   `tests/fixtures/studio/<version>/` for the reader's tests. Feasibility rehearsed 2026-10-14 (Studio 0.46.1).
4d. **Scale harness** *(HK4)*: `tests/scale/` makes 10,000 invented posts (`src/dev/syntheticPosts.ts`, seeded, placeholder addresses) and times parse, sort and card text against loose budgets; counts the requests of a refresh; replays a 429 with `Retry-After` and a 409 `cursor-expired`; and runs "load older" over the real client against a paging fake Studio (`tests/scale/scaleStudio.ts`). The development build also has the command "Reader: draw synthetic posts (timing)" for timing the drawing on a device.
4c. **Studio client** *(0.3.0, S2)*: `tests/studio/` runs the plugin's real http adapter, client and publish service against an in-memory
   `FakeStudio` that behaves like the real 0.48.2 on the measured points (publish always makes a new version, the cap is checked only at
   publish, the kind is fixed after the first publish, errors are `{"error"}`); `openapi.test.ts` checks the hand-written client against a
   copy of the release's OpenAPI file (checksum-pinned). **Two contracts (E1):** the plugin speaks contract 5 (Studio 0.51.0, file `studio-openapi-0.51.0.json`) and contract 6 (0.69.0, `studio-openapi-0.69.0.json`; no `GET /changes`). `FakeStudio` takes its contract from `contractVersion` and lists `operations` accordingly; `operations.test.ts` runs the client against each file; `contract-compat.test.ts` checks that every operation the client calls differs between the files by additions only; the e2e runs against 0.51.0 (pinned leg) and the newest release. **`tests/e2e/studio.e2e.test.ts`** runs the same service against a REAL Studio and
   is skipped unless `STUDIO_E2E_URL` and `STUDIO_E2E_TOKEN` are set: `scripts/local-studio.sh start` downloads the pinned release
   (digest checked), migrates a fresh local database, starts it with `wrangler dev` on :8787 and prints both variables (about 40 s);
   `MOUNT=/blyg scripts/local-studio.sh start` serves the first Studio under that path (it also prints `STUDIO_E2E_MOUNT`, which the e2e files read; E2); `scripts/local-studio.sh stop <the same DIR as start>` ends it (**without the directory it stops nothing** and the next start talks to the leftover server). **In CI (A1.3)** the `e2e` job of `ci.yml` does the same on every PR against the pinned release (`tests/e2e/studio-pin.env`) and the newest release of `blygger-studio` (the newest leg fails CI while `NEWEST_MUST_PASS=true`).
   **Real Obsidian (A1.4):** `npm run build && node scripts/flavour.mjs blyg && STUDIO_E2E_URL=… STUDIO_E2E_TOKEN=… npm run test:obsidian` loads the built plugin in desktop Obsidian (xvfb, Linux) on the fixture vault `tests/fixtures/vault/` (a Studio-only configuration), opens the panel (desktop and phone layout), sends a draft to the local Studio and checks the note is stamped. Needs playwright-core (`PLAYWRIGHT_CORE=<folder>`); CI job `obsidian-smoke` (required; proven on GitHub's runners). In a cloud session set `NO_PROXY=localhost,127.0.0.1`. Run 2026-10-22: 4 of 4 pass on Studio 0.48.2

   **UI scenarios in real Obsidian (M2 P6, `docs/plans/P6-ui-regression.md`):** `npm run test:obsidian:ui` (same environment as above) runs every file in `tests/e2e/obsidian/scenarios/` in
   its own Obsidian and fresh vault, desktop and then phone layout (Chromium emulation of Obsidian's mobile UI, **not iOS**), against the local Studio; a failing scenario is run once more and
   reported as FLAKY if it passes then. Shared plumbing: `tests/e2e/obsidian/lib.mjs` (windows and notices are read from `activeDocument`, the panel from `document`; the Studio's own editor is
   simulated by its REST API). CI job `obsidian-ui`, **advisory** (continue-on-error) for the first week after 2026-11-07, then required (decision D3). `WITH_REMOTE=1` is set in that job. The same smoke test and scenarios also run in the job `obsidian-ui-newest` against the **newest public Obsidian** (read from `obsidianmd/obsidian-releases` at run time; advisory and staying so: a red leg there says Obsidian changed, not that the change under test is wrong). Measured on GitHub's runners 2026-11-07 before the speed-up: the six scenarios took 3½ minutes, the whole `obsidian-ui` job about 6 minutes (the second local Studio included), well inside its 30-minute limit; after the speed-up (one migration instead of two, no dead waits) about 1¾ minutes and 34 s locally, to be read from the next run. `E2E_TIMING=1` prints the seconds per check. `E2E_DESKTOP_ONLY=1` skips the phone layout
   while debugging; `E2E_DEBUG=1` prints the window texts. **Device steps these scenarios also check** (the steps stay in the walkthroughs, tagged "also checked by CI", decision D5):

   | Scenario | Device steps (T1 = `docs/m1/T1-RESULTS-2026-11-05.md`, RC2 = `docs/m1/RC2-RECHECK.md`) |
   |---|---|
   | `daily` | The Daily (feature `daily`, AI layer off) opens and is not blank, also after a restart with an edition record holding sections and lines; no sideways scroll; a single post shows its content line in bold, "by Author" in italics and no reading time; "Mark read" on a post is one request to a stand-in Studio, shows at once and is not repeated; "Mark story read" is one request per unread post, spaced out; a tap on the preview of a post in an unfolded story opens it, Next and Previous walk that story with "Story: … · 1 of 2", Back returns with the story still unfolded at the same scroll position and the stand-in Studio saw no request for the open, the steps or the Back; nothing is marked by itself; the Feed | Digest switch in both headers, the mode kept in the settings, and switching back and forth asks the Studio for nothing more. Not covered here (unit tests only): sections, the contents, the AI lines (they need the AI layer) |
   | `publish-loop` | T1 F3 Check connection; F4/S1 Send draft, edit, send again; S2/R10 delete the draft; RC2 §1 the Advanced switch keeps its values; RC2 §2 the repost commands only with a GitHub setup |
   | `conflict-pull-withdraw` | T1 S3 overwrite window (both texts, Cancel, agree); S4 a line directly under a partial quote is held back; R8 pull the Studio's copy; R9 withdraw and publish again |
| `hoppers` | S13 device test §1–§6 = T1 R6 (including step 14, the 0.7.0 retest): choose a hopper, send it ("Hoppers: +"), take it out from the note, a removal made in the Studio stands, a wrong name is refused and stays in the property. The "right after typing" step **simulates** the cache lag (the harness freezes Obsidian's cached properties), it does not wait for a real race |
| `quote` | T1 R3 Insert quote by search (the whole item, a passage); R4 a pasted address (an item's own address finds it, an address that is not an item says so); the quote of an item of a blyg you read, listed as "another blyg" in the publish window; the grey button and its hint on a fragment. Needs the second local Studio (`WITH_REMOTE=1`; without it the remote part is left out and says so) |
| `reply` | T1 R5 / S10 device test §1, §2, §4: New reply thread… by a pasted address and by words (also an item of a blyg you read) starts a thread with the quote and `blyg_stub_of`; Make reply marks an existing thread; the panel's Stub row. Needs `WITH_REMOTE=1` for the part about another blyg |
| `startup` | Starting Obsidian with the reader tab open: the app is restarted with 200 saved posts and a stand-in Studio that answers after 6 seconds; the layout must be ready long before that (the old reader waited for the Studio: 6.4 s), only a first screenful (30 of 200 cards) is built and "Show more posts" adds more, and no stall of the main thread over 250 ms follows. Prints the numbers (layout ready, first card, longest stall). The limits are loose on purpose: they catch waiting for the network or building the whole list, not milliseconds. |
| `webquote` | S20 device test (`docs/S20-DEVICE-TEST.md`) steps 2 to 4 on a desktop-sized and a phone-sized layout: the form, Insert grey until quote and address are usable, the block as it will be written (tracking parameter gone, link shortened, no blank line between quote and link), the draft back after Cancel, the block with a blank line either side, a selection taken as the quote, a changed format in the settings followed exactly. Needs no Studio of its own (the harness starts one anyway). Not covered: the iOS app being ended by the system (step 3 of the device test), the Paste button (the clipboard is a device matter) |
| `reader-poc` | S15, the reader pane (experimental), on a desktop-sized and a phone-sized layout: the feed as cards with reading times; the sort and filter choices start closed and open from the header (order including shortest and longest read, blyg, length, font, unread); sorting and filtering by reading time; the font of a post in the text view; the previous / next bar at the foot of an open post (a tap steps, holding Next marks read and steps); buttons in the theme's own shape with padding that scales with their height (on both layouts); the status saying "checked N min ago"; the replies chip with an icon, not an emoji; reading less (opening asks no blyg to be checked; Refresh asks once and reads the list once; the list is saved without Markdown in the plugin's folder and shows at once; a failing Studio is left alone with a status saying when the reader tries again; the clear command);  the text fades as you pull, a short pull shows its label, letting go early does nothing, past the threshold "Marked read" shows and the next post opens); the reading surface (its own ground, plain and blyg quotes, three contrasts); the replies chip of an open post (green "You" for your own reply, a count for replies in blygs you read, the list of cards it opens, what a tap on each does, Back returning); a post with a tag it does not know, a script, a comment or a broken tag is drawn with that left out and a line saying so (nothing requested or run), and the spec's own markup (generated text, a quote's origin and label) is drawn; the source line under a blyg's quote (a post you read opens here, Back returns to the post with the quote, then the list); the large Back; the feed's choices kept in the settings file and in a reader opened afterwards; the list showing itself while it arrives with a counting status; the pane clearing a bottom bar that is measured; mentions drawn with what they say and what they were about, opened like a post, with no read mark or reply for a blyg the Studio does not read; the reader in the sidebar and in a tab at once; the plugin's version at the foot; the header sits outside the scrolling body; a post opened as text (never in a frame), its buttons in the header and its blyg as a link; read marks (a token without `reading:state` is refused and the change put back; a token with it shows the change at once in the card and the header, and it stays after a refresh); Reply; the ribbon entries of the mobile menu; freshness end to end (a post published on the second Studio appears after Refresh, the Refresh button spins and the check ends as soon as the blyg has answered); markup of the kind other blygs write is drawn, and what is refused names its cause. Images and foreign markup in the text view are measured with a request-counting server (nothing requested before a tap, no referrer; each known bypass refused or its attribute dropped). Needs `WITH_REMOTE=1` and port 18999 free. Not covered: iOS, a real mention row from a second Studio (the mention rows are put in by the scenario) |
| `reply-preview` | S15, the reply preview, desktop and phone layout: a reply note's `![[id \| label]]` line shows the text of the item it points at in Live Preview (an item of the owner's, and an item of a blyg the Studio reads) and in Reading view, while the note's text stays as written (the item's words are not in the file); "Edit line" shows the line as written; source mode shows no card; an id nothing knows says so; a directive in fenced code is left alone. Needs `WITH_REMOTE=1` for the held item. Not covered: iOS, an item of a blyg the Studio does not read (unit-tested) |
| `images` | S6: a note embeds a picture from its route folder; the publish window lists it **and shows it from the vault** (decoded, 24x16, not a broken image at the stand-in address the Studio cannot serve before the upload); sending uploads it and the Studio holds the text with the picture's own address and the picture attached; sending again finds nothing to send. Desktop only (the phone layout renders the same window; iOS reading the file and showing it is a device step) |
| `import` | T1 R7 Studio: import new items: the checklist, a draft marked as a draft, the thread's embed shows the fragment's note by name, the notes have nothing to send, the unticked item is not offered again. (T1 S5, more than 100 items, stays a device step) |

   Still the device's own: the on-screen keyboard (T1 R1), iPhone drafts-only (R12), BRAT/token/id takeover (B1–B4, P0), README reading (W1/W2), and everything that depends on WebKit.
   (publish, plugin and Studio compute the same content hash, an unchanged note makes no new version, a change made in the Studio is not overwritten).
   **`WITH_REMOTE=1 scripts/local-studio.sh start`** also starts a second Studio on :8788 (a made-up "blyg you read"), publishes a fragment there and
   subscribes the first to it (about a minute longer); without an imported item the e2e test of remote quotes skips itself. Run 2026-10-23: 8 of 8 pass
   (adds: a thread quoting an own fragment whole, in part and across paragraphs, with `[[Name|text]]` links and a change note on version 2; a passage
   the source does not contain stops the publish; the overwrite window after an edit made in the Studio; remote quotes with labels).
   Run 2026-10-23 after S2.3: **12 of 12** pass (adds: withdraw and bring back, the panel's facts for a withdrawn and a missing item, repost of a fragment and of a
   thread that quotes it, and the bracket-grammar vectors re-measured live). **`tests/studio/grammar.test.ts`** replays Burrow's 49 grammar strings (MIT credit in
   `tests/fixtures/studio/bracket-grammar.json`) against frozen Studio answers, offline. 940 unit tests in all.
5. **Lint guard**: forbid Node built-ins and `electron` in `src/` (mobile), forbid `innerHTML` with non-constant input,
   forbid `fetch` (use `requestUrl` via the platform adapter).
6. **Device walkthrough** (the maintainer, iPad): per increment, written as a numbered checklist in the plan. Always on the
   `preview` channel first, then once on production where the increment touches publishing.

## The `preview` channel

The site repo's `preview` branch deploys to `https://preview.your-site-repo.pages.dev/` with its own blyg identity
(site plan R1.1). The plugin's "Toggle production/preview" command switches `github.useBranch`; the panel shows the
active target in a warning colour when it is preview. Test notes published to preview are throwaway; never publish
test notes to `main`. Resetting preview is a destructive git operation in the site repo and needs the maintainer's yes.

## Installing a build on the iPad

Decided in R1.3 (see that plan). Whatever the path, the walkthrough always starts with: confirm the plugin version shown
in Settings → Community plugins matches the version under test.

## Reading live results

- GitHub Actions logs of the site repo (deploy runs) via `gh run list/view --log` or the GitHub MCP tools.
- The Claude chat's web-fetch tool can read public pages (the sandbox shell cannot).
- The maintainer's phone.
