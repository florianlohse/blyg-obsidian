// The S3 dress rehearsal in software: the real old notes (their text, as the site holds them) are put in a Studio folder with the record the
// old plugin left, marked withdrawn, and reposted in the planned order into a REAL local Studio. Nothing of the notes is kept in this repo:
// skipped unless STUDIO_E2E_URL, STUDIO_E2E_TOKEN and S3_NOTES_DIR (a checkout of the site's src/content/notes) are set.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import { repostNote } from "../../src/publish/router";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { idleTimers } from "../helpers";
import { frontmatterOf } from "../world";
import { makeStudioWorld, type StudioWorld } from "../studio/world";

const URL_ = process.env.STUDIO_E2E_URL;
const TOKEN = process.env.STUDIO_E2E_TOKEN;
const DIR = process.env.S3_NOTES_DIR;
const run = URL_ && TOKEN && DIR ? describe : describe.skip;

async function transport(req: RawRequest): Promise<RawResponse> {
  const res = await fetch(req.url, { method: req.method, headers: { ...req.headers, ...(req.contentType ? { "content-type": req.contentType } : {}) }, ...(req.body !== undefined ? { body: req.body } : {}) });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key] = value));
  return { status: res.status, headers, text: await res.text() };
}

interface Old {
  id: string;
  kind: "fragment" | "thread";
  version: number;
  created: string;
  updated: string;
  body: string;
}

function readOld(dir: string): Old[] {
  const out: Old[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(`${dir}/${file}`, "utf8");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) continue;
    const fm = m[1] ?? "";
    const get = (k: string): string => new RegExp(`^${k}: (.*)$`, "m").exec(fm)?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
    out.push({ id: get("blyg_id"), kind: get("blyg_kind") === "thread" ? "thread" : "fragment", version: Number(get("blyg_version")), created: get("blyg_created"), updated: get("blyg_updated"), body: (m[2] ?? "").trim() });
  }
  return out;
}

run("S3 rehearsal against a real Studio", () => {
  it("reposts every old note in order: fragments by last update, then threads; the thread's quote follows its fragment", async () => {
    const stray = process.env.S3_SKIP_IDS?.split(",") ?? [];
    const notes = readOld(DIR ?? "").filter((n) => !stray.includes(n.id));
    expect(notes.length).toBeGreaterThan(0);
    const order = [...notes.filter((n) => n.kind === "fragment").sort((a, b) => a.updated.localeCompare(b.updated)), ...notes.filter((n) => n.kind === "thread")];
    const nameOf = (n: Old): string => `${n.kind === "thread" ? "Thread" : "Fragment"} ${n.id.slice(0, 8)}`;
    const vault: Record<string, string> = {};
    for (const n of order) {
      // What the vault note looks like after the old plugin published it and Florian withdrew it: the old record, flagged withdrawn.
      const body = n.body.split("\n").map((l) => l.replace(/^!\[\[([0-9a-hjkmnp-tv-z]{26})\]\]\s*$/, (_all, id: string) => {
        const target = notes.find((o) => o.id === id);
        return target ? `![[${nameOf(target)}]]` : _all;
      })).join("\n");
      vault[`studio/${nameOf(n)}.md`] = `---\nblyg_id: ${n.id}\nblyg_version: ${n.version + 1}\nblyg_created: ${n.created}\nblyg_updated: ${n.updated}\n${n.kind === "thread" ? "blyg_kind: thread\n" : ""}blyg_withdrawn: true\n---\n\n${body}\n`;
    }
    const w: StudioWorld = makeStudioWorld({ vault });
    const address = studioAddress({ baseUrl: URL_ ?? "", mount: "" });
    if (!address || !w.deps.studio) throw new Error("e2e setup");
    w.deps.studio = { ...w.deps.studio, client: createStudioClient({ http: createStudioHttp({ transport, timers: idleTimers, address }), token: TOKEN ?? "" }), address };
    w.answerFor = (p) => (p.studio?.repost && p.studio.noteDefault ? { note: p.studio.noteDefault } : true);

    for (const n of order) {
      const path = `studio/${nameOf(n)}.md`;
      const out = await repostNote(w.deps, { path, name: `${nameOf(n)}.md`, extension: "md" });
      expect(out.status, `${nameOf(n)}: ${out.notices.join(" ")}`).toBe("published");
      const fm = frontmatterOf(w.local.get(path) ?? "");
      expect(fm.blyg_id).toBe(out.id);
      expect(fm.blyg_previous).toMatchObject({ id: n.id, version: n.version + 1, withdrawn: true });
      expect(fm.blyg_withdrawn).toBeUndefined();
    }
    // The thread's quote now names the new id of its fragment, and the Studio accepted the passage.
    for (const n of order.filter((o) => o.kind === "thread")) {
      const fm = frontmatterOf(w.local.get(`studio/${nameOf(n)}.md`) ?? "");
      const got = await w.deps.studio.client.getItem(String(fm.blyg_id));
      expect(got.kind).toBe("ok");
      if (got.kind === "ok") {
        for (const old of notes) expect(got.value.contentMd).not.toContain(old.id);
        expect(got.value.contentMd).toMatch(/!\[\[[0-9a-hjkmnp-tv-z]{26}\]\]/);
      }
    }
    // Studio's own listing: newest update first, so the last repost leads and the order of posting is kept.
    const list = await fetch(`${URL_}/api/items?limit=50`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json() as Promise<{ items: { id: string }[] }>);
    const newIds = order.map((n) => frontmatterOf(w.local.get(`studio/${nameOf(n)}.md`) ?? "").blyg_id as string);
    const seen = list.items.map((i) => i.id).filter((id) => newIds.includes(id));
    expect(seen).toEqual([...newIds].reverse());
  }, 120_000);
});
