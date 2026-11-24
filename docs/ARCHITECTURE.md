# Architecture

Status: **design, not yet built** (2026-10-06). Each section names the increment that builds it. Decisions marked
*(Claude's proposal)* can be changed by the implementing session if it finds a better option; say so in the ledger.
Decisions marked *(the maintainer)* are fixed.

## 1. Shape

```
src/
  main.ts                 Plugin entry: settings load/migrate, commands, views, ribbon; wires adapters to services
  settings/               Settings schema, defaults, migration, settings tab (incl. SecretComponent row)
  platform/               Thin adapters over Obsidian: vault I/O, frontmatter, notices, requestUrl, keychain, clock, random
  core/                   PURE (no obsidian import): textContent (the §10.2 normaliser), thread (directive/link grammar), quote
                          (attached quotes as plain text), sources (snapshots as YAML, bump rule, closure),
                          ids, hashing, normalisation, frontmatter build/parse helpers,
                          route matching, validation, directives grammar, selection normalisation, snapshot rules,
                          version-bump rules, diffs. Unit-tested in Node.
  github/                 GitHub contents client (get file, put file with sha, list dir, get commit status/runs)
  studio/                 (0.3.0, ADR-002) Blygger Studio's owner API: address, http adapter (the only place the Studio token is used),
                          typed client over requestUrl, token expiry/scopes read from the JWT, version range, note record
                          (`blyg_origin`/`blyg_sent`/`blyg_previous`), pending-draft record, connection check;
                          text.ts (names → ids, bracket grammar of spec 0.4 §10.1, the local checks, shared by publish and panel),
                          picker.ts + passage.ts (the quote picker's rows and the text to choose a passage from),
                          live.ts (what the panel asks the Studio: item facts, mentions, warnings, and the cache)
  publish/                Publish services: blyg (fragment/thread), plain, withdraw, pin (R7). Use core + github + platform.
                          items.ts (R3): resolves the ids a note quotes/links to, builds the frozen sources and links
  reader/                 R4: resolver (§12.1), poller (§12.3), import store (plugin storage), read state
  respond/                R5: stub/quote/link actions → drafts in the publish folder
  mentions/               R6: read data/mentions.json, map to local items
  ui/                     Panel view (active-note status + actions), publish preview modal, picker modals,
                          reader view, mentions view
tests/                    Node tests: core units, parity suite, service tests with fakes
```

Rule: **`core/` never imports `obsidian`**; services receive adapters (ports) so tests run in Node with fakes, the
same way the legacy macro tests fake Obsidian and GitHub. *(Claude's proposal)*

## 2. Settings schema *(the maintainer: everything setup-specific is a setting)*

```ts
interface BlygSettings {
  schemaVersion: 2;           // 2 = 0.3.0 (route mode "studio", the `studio` block); an older plugin then stays read-only
  github: {
    owner: string;            // "your-github-name"
    repo: string;             // "your-site-repo"
    branch: string;           // "main"   — production
    previewBranch: string;    // "preview" — test channel (R1.1 in the site repo)
    useBranch: "production" | "preview";   // what publishing targets right now; shown prominently in the UI
    tokenSecretName: string;  // NAME of the keychain entry, e.g. "obsidian-blyg-github"; never the token
  };
  blyg: {
    origin: string;           // "https://example.com/blyg/"  (identity for production)
    previewOrigin: string;    // "https://preview.your-site-repo.pages.dev/blyg/"
    itemsDir: string;         // "src/content/notes"
    fragmentCharCap: number;  // 1000
    threadSoftCap: number;    // 50000 (warn only)
    author?: { name: string; url?: string };  // passed through into snapshots/citations where the contract asks
  };
  studio: {                   // 0.3.0: the Studio that routes of mode "studio" publish to (ADR-002); any Studio
    baseUrl: string;          // "https://blyg.example.com" — host only; the owner API is {host}{mount}/api (Studio 0.65.0 removed the host-root alias of a mounted Studio)
    mount: string;            // "" (own host) or "/blyg"; public pages are {host}{mount}/f/{id}/, the API {host}{mount}/api
    tokenSecretName: string;  // NAME of the keychain entry holding the REST token; never the token. The token's expiry and permissions are read from the token itself
  };
  routes: Array<{
    vaultPrefix: string;      // "website/blyg/"
    mode: "blyg" | "plain" | "studio";   // blyg = items committed to the site repo (today); studio = items published through the Studio
    dest?: string;            // plain only: "src/content/essays/"
    label: string;            // "Blyg note", "essay", "page"
    requireTitle?: boolean;   // plain only
    draftsOnly?: boolean;     // studio only (schema 3, 0.4.0): notes here are sent as drafts, never published, reposted or withdrawn (docs/plans/S12-studio-per-route.md)
    webUrl?: string;          // plain only: where the site shows a file, "{site}/essays/{slug}/"; empty = no "Open on web" (src/core/webAddress.ts)
  }>;
  attachments: { repoDir: string };          // "public/attachments" (for the missing-image warning)
  reader: {                                  // R4
    cacheDir: string;         // default "{plugin dir}/cache/" — plugin storage, NOT a vault folder (the maintainer, 2026-10-06)
    sourcesStore: "vault" | "repo";          // The maintainer: "repo" → data/blyg-sources.json (contract §5)
    sourcesVaultPath: string; // "Blyg Reader/sources.json" when sourcesStore = "vault"
    sourcesRepoPath: string;  // "data/blyg-sources.json"
    pollMinutes: number;      // 60; never tightened on failure (§12.3)
    userAgent: string;        // "blyg/{version}"
  };
  templates: { fragment: string; thread: string };  // vault paths of the notes new fragments / threads start from; "" = bare note
  respond: { draftsPrefix: string };         // R5: where new stubs/threads are created, must be a blyg route
  mentions: { repoPath: string };            // R6: "data/mentions.json"
}
```

Defaults are **generic placeholders** (empty owner/repo, `blyg/` as the only route), never the maintainer's values. The maintainer's
values live in his vault's `data.json`, which is never committed. A settings migration function runs on load
(`schemaVersion`). The settings tab validates: route prefixes end with `/`, no two routes overlap, origins end with `/`.

**Published records, the `published` key of `data.json`** (not a setting, not committed): for plain routes the plugin records, per
branch and repo path, the fingerprint of the text it last saw on the branch (`src/app/publishedStore.ts`). The side panel compares it
with the note's text now to say published / changed / not known. Paths and fingerprints only, never text or token. **Why `data.json`
and not a file of its own:** measured 2026-10-09 on an iPhone and an iPad, Obsidian Sync carries a plugin's standard files (`data.json`,
`main.js`, `manifest.json`, `styles.css`) but **not** other files in the plugin folder (a `published.json` and probe files of three
types never arrived). Every change to `data.json` goes through `src/app/dataUpdater.ts` (one at a time, read fresh from disk, written
back whole), so a long-lived in-memory settings object cannot erase records that Sync brought in, and a record write cannot erase
settings. Until 0.0.19 the records lived in `published.json`; startup folds that file in (newer record wins) and deletes it.

## 3. Secrets *(the maintainer: QuickAdd's pattern)*

Settings hold `tokenSecretName`; the settings tab shows a `SecretComponent` so the maintainer picks or creates the keychain
entry (Obsidian Settings → Keychain). At use: `app.secretStorage.getSecret(name)`. Missing → a notice that opens
settings; never fall back to a plaintext field. Details and the public-release checklist: `docs/SECURITY.md`.

## 4. Publish flows

All flows: resolve route → validate locally (no network) → read remote state → decide (no-op, create, update) →
show preview when something will change (R2) → write → **only then** stamp the local note → report honestly:
"Committed to {branch} — the site deploys after its checks pass" plus a link to the Actions run (R2).

- **Fragment (blyg route, kind fragment)** — R2: identical to `reference/legacy-macro/quickadd-publish.js` (`publishNew`,
  `republish`): mint id (128 bits, Crockford base32, `crypto.getRandomValues`), normalise body, hash, cap check,
  compare with the committed `blyg_hash`, bump version + changelog, PUT with sha, then `processFrontMatter`.
- **Studio item (route mode `studio`, 0.3.0; fragment or thread)** — `publish/studio.ts`: strip frontmatter and `%%` comments, normalise →
  `studio/text.ts` `prepareStudioText`: **single line breaks kept as hard breaks** (`keepLineBreaks`: two plain paragraph lines get two trailing spaces in the text sent; code, lists, quotes, tables, headings and directives untouched; the vault note is not changed), **names → ids** (`![[Note]]`, `[[Note]]`, `[[Note|text]]` of notes published in THIS Studio; ids and `id | label` pass
  through), the fragment cap (threads have none), quotes only in threads, stray embeds and unresolvable `[[links]]` refused (all before any request) → read the
  item if the note has a record of this Studio (id **and** `blyg_origin`) → no-op decided by the plugin (Studio makes a new version of an unchanged item) →
  `POST /api/preview` (the Studio's own problems refuse; for a thread it lists what each quote resolved to) → **if the working copy was edited in the Studio since the
  note last sent: the overwrite window (diff, "Overwrite that copy")** → the write window (Studio's rendering through the sanitiser, optional change note for an update;
  **nothing has been written to the Studio yet**) → create or update the working copy → publish → only then stamp the note (`blyg_origin`, `blyg_id`, `blyg_version`,
  `blyg_url`, `blyg_kind` for threads, `blyg_sent` = hash of the text as sent). A draft created before a publish that then fails is remembered in `data.json`
  (`studioDrafts`, by note path) so the retry finishes it instead of making a second item.
- **Images in a Studio item (S6)** — `core/images.ts` (pure: finds `![[img|alt]]` and `![alt](path)` outside code; `|300` is a size and is ignored; web addresses and notes are not
  images) and `studio/media.ts` `resolveImages` (looks each file up with `VaultPort.resolveLink`, **refuses one outside the note's route folder before reading it** (`folder` = the route's `vaultPrefix`), checks type and 5 MB, reads it through `BinaryVaultPort`, digests it). The
  Studio's upload address contains the file's SHA-256 (`…/media/<id>/<sha256>.<ext>`), so **both sides are hashed in one canonical form**, `![alt](blyg-media:<sha256>)`: the
  note's embeds are written so before `prepareStudioText`, and every hash of the Studio's copy goes through `studioTextHash` (`canonicalizeStudioMedia` first). That keeps "no
  changes", "edited in the Studio" and the panel's "in sync" meaning what they meant without asking the Studio anything. In the write order, after the window and after the
  item exists (a new item is created with the canonical text first): each image is re-read and re-checked against its digest, then `POST /api/media` (multipart,
  `inline=true`, `itemId`, `expectedRevision`: **attached to the item**, which is what makes the published version retain it; an unattached upload is accepted but not retained), each
  answer carrying the next revision (a duplicate keeps it); then the text with the Studio's addresses (`withStudioAddresses`) is sent, then publish. The preview call gets
  stand-in addresses on the Studio's own host, since the real ones do not exist before the upload. Behaviour measured on Studio 0.58.0 (types png, jpeg, gif, webp, svg; 5 MB).
  Studio routes only: GitHub and plain routes still refuse an image embed. Not covered yet: sizes (`|300`), turning a pulled or imported item's images back into vault embeds.
- **Studio withdraw** — `publish/studioWithdraw.ts`: read → window (optional note) → `POST …/withdraw` → mark the note (`blyg_version`, `blyg_withdrawn`).
- **Repost to Studio** — the same flow with the old record treated as none; after the publish, the old `blyg_*` record moves into `blyg_previous` in the stamp. The window offers the change note on this first version, pre-filled with where and when the item was first published (S2.5).
- **Use the Studio's copy** (S2.7, 0.3.2) — `publish/studioPull.ts`: read the item → window (both texts; also reachable as the third choice of the overwrite window) → replace the note's text (`NoteEditPort.replaceBody`, atomic, refuses if the note changed meanwhile) → mark the note (`blyg_sent` = hash of the Studio's copy). Nothing is sent to the Studio. The Studio's ids go back to note names with `namesFromIds` (`studio/text.ts`), the inverse of `translateStudioNames`: a name is used only when exactly one note of this Studio holds the id, is not withdrawn, and resolves back to the same id; otherwise the id stays.
- **Quote picker (Studio folders)** — `ui/StudioPicker.ts` over `studio/picker.ts`: the vault's notes of this Studio first (written by name), then `GET /api/search`
  (own items without a note here, and items of the blygs you read, written `id | label`); passages from `GET /api/items/{id}` (published HTML) or
  `GET /api/imports/{sub}/{id}`.
- **Panel for a Studio note** — `app/panelState.ts` from the note's record at once; `studio/live.ts` facts (item state, working-copy hash, mentions, warnings)
  arrive in the background through a cache in `main.ts` and redraw the panel. `loadPanelState` itself never touches the network.
- **Plain route** — R2: identical to `publishPlain`, plus the whitespace-only no-op rule.
- **Withdraw (GitHub blyg)** — R2: identical to `quickadd-withdraw.js`; separate command with a confirmation (never one tap away).
- **Thread** — R3: as fragment, plus: parse directives (`core/directives`), resolve each against (a) own published
  items (read from the repo: committed file → version; snapshot html from the **deployed** item doc at
  `{origin}items/{id}.json` fetched with `requestUrl`), or (b) the reader cache (R4); verify partial selections;
  closure check; build `blyg_sources`/`blyg_links`; version-bump rule from the contract §3.3.
- **Pin** — R7.

GitHub writes are one file per commit (contents API). A two-file operation (R7 pin) writes in the order that keeps
`main` valid if the second write fails.

## 5. Reader (R4)

- Subscribe = spec §12.1 resolution, bounded to 6 fetches, identity = final fetch origin; an identity change is never
  adopted silently.
- Poll = per source, conditional GET of `blyg.json`/`items/index.json` (or the feed), honour 304/429/`Retry-After`,
  exponential back-off on failure, never tighten the interval on failure, identifying User-Agent.
- Import store = one JSON file per item in plugin storage (`reader.cacheDir/{host}/{id}.json`): the item document
  verbatim (needed unchanged for snapshots) plus a small `_meta` object. **No vault notes** — strangers' text never
  enters the vault (the maintainer, 2026-10-06). Withdrawn items roll up to an endcap record (§13.4), never deleted silently.
  The cache is disposable (re-poll rebuilds it).
- Read state and per-source ETags in the plugin's own data (`saveData`), not in the vault notes.
- Views: a stream (newest first; fragments in full, threads collapsed with "Read more"; an "edited" marker when a read
  item's version rose) and per-item actions (R5).

### 5.1 The reader through the Studio's API (S15): keeping up with the Studio

The reader in the plugin (`src/ui/Reader*.ts`) reads the posts the owner's Studio holds (`GET /api/reading/imported`), not the blygs themselves. How it keeps up is
**modelled on Burrow** (`aneeshsathe/blygger-desktop`, release 0.21, "Sync reads less from the blyg"; credit and thanks in the README) and was checked against
measurements (the maintainer's notes, "refresh scaling investigation", 2026-11-15):

- The Studio has no "changed since" read of the list and moves its `reading` change counter once per imported post and once per read mark. So: **counters first**
  (`GET /api/changes`, every 1.5 s during a Refresh and not otherwise: there is no watcher while the reader or a post is open, DG6), and
  a check reads the list **once at the end**, not on every counter move (`ReaderView.checkForNew`). The list is read when the reader opens and when the person presses Refresh.
- **Contract 6 has no `GET /changes`** (removed in Studio 0.67.0; 5.14 to 6.2 otherwise only adds). The reader does not decide that from the version: it reads
  `operations` in `GET /capabilities` (`src/studio/capabilities.ts`, `OPERATION.changes` = `getChanges`; verified on a real 0.51.0, which lists it, and a real
  0.69.0, which does not). Where it is listed nothing changes. Where it is not, `client.changes()` answers `ok` with `null` and `ReaderService.changeMarks`
  makes marks of its own (`src/app/readerFreshness.ts`, same shape, epoch `re-read`): `reading` moves once per 60 s (`CHECK_PAUSE_MS`), so a Refresh sees it move; `subscriptions` counts the blygs whose `lastPollAt` (in `GET /subscriptions`) moved since Refresh
  asked, read only while a check runs (35 s window). Not used: a conditional `GET` (`If-None-Match`, bodyless 304; the Studio supports it since 0.65.0),
  because whether iOS's `requestUrl` passes the header and a 304 through is not known from a cloud session; it is a device step (E1 PR) and the better
  replacement once checked. The Studio's API budget (1200 reads and 120 writes a minute, delegated tokens 600 and 60) is far above this: a Refresh reads
  the subscriptions about 24 times.
- Pages of 100 (the API's maximum). A walk stops where it reaches what is held (the list is newest first; `readerSync.reachedKnown`) and the new rows are merged in
  (`mergeFresh`); a full read of the window comes at the start, at least once a minute when only read marks seem to have moved, and as a ten-minute safety net while
  anything moved (`chooseWalk`). The mentions are read with the full walks and when their tab opens.
- Asking the Studio to fetch the blygs (`POST /api/subscriptions/poll`) happens only when the person presses Refresh (the Studio fetches them itself every half hour).
- 5xx and 429 answers back the reader off: 30 s doubling to 30 min (`backoffDelay`), a status line says when it will try again, Refresh asks now.
- **The first read is the newest 200 posts** (2 pages of 100). **"Load older posts"** (HK4, `app/readerOlder.ts`) reads further on demand, 200 at a time. The Studio has no
  "older than" parameter, only a cursor that continues a walk and dies when the list changes (409), so the service keeps where the last walk ended: a press costs 2
  requests; when the cursor is dead, or a Refresh made the newest window the last walk, the list is read again from the top down to the depth held and on from there.
  The reader holds at most 5000 posts (`OLDER_MAX`, a judgment call about memory on a phone) and says so; those older than the newest window survive a whole read
  (`keepOlderTail`). **Policy: older posts live in memory only**; the saved copy below stays the newest 200, so the file does not grow and strangers' text is not stored
  in more places. They are kept without Markdown, as the saved copy is.
- **The feed is a window** (`ui/readerWindow.ts`): at most 120 cards are in the page; cards are added below (and above, scrolling back) as you scroll, and the ones
  that left are replaced by a spacer of their measured height, so drawing cost does not grow with the list and the place on the screen stays. The index arithmetic is
  unit-tested; the scroll behaviour was checked in a browser with 5000 rows (no drift in either direction) and is to be checked on a device.
- A saved copy of the window (`reader-cache.json` in the plugin's folder, `readerCache.ts`): strangers' text stays out of the vault's notes; the file is per Studio,
  two weeks old at most, without Markdown, and every field is checked when read back.

## 6. Respond (R5)

Actions create a **draft note** in `respond.draftsPrefix` and open it; nothing is published until the maintainer taps
publish:
- **Stub** → new thread note with `blyg_kind: thread`, `blyg_stub_of` {origin, id, version, cited{…, retrieved}}, body
  starting with `![[id]]` (or the partial-quote form when text is selected in the reader view).
- **Quote into thread** → inserts the directive into the active thread note (or a picker of thread notes).
- **Link** → inserts `[[id]]`.
Remote sources resolve only from the reader cache (quoting follows reading).

## 7. Mentions (R6)

Read `data/mentions.json` from the repo (contract §5), group by target item, show in the panel for the active note and
in a mentions view; open the source page in the browser. No sending or receiving in the plugin.

## 8. UI surfaces

- Commands (all usable from the mobile toolbar): Publish active note · Withdraw active note · Toggle production/preview
  · Open Blyg panel · Open reader · Refresh reader · Subscribe… · Open mentions.
- **Panel** (right sidebar view) following the active note: route and kind, publish state (never published / in sync
  / local changes / withdrawn), id + version, target branch (preview shown in a warning colour), last deploy status,
  mentions count (R6), buttons.
- **Preview modal** before a write that changes something: rendered body, word diff against the committed version
  (blyg-publisher `src/diff.ts` is a model), what will be committed where.

## 9. Errors and honesty

Every failure path says what happened and whether anything changed: "Nothing committed — safe to retry", "Committed
v3 but the local note could not be updated — fix it by hand before republishing" (as the macro does). 409/422 →
"another device published first; re-run". Never claim "live" before the deploy succeeded.

## 10. Build and release *(decided in R1.3)*

esbuild bundle to `main.js` (CommonJS, `obsidian` external), `manifest.json`, `styles.css`. GitHub Actions: lint, test,
build on push; on tag `x.y.z`, a release with the three files attached. Install path on iOS: see
`docs/plans/R1.3-scaffold.md` (open decision).

## Daily digest, AI layer

The digest is a newspaper page per **edition** (`digest/edition.ts`). The setting `digest.time` ("Digest time", device clock, default 07:00, behind the feature `daily`) sets the cutoff; an edition is made at the first open of the reader or the Daily after a cutoff, its id is the cutoff's timestamp, it covers the posts from 24 hours before the cutoff until now and keeps growing until the next cutoff (the next occurrence of the time after the edition was made, never on the edition's own day, so changing the setting moves only the next cutoff). Within an edition the stories are stable (`digest/stable.ts`): the first read groups the window by the ordinary rules, afterwards a new post joins the story it answers/quotes-with or resembles (tf-idf), else the Mixed bag; only two new posts that match each other form a new story. Records (edition id, story ids with post ids, section name per story, Mixed bag, first-seen time per post, the post set and cache key of each story's text) live in plugin storage (`digest-editions.json`, ids only, last 14 editions; `digest/editionHost.ts`). A story with posts newer than its text shows "+N new posts"; "Write the digest" re-summarises only those (cache key: story id + post set + prompt version + model) and asks the sections pass again only when the headline set changed. Posts already read are dimmed. `digest/window.ts` is now only the masthead date. The page is reached from the reader's Sort & filter (Feed / Digest, `ui/readerExtras.ts`), the command "Open Daily" or the ribbon icon. Entries open in the reader in the same leaf; the reader's Back returns to the digest (`ReturnPoint`). `digest/layout.ts` holds the honest "not grouped" line, the "Other posts" list, previews and the grouping note.

`src/digest/llm.ts` builds the Messages-API requests for the Daily's front page (all groups, in batches of at most 8 groups and `MAX_REQUEST_CHARS`), behind the settings `digest.*` (off by default; key by keychain entry name; `dailyTokenCeiling`). Consent: switching `digest.useAi` on asks once (`ui/DigestModals.ts`, via `digest/consentGate.ts`); the record (host, model, time) lives in `digest-ai.json`, and `writeDigest` refuses to send without a record for the endpoint's host (a new host asks again). A manual run first shows one line from `estimateRun` (groups, posts, requests, tokens, rough cost; prices in `digest/prices.ts`, dated, source named). Results are cached in `digest-ai.json` in the plugin folder, keyed by (cluster hash, prompt version, model), together with a trail (time, model, host, post ids, sizes, tokens, cost) and the per-local-day token tally (`digest/budget.ts`; `wouldExceedCeiling` is for the automatic run, the manual run is never blocked). Failures leave the deterministic digest as it is. The sections pass (`src/digest/sections.ts`: prompts, request text, strict reading; `sectionPass.ts`: batching and the incremental update; `sectionRecord.ts`: what the edition record keeps) belongs to the same run (same consent, same confirm line, which then says "plus N sections requests" and how many single posts go along). With 4 or more items (stories plus single posts) it sends the finished headlines and summaries and, for every SINGLE post, only its author and about 300 characters of its own words (never a whole body; no post id leaves the device, the numbers are positions), and reads back 3 to 7 named sections holding story numbers and single-post numbers, validated strictly (unknown or duplicate ids dropped, a forgotten item goes to "Other", names plain and at most 24 characters). Single posts get no AI text. A full request holds every story and as many single posts as fit `SECTIONS_MAX_REQUEST_CHARS`; the rest follow in further requests that name the sections so far (at most `SECTIONS_MAX_REQUESTS`; what does not fit stays in the Mixed bag). The first write of an edition, a write with no sections yet, and "Re-sort sections" run the full pass; later writes send only the NEW items with the EXISTING section names (an item goes to an existing section, to Other, or to a new section only while there is room), and items already placed never move. The result is kept in the edition record as names and ids only (`StoryRec.section`, `postSections`, `sections`); a post in the Mixed bag with no entry has no section. The full pass is cached in `digest-ai.json` by a hash of the headline set + the single-post ids + prompt version + model; any error shows the plain front page (or, for a later write, the sections as they were) with a short note. Request bodies are kept for the last three runs. The caps are generous on purpose (`MAX_POSTS_PER_CLUSTER`, `MAX_POST_CHARS`, `MAX_REQUEST_CHARS` in `llm.ts`; the default daily token ceiling is 2,000,000).

**Automatic write and history (DG4b).** The setting `digest.autoWrite` ("Write the digest automatically", default off, under Daily digest, feature `digest-ai`) makes the digest write itself ONCE per edition: when the Daily opens, `autoWrite.ts` `autoDue` is true only with the AI layer on, the setting on, consent recorded for the endpoint's host, at least one story, and no text yet; `Editions.claimAuto` then marks the edition (`EditionRec.auto`, saved before the run) so there is never a second attempt, not after a failure either (a failure or a refusal leaves a small note in `auto.note` and the manual button stays). The run is the ordinary `writeDigest` with `confirm: false`, an `askConsent` that always says no (an automatic run never asks, so without a consent record nothing is sent), and a `gate` that enforces the daily token ceiling against the day's tally and the run's estimate (`ceilingRefusal`; the manual run is never gated). Later updates of the same edition stay manual. No catch-up for editions missed while the app was closed. The runs' tokens and rough cost are summed in `EditionRec.usage` and shown in the digest footer ("about N tokens, under 1 cent"). `digest/history.ts` keeps the last 14 written editions in `digest-history.json` (plugin storage): headlines, summaries, section names, post ids per story and the author's name per post, no post body and no key; a size cap (`HISTORY_MAX_CHARS`) drops the oldest editions and sets a plain note. The masthead's day switcher (`ui/DigestPast.ts`: arrows and a list of dates, today's first) shows a past edition read-only; a post still in the reader's list opens in the reader, any other is a plain row marked "no longer in the reader's list".

**Editors (DG7).** `digest/editors.ts` holds an authored, versioned cast (`EDITORS`, `EDITORS_VERSION`): an id, a name, a picker blurb and a style paragraph of at most 400 characters (plain text; a lint-style test over the shipped list). The setting `digest.editor` ("neutral" default, an editor id or "rota"; row only while the AI layer is on, `settings/editorRow.ts`) is resolved per edition (`digest/editorRun.ts`): the editor that wrote an edition is kept in `EditionRec.editor` (and in the history record), a record without it is neutral, the setting applies to the next edition or to the manual "Re-sort sections". The voice applies to story headlines and summaries only: `llm.ts` appends `voiceLine(editor)` to the story system prompt AFTER the data rules (it says it sets voice only); the sections and backfill requests carry none. The story cache key adds the editor id and `EDITORS_VERSION` (neutral keeps the plain key). The masthead line "Today's editor: <name>" (`ui/digestEditorLine.ts`, text only) shows when the edition has a known editor; a past edition shows "Editor: <name>".

**Digest v2 (DG6).** *Order* (`digest/order.ts`, one rule, also in the page's "How this is grouped"): the lead block ("Top stories") and the plain page by size then newest post; inside a section stories by their newest post and single posts newest first; sections by their newest item, Other last (`groupOf` sorts, the record's order is only the order stories were made in). *Back* returns to the same scroll position, kept per edition in module memory (`digest/scrollMemory.ts`; the view is made again each time). *Summary*: the text under a headline does what the headline does. *Chip*: the reader's metadata line shows "In the digest: <section>" (`ui/readerDigestChip.ts`, `digest/postSection.ts`: current record, then history) and a tap opens that edition at the section (`requestJump`). *Bylines and lines*: the sections request (prompt version 3) also reads `about` (plain, at most 90 characters) per section and `{"id","line"}` per single post (`"<Author> on <topic>"`, at most 80 characters, no quotes, the author must be the one sent, else the plain first sentence shows); kept as `EditionRec.sectionAbout` / `postLines` and in the history (`PastSection.about`, `PastEdition.lines`); later writes send only new single posts and keep every old line. *Reading time* per single post: words over 200, at least 1 minute (`digest/readTime.ts`, no AI). *Table of contents* (`ui/DigestToc.ts`): under the masthead, collapsed above 8 sections, also for past editions. *No sideways scroll*: the page wraps long unbroken text (`overflow-wrap: anywhere`, `min-width: 0` on flex children) and `overflow-x: hidden`. The reader no longer polls: the 30-second watcher is gone; the list is read on open and on Refresh.

**Sections, robust (DG6b).** A sections request is bounded by its expected ANSWER too: at most `SECTIONS_MAX_SINGLES` (40) single posts and `SECTIONS_MAX_ITEMS` (50) items per request (`sectionPass.ts` `planSteps`), `SECTIONS_MAX_TOKENS` is 8192. The provider's `stop_reason` is read: `max_tokens` is a `CutOffError`; a cut-off or unreadable batch is retried ONCE in halves, a batch that still fails is skipped (its items stay under Other or in the Mixed bag) and the batches that worked are kept; network, key and limit errors stop the run. The note says what was tried; a failed first full request keeps the old placement on a re-sort (front page on a first write). The JSON is found inside prose or Markdown fences (`jsonObjectIn`). *Backfill* (`sectionFill.ts`): a later write also sends one small request (at most two, 40 posts each) for the sections without a byline (name plus up to four headlines) and the placed single posts without a line; answers are matched to what was sent and read strictly; cached full passes stay valid.

**Digest v3 (DG8).** *Mark read in the digest* (`digest/markQueue.ts`): one queue for the plugin session; a single post has a button, a story has one that marks its unread posts; it reuses the reader's mark path (`reading:state`), one Studio write per post, 400 ms apart, only unread posts, never a post twice, shown at once and put back on a refusal; nothing polls. *Single-post lines* (`digest/singleLine.ts`): the content first in bold (a stored "<Author> on <topic>" line has its matching author cut off, no prompt change), then "by <Author>" in italics; no reading time on the page. *Contents* list name, dotted leader and the post count drawn under that heading. *Tap anywhere* on a post of an unfolded story opens it; the unfolded stories of an edition are kept in module memory with the scroll position (`digest/scrollMemory.ts`).
**Change notes in Corrections (DG10).** The reading rows carry no change note (only `version`/`readVersion`), so a revised post's note is read lazily: `ChangeNotes` (`digest/changeNotes.ts`) calls `StudioClient.importedNotes` = `GET /api/imports/{sub}/{id}/history` (read only, `owner:read`, present in contracts 5 and 6; entries `{version, at, note, pinned, generated}`) when the Corrections part is drawn, only for a revised post (version above 1, not withdrawn) with no `changeNote` of its own, at most 10 per draw, one after the other, never for the feed. One request per (subscription, item, version): the answer, also "no note", is kept in plugin storage (`digest-notes.json`, last 300 keys, never in the vault); a refusal, a timeout (8 s) or an unreadable answer shows nothing and is not asked again in the session (a Studio not set up yet is not counted as a failure). The note is a stranger's text: one plain line, control and direction characters removed, at most 280 characters, set with `textContent` only. The view shows it as the bold lead of the line and the headline second (`DigestView.fillChangeNotes`). Not used: the origin's own `items/{id}.json` (a second host per blyg, no spec or fixture in this repository).

**Reader mode (DG8b).** `ui/readerMode.ts` is the one source of truth for the Feed / Digest mode (settings `readerPane.mode`, only while the Daily is on): what the list view is, what Back returns to, "Open reader" opens the Daily when the Digest was the last mode, and the small switch in both headers. A post opened from a story hands the reader that story's posts (`ui/readerSteps.ts` `StoryWalk`): Next and Previous walk them in the unfolded order and the counter says "Story: <headline> · 2 of 4"; any other post walks the feed's order. *No automatic update on open* (`ui/readerStart.ts`): the Studio is asked for the list only when a reader opens from nothing for the first time in the plugin session, and on Refresh; a reader made to show a post, or made again for the Feed, starts from the list the last one held (or the file) and asks nothing; the owner's own items are read with that first load and on Refresh only; a post opened before any list exists is not checked against the Studio. The chip "In the digest: <section>" asks `digest/placement.ts` first (what the page drew: the lead block is "Front page"), then the edition record (a story without a section is under Other).

**One Refresh (DG12).** The feed's Refresh and the digest's Refresh are one action (`src/app/readerRefresh.ts`): `askAndWait` asks the Studio to fetch (`readerService.checkForNew`, so the 60 s pause and the back-off apply to both), watches the change counters, and the list is then read once (`readListAfter` for the digest; `ReaderView.reload` for the feed; both choose the walk from the same session memory, `readerStart.sessionSync`). The digest keeps the list it read for the next session like the feed does and takes the new posts into the CURRENT edition with no AI request: `Editions.open` (stable stories) puts a new post into the story it matches or the Mixed bag, the page marks what it did not show before ("+N new posts" on a story, a "new" tag on a single post) and is drawn once, in place (`DigestView.refreshNow`; no blank "Reading your list…" page; the Refresh buttons are busy while it runs and a second tap is ignored). "Write the digest" and "Re-sort sections" remain the only paths to the AI layer (tokens, consent unchanged); the digest's Refresh never starts the automatic write. The menu says in words what each button does and costs. The feed also reads the owner's own items on Refresh (its replies chip); the digest does not.

**Digest UI (DG11).** *Names:* `digest/labels.ts` holds the lead block's heading (`TOP_STORIES`, "Top stories", once called "Front page"); `sectionLabel()` maps the old stored name to the new one when a record or chip is READ, nothing stored is rewritten. *Contents:* every heading the page draws (`DigestView.section`, `DigestPast.box`) pushes its own line (name and the items drawn under it), so the contents are the headings in the order drawn, by construction; Top stories, sections and the Mixed bag count posts (a story's posts plus single posts), Letters, Corrections and Retractions count their rows; a past edition has no lead block recorded, so its contents start at its first section (an edition without sections is "Top stories" then "Mixed bag"); the plain page shows the contents from two headings on. *Stories (DG14, replaces the DG11 cards):* pure typography, no box, icon or chevron. A story's headline and summary are buttons with `aria-expanded`; `ui/storyOpen.ts` ends the meta line with a hidden "›" and paints the open state. Style: bold serif headline larger than the summary (the first story of a block larger still), an italic muted meta line, a hairline between stories, a heavier rule under section headings, an unfolded story's posts as light rows under a left hairline; the headline takes the accent colour on hover, focus and press. Spacing is a scale of CSS variables on `.blyg-daily`; single posts stay light rows. *Toggle:* the Digest bar's first row starts as far from the top as the feed header's and its toggle is aligned to the top of that row, so the Feed | Digest toggle sits at the same height in both (measured in `tests/e2e/obsidian/scenarios/daily.mjs`).

