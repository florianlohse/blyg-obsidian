#!/usr/bin/env node
// Counts the D1 rows each plugin action writes, against a real local Studio (scripts/local-studio.sh, WITH_REMOTE=1). See docs/CLOUDFLARE-LOAD.md.
//
//   STUDIO_VERSION=0.69.0 WITH_REMOTE=1 scripts/local-studio.sh start /tmp/cf-studio
//   node scripts/measure-d1-writes.mjs /tmp/cf-studio            # prints a markdown table
//
// Method: the local D1 is a SQLite file under <dir>/.wrangler/state/v3/d1. This script adds AFTER INSERT/UPDATE/DELETE triggers on every table
// (the FTS5 shadow tables included) that append one row to a counter table, then reads the counter after each action. Limits, honestly:
//  - it counts rows written per TABLE; D1 also bills every index entry a write touches. "indexed" is an upper bound: each written row times
//    (1 + the number of secondary indexes on its table). The real bill sits between the two columns.
//  - an UPDATE that changes no indexed column is counted as if it touched all indexes in "indexed".
//  - INSERT OR REPLACE deletes without firing the delete trigger (SQLite default), so a replace counts one row.
//  - the FTS5 virtual table cannot carry triggers; its shadow tables (search_fts_data / _idx / _docsize / _content / _config) do, if SQLite fires them
//    for the module's own statements. The script checks that and says so in its output.
//  - the Studio runs background work after the response (the poll, the change queue): an action is "done" when the counter has been quiet for QUIET_MS.
// Local-only: needs no Cloudflare access. Uses only node:sqlite (Node 22.13+).
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: measure-d1-writes.mjs <local-studio dir>");
const URL_ = process.env.STUDIO_URL ?? "http://localhost:8787";
const REMOTE = process.env.REMOTE_URL ?? "http://localhost:8788";
const REMOTE_DIR = process.env.REMOTE_DIR ?? `${dir}-remote`;
const PASSWORD = "local-test-password-123"; // made up by local-studio.sh for this run
const QUIET_MS = Number(process.env.QUIET_MS ?? 6000);
const SKIP = new Set(["d1_migrations", "_cf_METADATA", "__wlog", "search_fts"]);
// SQLite refuses triggers on FTS5 shadow tables (workerd then reports a corrupt schema), so those are counted by before/after snapshot instead.
const isShadow = (n) => /^search_fts_/.test(n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbFile = (d) => {
  const base = join(d, ".wrangler/state/v3/d1");
  const sub = readdirSync(base).find((x) => !x.endsWith(".sqlite") && !x.startsWith("."));
  const f = readdirSync(join(base, sub)).find((x) => x.endsWith(".sqlite") && x !== "metadata.sqlite");
  return join(base, sub, f);
};
const db = new DatabaseSync(dbFile(dir));
db.exec("PRAGMA busy_timeout = 10000");

// The Studio rate-limits API writes (security_budgets); a measurement run is not a person, so the fixture clears them (the remote Studio is not measured).
const rdb = new DatabaseSync(dbFile(REMOTE_DIR));
rdb.exec("PRAGMA busy_timeout = 10000");
const clearBudgets = (d) => d.exec("DELETE FROM security_budgets");

// ---- triggers -------------------------------------------------------------------------------------------------------------------------------
db.exec("DROP TABLE IF EXISTS __wlog; CREATE TABLE __wlog (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, op TEXT NOT NULL, d TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)))");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).filter((n) => !SKIP.has(n) && !isShadow(n));
for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '__w_search_fts%'").all()) db.exec(`DROP TRIGGER \"${r.name}\"`);
const shadowTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'search_fts_%'").all().map((r) => r.name);
const snap = () => {
  const out = {};
  for (const t of shadowTables) {
    const m = new Map();
    let rowsOf;
    try { rowsOf = db.prepare(`SELECT rowid AS __k, * FROM "${t}"`).all(); } catch { rowsOf = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => ({ __k: Object.values(r).slice(0, -1).join("|") || "0", ...r })); }   // WITHOUT ROWID: the key is every column but the last
    for (const r of rowsOf) m.set(r.__k, JSON.stringify(r, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v)));
    out[t] = m;
  }
  return out;
};
const diff = (a, b) => {
  const out = {};
  for (const t of shadowTables) {
    let n = 0;
    for (const [k, v] of b[t]) if (a[t].get(k) !== v) n++;
    for (const k of a[t].keys()) if (!b[t].has(k)) n++;
    if (n) out[t] = n;
  }
  return out;
};
const indexCount = {};
for (const t of tables) {
  indexCount[t] = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_autoindex%'").get(t).c;
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name);
  const changed = cols.map((c) => `CASE WHEN OLD."${c}" IS NOT NEW."${c}" THEN '${c},' ELSE '' END`).join(" || ");
  const sql = (op) => `DROP TRIGGER IF EXISTS __w_${t}_${op}; CREATE TRIGGER __w_${t}_${op} AFTER ${op} ON "${t}" BEGIN INSERT INTO __wlog (t, op, d) VALUES ('${t}', '${op}', ${op === "UPDATE" ? changed : "''"}); END`;
  for (const op of ["INSERT", "UPDATE", "DELETE"]) db.exec(sql(op));
}
const logSize = () => db.prepare("SELECT count(*) c FROM __wlog").get().c;
async function settle() {
  let last = -1;
  let since = Date.now();
  for (let i = 0; i < 120; i++) {
    const n = logSize();
    if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= QUIET_MS) return;
    await sleep(250);
  }
}
/** Run fn, wait until the Studio is quiet, return { rows, indexed, byTable }. */
async function measure(fn) {
  db.exec("DELETE FROM security_budgets");
  db.exec("DELETE FROM __wlog");
  await sleep(100);
  const before = snap();
  const out = await fn();
  await settle();
  const byTable = diff(before, snap());
  for (const r of db.prepare("SELECT t, count(*) c FROM __wlog GROUP BY t").all()) byTable[r.t] = r.c;
  const detail = db.prepare("SELECT t || ' ' || op || ' ' || d AS k, count(*) c FROM __wlog GROUP BY k ORDER BY c DESC").all();
  if (process.env.TRACE) console.error(JSON.stringify({ detail: detail.slice(0, 8), seconds: db.prepare("SELECT (ts - (SELECT min(ts) FROM __wlog)) / 1000 AS s, count(*) c FROM __wlog GROUP BY s").all() }));
  let rows = 0;
  let indexed = 0;
  for (const [t, c] of Object.entries(byTable)) { rows += c; indexed += c * (1 + (indexCount[t] ?? 0)); }
  return { rows, indexed, byTable, detail, out };
}

