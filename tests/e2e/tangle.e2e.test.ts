// V1-C against a REAL Studio (see studio.e2e.test.ts for how to start one): a thread with a span and a placeholder is published once, the Studio makes the
// items first, the note is rewritten the way the Studio rewrote its working copy, and publishing again makes nothing new. Needs a Studio with API contract 6
// (the pinned 0.51.0 leg has contract 5: the test then says so and passes without asserting). Verified against the newest Studio only.
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { RawRequest, RawResponse } from "../../src/platform/http";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { frontmatterOf } from "../world";
import { idleTimers } from "../helpers";
import { makeStudioWorld, tapStudio } from "../studio/world";

const URL_ = process.env.STUDIO_E2E_URL;
const TOKEN = process.env.STUDIO_E2E_TOKEN;
const MOUNT = process.env.STUDIO_E2E_MOUNT ?? "";
const run = URL_ && TOKEN ? describe : describe.skip;

async function transport(req: RawRequest): Promise<RawResponse> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(req.url, { method: req.method, headers: { ...req.headers, ...(req.contentType ? { "content-type": req.contentType } : {}) }, ...(req.bodyBytes !== undefined ? { body: req.bodyBytes } : req.body !== undefined ? { body: req.body } : {}) });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => (headers[key] = value));
    const text = await res.text();
    if (res.status === 429 && attempt <= 4) {
      await sleep(15_000);
      continue;
    }
    return { status: res.status, headers, text };
  }
}

run("tangling against a real Studio", () => {
  it("publishes a thread with a span and a placeholder once, rewrites the note, makes nothing the second time", async () => {
    const NOTE = "studio/Tangle.md";
    const stamp = Date.now().toString(36);
    const body = `---\nblyg_kind: thread\n---\nIntro ${stamp}.\n\n![[+ A passage of mine ${stamp} that becomes its own item with an address of its own]]\n\nAnd about [[+ an idea ${stamp}]] later.\n`;
    const w = makeStudioWorld({ vault: { [NOTE]: body } });
    const address = studioAddress({ baseUrl: URL_ ?? "", mount: MOUNT });
    if (!address || !w.deps.studio) throw new Error("e2e setup");
    const client = createStudioClient({ http: createStudioHttp({ transport, timers: idleTimers, address }), token: TOKEN ?? "" });
    w.deps.studio = { ...w.deps.studio, client, address };
    w.deps.tangle = () => true;

    const caps = await client.capabilities();
    if (caps.kind !== "ok" || Number(caps.value.contractVersion.split(".")[0]) < 6) {
      console.warn(`tangle e2e: this Studio speaks contract ${caps.kind === "ok" ? caps.value.contractVersion : "?"}; tangling needs 6. Not asserted.`);
      const out = await tapStudio(w, NOTE);
      expect(out.status).toBe("refused"); // fails closed on a Studio that cannot do it
      return;
    }

    const out = await tapStudio(w, NOTE);
    expect(out.status, out.notices.join("\n")).toBe("published");
    expect(w.previews).toHaveLength(1);
    expect(w.previews[0]?.studio?.tangle?.rows).toHaveLength(2);
    const local = w.local.get(NOTE) ?? "";
    expect(local).not.toContain("![[+");
    expect(local).not.toContain("[[+");
    const id = out.id ?? "";
    const item = await client.getItem(id);
    expect(item.kind).toBe("ok");
    if (item.kind !== "ok") return;
    expect(item.value.status).toBe("public");
    // the note holds what the Studio's working copy holds (after the properties)
    const noteBody = local.replace(/^---[\s\S]*?---\n/, "").trim();
    expect(noteBody).toBe(item.value.contentMd.trim());
    // every id the rewrite wrote is a published item
    const ids = [...noteBody.matchAll(/\[\[([0-9a-hjkmnp-tv-z]{26})(?: \|[^\]]*)?\]\]/g)].map((m) => m[1] ?? "");
    expect(ids).toHaveLength(2);
    for (const made of ids) {
      const got = await client.getItem(made);
      expect(got.kind === "ok" && got.value.status === "public" && got.value.version === 1).toBe(true);
    }
    expect(frontmatterOf(local).blyg_id).toBe(id);

    // a second publish: no new items (the same two exist, the previews did not grow with a list of new items)
    const again = await tapStudio(w, NOTE);
    expect(["noop", "published"]).toContain(again.status);
    expect(w.previews.slice(1).every((p) => p.studio?.tangle === undefined)).toBe(true);
    expect((w.local.get(NOTE) ?? "").match(/\[\[[0-9a-hjkmnp-tv-z]{26}/g)).toHaveLength(2);
  }, 120_000);
});
