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
    baseUrl: string;          // "https://blyg.example.com" — host only; the owner API is {host}/api
    mount: string;            // "" (own host) or "/blyg"; public pages are {host}{mount}/f/{id}/
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