// ---- HTTP -----------------------------------------------------------------------------------------------------------------------------------
async function http(base, method, path, { token, cookie, body } = {}) {
  const headers = { origin: base, ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) };
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}
async function login(base) {
  const res = await fetch(`${base}/studio/login`, { method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: `password=${encodeURIComponent(PASSWORD)}`, redirect: "manual" });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function mint(base, cookie, scope) {
  const r = await http(base, "POST", "/api/authorizations", { cookie, body: { name: "d1 measure", resource: "api", scope } });
  return r.json.accessToken ?? r.json.access_token;
}
const SCOPES = ["owner:read", "owner:draft", "owner:publish", "owner:manage", "reading:state"];
const text = (n, seed) => {
  // n characters of varied prose-like text (the FTS trigram count depends on it): a seed keeps each post different
  const words = ["garden", "river", "winter", "market", "letter", "engine", "harbor", "window", "silver", "number", "morning", "paper", "orchard", "signal", "bridge", "copper", "meadow", "lantern", "thread", "island"];
  let s = `Post ${seed}. `;
  let i = seed;
  while (s.length < n) { i = (i * 7 + 3) % 9973; s += `${words[i % words.length]} ${words[(i >> 3) % words.length]} ${i % 100 === 0 ? "\n\n" : ""}`; }
  return s.slice(0, n);
};
// the remote Studio serves its feed stale-while-revalidate: the first request only starts the rebuild, the second sees it
async function refreshRemoteFeed() {
  for (let i = 0; i < 2; i++) { await fetch(`${REMOTE}/feed.xml`); await sleep(1500); }
}
async function publishRemote(rtoken, n, chars, seed0) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) clearBudgets(rdb);
    const c = await http(REMOTE, "POST", "/api/items", { token: rtoken, body: { mode: "blank", contentMd: text(chars, seed0 + i) } });
    const p = await http(REMOTE, "POST", `/api/items/${c.json.id}/publish`, { token: rtoken, body: { expectedRevision: c.json.revision } });
    if (p.status !== 200) throw new Error(`remote publish failed ${p.status} ${JSON.stringify(p.json)}`);
    ids.push(c.json.id);
  }
  // the remote Studio rebuilds its feed from its every-minute cron, which never fires locally: run it, or the poll sees nothing
  await fetch(`${REMOTE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`);
  await refreshRemoteFeed();
  return ids;
}
async function readingPage(token, query = "") {
  const r = await http(URL_, "GET", `/api/reading?limit=50${query}`, { token });
  return r.json;
}

