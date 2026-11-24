# What the plugin costs a Studio on Cloudflare's free tier

**Requirement:** normal intense use of the plugin must stay inside Cloudflare's free tier. For D1 that is **100,000 rows written a day** (writes count every index entry and every full-text-search row; reads are 5 million rows a day and are not the problem). Past the limit D1 refuses writes until 00:00 UTC.

Everything below was **measured on a local Studio 0.69.0** (the release the maintainer runs) with `scripts/measure-d1-writes.mjs`; what is estimated is said to be estimated. Nothing here touched a live Studio or a Cloudflare account.

## 1. Method and its limits

`scripts/local-studio.sh` (`STUDIO_VERSION=0.69.0 WITH_REMOTE=1`) runs two real Studios on miniflare, each with a local D1, which is a SQLite file. `scripts/measure-d1-writes.mjs <dir>`:

- puts `AFTER INSERT / UPDATE / DELETE` triggers on **every table** of the first Studio's database; each trigger appends one row to a counter table, with the columns an UPDATE changed;
- counts the **FTS5 shadow tables** (`search_fts_data`, `_idx`, `_docsize`) by before/after snapshot, because SQLite refuses triggers on them;
- fires each action against the real HTTP API with a token (marks, polls, list reads) or the owner cookie (follow, unfollow), waits until the Studio has been quiet for 6 s (the poll's work runs after its response), and reads the counter;
- publishes posts on the second Studio and follows it from the first, so the imported set is real imported data.

Dataset: one followed blyg on the second Studio; 60 invented fragments of 900 characters (the Studio's fragment limit is 1,000) imported by one poll, then single posts, a burst of 10, a revision, and so on; the reading list holds 85 to 90 posts. Where a cost depends on the size of the list (`N`) the table says so, and section 3 turns it into a model.

**Limits, honestly:**

1. **Rows, not billing.** The first number is rows written per *table* (the triggers). D1 also bills every secondary index entry a write touches. The second number is an upper bound: each written row counted once for the table and once for each secondary index on it, as if every UPDATE changed every indexed column. The bill lies between the two; the table shows both and the model uses the first (rounded up).
2. **FTS rows are snapshot differences:** a row rewritten twice in one action counts once, so FTS is a lower bound (it is about 2.4 rows a post in the table, small next to the rest). The segment merges FTS5 does later are not seen unless they happen inside the quiet window.
3. `INSERT OR REPLACE` would not fire the delete trigger and count one row. (Nothing the measured actions run does that, as far as the triggers show.)
4. Local D1 is SQLite, production D1 is SQLite behind a different front end. Row counts of the statements are the same; D1's own `meta.rows_written` could not be read from outside the worker, so they are not cross-checked against it.
5. The Studio's own **rate-limit counter** (`security_budgets`) is a real write: 1 to 2 rows on every API request, a read or a 404 included. It is in every number below. The fixture clears it between actions only so that a series of calls is not refused.
6. One followed blyg only. A cost per blyg is multiplied by the number of blygs in section 3 and is therefore partly an estimate.
7. The Studio's cron (every minute, every 15 minutes, daily) never fires on its own locally; the script fires it by hand through `/cdn-cgi/handler/scheduled`.
8. Re-run it for another Studio release: the costs below are properties of 0.69.0.

## 2. What was measured

Rows written per action (`N` = posts in the reading list, 87 in this run):

| Action | Rows (tables) | Rows incl. all indexes (upper bound) | Per unit |
| --- | ---: | ---: | --- |
| **Poll** (`POST /subscriptions/poll`), nothing new, 1 blyg | 4 | 7 | 4 per blyg |
| Poll, 1 new post (blyg's posts days apart) | 14 | 21 | 14 per post |
| Poll, 10 new posts | 101 | 144 | 10 per post |
| Poll, 1 revised post | 8 | 15 | 8 per revision |
| Poll, first import of 60 posts | 573 | 939 | 9.6 per post |
| Poll, 1 new post **in a burst** (every post of the blyg created within 15 minutes of it) | 136 | 265 | grows with the posts of the previous 15 minutes (see below) |
| Poll, 10 new posts, the same burst | 1,459 | 2,742 | 146 per post here |
| The Studio's own cron poll, blyg due, nothing new | 3 | 6 | 3 per due blyg, a blyg is due every 30 to 45 minutes |
| Cron every minute (feed rebuild); cron every 15 minutes with no blyg due | 0 | 0 | |
| Cron every 15 minutes, 1 new post | 18 | 31 | |
| **Mark** one post read / unread | 4 | 4 | 4 per request |
| Mark a post that is already read, again | 3 | 3 | (the plugin does not send this) |
| Mark a story of 5 posts read, 5 single requests (today) | 20 | 20 | 4 per post |
| Mark a story of 5 posts read, one `POST /reading/read` batch | 12 | 12 | 2.4 per post |
| **Unfollow** a blyg of 87 posts | 391 | 568 | 4.5 per post |
| **Follow** a blyg of 87 posts | 740 | 1,116 | 8.5 per post |
| Any `GET` (list page, `/reading/summary`, `/subscriptions`) with nothing changed | 2 | 2 | 2 per request (the rate-limit counter only) |
| Poll with nothing new, then **`GET /reading`** (the full read's own-posts list), default order | 175 | 178 | **about 2N + 1**: the Studio rewrites its whole stored reading order |
| The same, then `GET /reading/imported` (the incremental read) | 6 | 9 | no rewrite |
| Mark 1 post unread, then `GET /reading`, default order | 175 | 175 | the same rewrite |
| **One whole Refresh tap**, nothing new, full read, default order (until this change) | **187** | 190 | about 2N + 13 |
| One Refresh tap, nothing new, full read, `order=newest` (this change) | **18** | 21 | independent of N |
| One Refresh tap with 1 new post, default order | 200 | 209 | |
| One Refresh tap with 1 new post, `order=newest` | 32 | 43 | |

A Refresh tap here is the plugin's contract-6 sequence: `GET /subscriptions`, the poll, three more `GET /subscriptions` (the freshness check every 1.5 s), then one full read of the list (`/reading/imported`, `/mentions`, `/reading`).

### What the numbers say

1. **The 60-second re-read, opening the reader, the digest, Back and every list read write no content row.** They write the rate-limit counter, 2 rows a request. That is the proof of "reads do not write posts", and also the correction of "reads write nothing": each request costs about 2 rows (a reader open for 8 hours that re-reads every minute would cost about 1,000 rows a day; nothing in the plugin does that on a timer, DG6).
2. **The dominant cost was not a poll and not a mark.** A Studio on contract 6.2 keeps a stored reading order (`reading_order`) for the pace-layered feed. It is valid for one "generation" (the Studio's counters for items, reading and subscriptions). **Every poll moves the subscriptions counter**, so the first `GET /reading` after any Refresh, even one with nothing new, deletes the whole stored order and inserts it again: **2 rows per post in the list, every Refresh**. At 87 posts that was 174 of a tap's 187 rows. The cost is proportional to the size of the list, so it grows every day. (Read from the Studio's code, `ensureReaderOrder`, and confirmed by the table.)
3. The plugin's incremental read (`/reading/imported`) does not trigger the rewrite. The full read does, because it also reads the owner's own posts from `/reading`, which uses the default order. Asking for `order=newest` skips the rewrite (**this change**, `listOwnReading`, only on Studios that announce contract 6.2 or later: Studio 0.67.0, contract 6.0.0, answers the parameter with a 400).
4. **A new post costs 8 to 14 rows** (imported row 3, change counter 3, search index about 2.4, search document 1, plus the request's counters). Unless posts arrive in a burst: the Studio's "was this superseded?" pass rewrites a row for every post of the same blyg created in the **15 minutes before** the new one. A blyg that posts 15 times in a quarter of an hour costs about 1.5 rows per earlier post in the burst on top. (The burst rows above are a worst case: the fixture's posts are all seconds apart.)
5. A mark is 4 rows (read state 1, change counter 1, rate-limit counter 2). A batch of 5 is 12 instead of 20. The plugin already never marks a post that is read, and never marks a post twice (`markable()` in `src/digest/markQueue.ts`, `tests/digest/dg8.test.ts`).
6. The Studio's own cron costs 3 rows per due blyg; a blyg is due every 30 minutes (`POLL_INTERVAL_MS`, run by the 15-minute cron), so about **48 polls and 150 rows a day per followed blyg**, whatever you do with the plugin. The every-minute cron writes nothing.

### Save for later (SH1): an estimate, not measured

The plugin's save is one `PUT /shelf` and nothing else: it starts from the shelf it read when the reader (or the Daily) opened (one `GET /shelf`, once per opening, never on a timer), and a stale list is answered by the Studio's own 409 with the current list, so a save needs no read of its own. A race with another device costs one more PUT (at most 3 in all, then the plugin stops and says so). Listing the Saved view is one `GET /reading?shelf=true&order=newest` per tap of the chip.

| Action | Rows written (estimate) | Basis |
| --- | ---: | --- |
| `GET /shelf`, `GET /reading?shelf=true` | 2 | the rate-limit counter only, like every other `GET` above; whether the Shelf lens triggers the stored-order rewrite is **not measured** (the plugin asks `order=newest`, which the spec says the Shelf ignores in favour of its own order) |
| `PUT /shelf` (a save, or a removal) | 3 to about 105 | **unmeasured.** The request is a whole-list replace of at most 50 entries. If the Studio keeps the list as one row: about 3 (the list, its revision, the rate-limit counter). If it keeps one row per entry and replaces them all: about 2 per entry plus 3, so up to about 105 at a full shelf of 50 |
| A save that loses a race | one more of the above | the 409 itself writes only the rate-limit counter |

At the upper bound a day of 100 saves would be about 10,000 rows, a tenth of the free tier's 100,000 writes a day; at the lower bound about 300. Measure it with the method of section 1 (PUT a shelf of 1, 10 and 50 entries on a throwaway Studio) before saying more.

## 3. Budget model

`R = rows written in a day`. With `T` Refresh taps, `P` new posts, `M` marks (single requests), `B` followed blygs, `N` posts in the list:

```
before this change:  R ≈ T × (13 + 2N)  +  P × 12  +  M × 4  +  B × 150  +  reads
after this change:   R ≈ T × 18         +  P × 12  +  M × 4  +  B × 150  +  reads
```

(`reads` ≈ 2 rows × the list reads of opening the reader and the digest, 200 to 400 a day. 12 is the middle of 8 to 14. These are fitted to the measurements above; the formula for other `N` and `B` is an estimate, because only one blyg and `N` of 87 to 90 were measured.)

**How many Refresh taps fit** (the other terms at 'normal intense', about 8,500 rows, below):

| Posts in the list `N` | Taps a day, before | Taps a day, after |
| ---: | ---: | ---: |
| 100 | about 430 | about 5,000 |
| 500 | about 90 | about 5,000 |
| 1,000 | about 45 | about 5,000 |
| 2,000 | about 23 | about 5,000 |

**What 'normal intense use' costs** (40 Refresh taps, 300 new posts imported, 200 marks, 25 followed blygs, a list of 500 posts; the 25 blygs and the 500 are assumptions, the rest are measured costs):

| Term | Before this change | After this change |
| --- | ---: | ---: |
| 40 Refresh taps | 40,500 | 720 |
| 300 new posts | 3,600 | 3,600 |
| 200 marks (single requests) | 800 | 800 |
| The Studio's cron, 25 blygs | 3,750 | 3,750 |
| Reads (opening the reader, the digest) | 300 | 300 |
| **Total** | **about 49,000** | **about 9,000** |

The tap dominated before; after it the cron poll and the new posts dominate (and each is about 4 percent of the free tier).

**Does this explain 114.9k on 2026-11-23?** About 100 Refresh taps at a list of about 550 posts is 100 × (13 + 1,100) ≈ 111,000 rows; the maintainer's account had 114,900 that day, with a night of testing on top. This is a consistency check, **not proof**: the real size of the list, the number of blygs and the other actions of that day are not known here, and the run of 0.69.0's own migration (migration 0050, which backfills the search index of every imported post, estimated at 3 to 4 rows a post from the first-import measurement) was not measured.

**What is measured, what is estimated:** measured: every row of the table in section 2 (one blyg, a list of 87 to 90 posts, one run). Estimated: the model for other `N`, `B`, post sizes and burst sizes; the number of followed blygs; the billing of index entries (between the two columns); the size of the migration backfill.

## 4. What the plugin controls, and what only the Studio can fix

Done in the plugin (this change): the own-posts read asks for `order=newest` on contract 6.2 and later (section 2, point 3).

Not done, proposed in the pull request (each with what it saves and what it costs in behaviour): reading the list after a Refresh only when something moved; a batch request for marking a story read; a longer minimum between Refresh taps; and, for the Studio's developers, writing the stored reading order incrementally (or not tying it to the poll's counter) and not rewriting the posts of the last 15 minutes on every new post.

## 5. Guard

`tests/e2e/obsidian/scenarios/daily-refresh.mjs` (real Obsidian, stand-in Studio) already counts the requests of a Refresh tap by kind: one tap is one poll and one list read, in the feed and in the digest, nothing is asked without a tap, and the second tap within the 60 s pause sends no poll. It now also fails when the Studio sees **any write request other than the Refresh's one poll** while the reader and the digest are opened, Refresh is tapped twice and the pause holds. `tests/studio/client.test.ts` pins the `order=newest` request on contract 6.2 and its absence on contract 5, 6.0 and 6.1. To re-measure: start a Studio as in section 1 and run `node scripts/measure-d1-writes.mjs <dir>` (about ten minutes).
