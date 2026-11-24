// A mark made in an open post (the reader's own path) must reach the Studio, show in the digest (post and story) and in a reader opened again, whichever page it was made from.
// The digest keeps its own queue (digest/markQueue.ts) and the reader its own copy of the list; the reader's mark now goes through app/readerWrites.ts, which notes it for both.
import { beforeEach, describe, expect, it } from "vitest";
import { createReaderWrites } from "../../src/app/readerWrites";
import { applyMarks, markable, resetMarks, sharedMarks } from "../../src/digest/markQueue";
import type { StudioClient } from "../../src/studio/client";
import { isUnread, type ReadingPost } from "../../src/studio/reading";
import { forgetSession, heldList, noteListLoaded, seedSaved, startReader, type Saved } from "../../src/ui/readerStart";
import { emptyFeedNote } from "../../src/ui/readerStart";

const post = (id: string, over: Partial<ReadingPost> = {}): ReadingPost => ({ subscriptionId: "s1", subscriptionTitle: "T", origin: null, remoteId: id, kind: "fragment", withdrawn: false, version: 1, readVersion: null, observedAt: "", created: null, isReply: false, contentHtml: "", contentMd: "", authorName: null, authorUrl: null, sourceUrl: null, ...over });
const SAVED_AT = 1_000;

function writesWith(answer: "ok" | "refuse" | "down") {
  const calls: string[] = [];
  const client = {
    markRead: (sub: string, id: string, version: number) => (calls.push(`PUT ${sub}/${id} v${version}`), answer === "down" ? Promise.reject(new Error("offline")) : Promise.resolve(answer === "ok" ? { kind: "ok" as const, value: null } : { kind: "error" as const, status: 500, message: "no" })),
    markUnread: (sub: string, id: string) => (calls.push(`DELETE ${sub}/${id}`), Promise.resolve({ kind: "ok" as const, value: null })),
  } as unknown as StudioClient;
  return { calls, writes: createReaderWrites(() => ({ ok: true, studio: { client } })) };
}

beforeEach(() => {
  resetMarks();
  forgetSession();
});

describe("a mark made in the open post (opened from the digest)", () => {
  it("is written to the Studio once, and shows on the digest's list when it is read again from the old saved copy", async () => {
    const { calls, writes } = writesWith("ok");
    const opened = post("a");
    const done = await writes.mark(opened, true); // what the reader's read check does
    expect(done).toEqual({ ok: true });
    expect(calls).toEqual(["PUT s1/a v1"]);
    // The digest is made again on Back: it reads the saved file, which does not know the mark yet.
    const stale = [post("a"), post("b")];
    sharedMarks(() => Promise.resolve({ ok: true }), () => Promise.resolve()).apply(stale, SAVED_AT);
    expect(isUnread(stale[0] as ReadingPost)).toBe(false);
    expect(isUnread(stale[1] as ReadingPost)).toBe(true);
    expect(markable(stale).map((p) => p.remoteId)).toEqual(["b"]); // so the digest's own "Mark story read" does not write it a second time
  });
  it("shows in a reader opened again for a post (its start list is the digest's, with the mark on it), and an unread mark takes it off again", async () => {
    const { writes } = writesWith("ok");
    seedSaved({ posts: [post("a"), post("b")], mentions: [], savedAt: SAVED_AT, studioOrigin: "https://studio.example.com" });
    await writes.mark(post("a"), true);
    const held = heldList() as Saved;
    expect(held.posts.map((p) => isUnread(p))).toEqual([false, true]);
    await writes.mark(post("a"), false);
    expect((heldList() as Saved).posts.map((p) => isUnread(p))).toEqual([true, true]);
  });
  it("startReader puts the mark on the saved list it starts from (the file, which is older than the mark)", async () => {
    const { writes } = writesWith("ok");
    await writes.mark(post("a"), true);
    const shown: Saved[] = [];
    await startReader({ alive: () => true, forPost: () => true, hasData: () => false, readCache: () => Promise.resolve({ posts: [post("a")], mentions: [], savedAt: SAVED_AT, studioOrigin: "o" }), mine: () => undefined, showSaved: (s) => void shown.push(s), walk: () => Promise.resolve(), load: () => Promise.resolve(), failed: () => undefined });
    expect(isUnread(shown[0]?.posts[0] as ReadingPost)).toBe(false);
  });
  it("a list saved after the mark knows better (it is not overwritten), and a newer version of the post is unread again", async () => {
    const { writes } = writesWith("ok");
    await writes.mark(post("a"), true);
    const newer = [post("a", { readVersion: null })];
    applyMarks(newer, Date.now() + 5_000);
    expect(isUnread(newer[0] as ReadingPost)).toBe(true);
    const revised = [post("a", { version: 2 })];
    applyMarks(revised, SAVED_AT);
    expect(isUnread(revised[0] as ReadingPost)).toBe(true);
  });
  it("a refusal or a lost connection takes the note back: the digest shows it unread", async () => {
    for (const answer of ["refuse", "down"] as const) {
      resetMarks();
      const { writes } = writesWith(answer);
      const done = await writes.mark(post("a"), true);
      expect(done.ok).toBe(false);
      const list = [post("a")];
      applyMarks(list, SAVED_AT);
      expect(isUnread(list[0] as ReadingPost)).toBe(true);
    }
  });
});

describe("the feed before its first answer", () => {
  it("says Loading… while the first load is pending or busy, and 'nothing to show' only after it", () => {
    expect(emptyFeedNote(false, true)).toBe("Loading…");
    expect(emptyFeedNote(true, false)).toBe("Loading…");
    expect(emptyFeedNote(false, false)).toMatch(/nothing to show/);
    expect(emptyFeedNote(false, true)).not.toMatch(/nothing to show/);
  });
  it("the first start is over only when startReader has answered (a pending cache read keeps it loading)", async () => {
    noteListLoaded();
    let release: (v: Saved | null) => void = () => undefined;
    let over = false;
    const run = startReader({ alive: () => true, forPost: () => false, hasData: () => false, readCache: () => new Promise((r) => (release = r)), mine: () => undefined, showSaved: () => undefined, walk: () => Promise.resolve(), load: () => Promise.resolve(), failed: () => undefined }).then(() => (over = true));
    await Promise.resolve();
    expect(over).toBe(false);
    release(null);
    await run;
    expect(over).toBe(true);
  });
});