// ---- the run --------------------------------------------------------------------------------------------------------------------------------
const rows = [];
const clearLocal = () => db.exec("DELETE FROM security_budgets");
const add = (action, unit, m, per, note = "") => rows.push({ action, unit, rows: m.rows, indexed: m.indexed, per, note, byTable: m.byTable });

const cookie = await login(URL_);
const token = await mint(URL_, cookie, SCOPES);
console.error("token ok:", typeof token === "string" && token.length > 20);
const rcookie = await login(REMOTE);
const rtoken = await mint(REMOTE, rcookie, ["owner:read", "owner:draft", "owner:publish", "owner:manage"]);

// shadow tables fire triggers? (a quick probe on the real database: any search_fts_* row in the log after the first import proves it)
const sub0 = (await http(URL_, "GET", "/api/subscriptions", { token })).json;
console.error("subscriptions:", JSON.stringify(sub0).slice(0, 200));

const N_BASE = Number(process.env.N_BASE ?? 60);
console.error(`seeding ${N_BASE} posts of 900 chars on the remote Studio ...`);
const baseIds = await publishRemote(rtoken, N_BASE, 900, 1000);
const sub = (await http(URL_, "GET", "/api/subscriptions", { token })).json;
const subId = (sub.items ?? sub.subscriptions ?? sub)[0].id;
console.error("subscription id", subId);

const poll = () => http(URL_, "POST", "/api/subscriptions/poll", { token, body: {} });
const pollOnce = async () => (await poll()).json;

const count = () => db.prepare("SELECT count(*) c FROM imported_items").get().c;
const before0 = count();
const first = await measure(pollOnce);
add(`poll: first import of ${count() - before0} posts (${N_BASE} x 900 chars seeded, one poll)`, `${count() - before0} posts`, first, Math.max(1, count() - before0));
add("poll: nothing new", "1 blyg", await measure(pollOnce), 1);
add("poll: nothing new (again)", "1 blyg", await measure(pollOnce), 1);

const spread = () => db.exec("UPDATE imported_items SET observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (((SELECT max(rowid) FROM imported_items) - rowid + 1) * 90) || ' minutes'), created = observed_at, updated = observed_at");   // 1 post every 90 minutes, none within 15 minutes of a new one
for (const [n, chars, burst] of [[1, 900, true], [10, 900, true], [1, 900, false], [10, 900, false], [1, 300, false]]) {
  if (!burst) spread();
  await publishRemote(rtoken, n, chars, 5000 + n * 10 + chars);
  add(`poll: ${n} new post${n > 1 ? "s" : ""}, ${chars} chars, ${burst ? "BURST (all posts created within 15 min of each other)" : "posts spread over days"}`, `${n} post${n > 1 ? "s" : ""}`, await measure(pollOnce), n);
}

// a revised post: edit the first remote item and publish again
{
  const id = baseIds[0];
  spread();
  const cur = (await http(REMOTE, "GET", `/api/items/${id}`, { token: rtoken })).json;
  const up = await http(REMOTE, "PATCH", `/api/items/${id}`, { token: rtoken, body: { contentMd: text(900, 777) } , });
  const rev = up.json?.revision ?? cur.revision;
  await http(REMOTE, "POST", `/api/items/${id}/publish`, { token: rtoken, body: { expectedRevision: rev } });
  await fetch(`${REMOTE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`);
  await refreshRemoteFeed();
  add("poll: 1 revised post (new version, 900 chars)", "1 post", await measure(pollOnce), 1);
}

// reading state
const five = db.prepare("SELECT subscription_id AS sub, remote_id AS remoteId, version FROM imported_items WHERE state = 'current' AND subscription_id = ? ORDER BY rowid DESC LIMIT 5").all(subId).map((r) => ({ ...r }));
const one = five[0];
const markOne = (r) => http(URL_, "PUT", `/api/reading/${encodeURIComponent(r.sub)}/${encodeURIComponent(r.remoteId)}/read`, { token, body: { version: r.version } });
const unmarkOne = (r) => http(URL_, "DELETE", `/api/reading/${encodeURIComponent(r.sub)}/${encodeURIComponent(r.remoteId)}/read`, { token });

add("mark one post read", "1 post", await measure(() => markOne(one)), 1);
add("mark the same post read again (already read)", "1 post", await measure(() => markOne(one)), 1);
add("mark one post unread", "1 post", await measure(() => unmarkOne(one)), 1);
add("mark unread again (already unread)", "1 post", await measure(() => unmarkOne(one)), 1);
add("mark a story of 5 posts read: 5 single PUTs (what the plugin does today)", "5 posts", await measure(async () => { for (const r of five) await markOne(r); }), 5);
add("mark 5 posts unread: 5 single DELETEs", "5 posts", await measure(async () => { for (const r of five) await unmarkOne(r); }), 5);
add("mark a story of 5 posts read: ONE batch POST /reading/read", "5 posts", await measure(() => http(URL_, "POST", "/api/reading/read", { token, body: { items: five } })), 5);
add("mark the same 5 posts read again via batch (all already read)", "5 posts", await measure(() => http(URL_, "POST", "/api/reading/read", { token, body: { items: five } })), 5);
add("mark 5 posts unread: ONE batch POST /reading/unread", "5 posts", await measure(() => http(URL_, "POST", "/api/reading/unread", { token, body: { items: five.map(({ sub: s, remoteId }) => ({ sub: s, remoteId })) } })), 5);

// reads: the plugin's incremental read is GET /reading/imported; a full read (a tap after 5 min, or the first one) also reads GET /reading (the owner's own posts, pace-layered order)
const listImported = () => http(URL_, "GET", "/api/reading/imported?limit=50", { token });
const listOwn = () => http(URL_, "GET", "/api/reading?limit=50", { token });
await measure(async () => { await listImported(); await listOwn(); });   // settle: the first read after the changes above may rebuild the stored order
add("GET /reading/imported page (50), nothing changed", "1 page", await measure(listImported), 1);
add("GET /reading page (50), nothing changed", "1 page", await measure(listOwn), 1);
await measure(pollOnce);
add("poll with nothing new, then GET /reading/imported (incremental read)", "1 poll + 1 page", await measure(async () => { await pollOnce(); await sleep(1500); await listImported(); }), 1);
await measure(pollOnce);
add("poll with nothing new, then GET /reading (the full read's own-posts list)", "1 poll + 1 page", await measure(async () => { await pollOnce(); await sleep(1500); await listOwn(); }), 1);
add("mark 1 post read, then GET /reading/imported", "1 mark + 1 page", await measure(async () => { await markOne(one); await listImported(); }), 1);
add("mark 1 post unread, then GET /reading", "1 mark + 1 page", await measure(async () => { await unmarkOne(one); await listOwn(); }), 1);

// one whole Refresh tap as the plugin makes it on a contract-6 Studio (readerRefresh.ts): look at the blygs, ask for the fetch, look 3 more times, then ONE full read of the list
const walkGet = async (path, q, max) => {
  let cursor = null;
  for (let i = 0; i < max; i++) {
    const r = await http(URL_, "GET", `/api/${path}?${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token });
    cursor = r.json?.page?.nextCursor ?? null;
    if (!cursor) break;
  }
};
const refreshTap = (ownQuery) => async () => {
  await http(URL_, "GET", "/api/subscriptions", { token });
  await pollOnce();
  for (let i = 0; i < 3; i++) { await sleep(1500); await http(URL_, "GET", "/api/subscriptions", { token }); }
  await walkGet("reading/imported", "limit=100", 2);
  await walkGet("mentions", "direction=inbound&limit=100", 2);
  await walkGet("reading", ownQuery, 2);
};
await measure(refreshTap("limit=50"));   // settle
add("ONE Refresh tap, nothing new, full read, default order (what the plugin sent until now)", "1 tap", await measure(refreshTap("limit=50")), 1);
add("ONE Refresh tap, nothing new, full read, order=newest (this change)", "1 tap", await measure(refreshTap("order=newest&limit=50")), 1);
await publishRemote(rtoken, 1, 900, 9300);
add("ONE Refresh tap with 1 new post, default order", "1 tap", await measure(refreshTap("limit=50")), 1);
await publishRemote(rtoken, 1, 900, 9400);
add("ONE Refresh tap with 1 new post, order=newest", "1 tap", await measure(refreshTap("order=newest&limit=50")), 1);
add("GET /reading/summary", "1 call", await measure(() => http(URL_, "GET", "/api/reading/summary", { token })), 1);
add("GET /changes (404 on Studio 0.69.0, the plugin does not call it there: shows that even a 404 costs the budget rows)", "1 call", await measure(() => http(URL_, "GET", "/api/changes", { token })), 1);
add("GET /subscriptions (the contract-6 freshness check, every 1.5 s while a Refresh waits)", "1 call", await measure(() => http(URL_, "GET", "/api/subscriptions", { token })), 1);

// cron
const cron = (expr) => fetch(`${URL_}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(expr)}`).then((r) => r.status);
add("cron every minute (feed rebuild), nothing changed", "1 run", await measure(() => cron("* * * * *")), 1);
db.exec("UPDATE subscriptions SET last_poll_at = '2000-01-01T00:00:00.000Z'");
add("cron */15 (poll due blygs + queue drains), blyg due, nothing new", "1 run", await measure(() => cron("*/15 * * * *")), 1);
add("cron */15, blyg not due", "1 run", await measure(() => cron("*/15 * * * *")), 1);
await publishRemote(rtoken, 1, 900, 9100);
db.exec("UPDATE subscriptions SET last_poll_at = '2000-01-01T00:00:00.000Z'");   // make the blyg due (the Studio polls a blyg every 30 min)
add("cron */15 with 1 new post on the remote", "1 post", await measure(() => cron("*/15 * * * *")), 1);

// unfollow / follow with N posts
const total = (await http(URL_, "GET", "/api/search?source=imported&limit=1", { token })).json;
console.error("imported total hint", JSON.stringify(total).slice(0, 120));
const imported = db.prepare("SELECT count(*) c FROM imported_items").get().c;
add(`unfollow the blyg (deletes its ${imported} imported posts)`, `${imported} posts`, await measure(() => http(URL_, "DELETE", `/api/subscriptions/${subId}`, { cookie, body: undefined })), imported);
add(`follow the blyg again (imports ${imported} posts)`, `${imported} posts`, await measure(async () => {
  await http(URL_, "POST", "/api/subscriptions", { cookie, body: { url: `${REMOTE}/`, confirm: true, title: "Blog B" } });
  for (let i = 0; i < 6; i++) { await pollOnce(); await sleep(2500); }
}), imported, "follow + up to 6 polls, until quiet");

// ---- output ---------------------------------------------------------------------------------------------------------------------------------
console.log("| action | unit | rows written (tables) | rows incl. all indexes (upper bound) | per unit (tables / upper) |");
console.log("| --- | --- | ---: | ---: | ---: |");
for (const r of rows) console.log(`| ${r.action} | ${r.unit} | ${r.rows} | ${r.indexed} | ${(r.rows / r.per).toFixed(1)} / ${(r.indexed / r.per).toFixed(1)} |`);
console.log("\nby table:");
for (const r of rows) console.log(`- ${r.action}: ${JSON.stringify(r.byTable)}`);
