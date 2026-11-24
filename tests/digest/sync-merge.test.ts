// The join of the Daily's per-device states (DG16, src/digest/sync/state.ts): whatever the order, the duplicates, the stale copies, the conflict copies or the partial files, every
// device that has seen the same facts shows the same edition. Property-style: many random histories, many random orders.
import { describe, expect, it } from "vitest";
import { applyChange, emptyState, joinAll, joinStates, parseState, projectEdition, setReg, storyIdFor, type EdState } from "../../src/digest/sync/state";
import type { EditionRec } from "../../src/digest/edition";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = <T,>(xs: readonly T[], r: () => number): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};
/** JSON with sorted keys: two equal facts compare equal whatever the order they were put in. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const facts = (s: EdState | null): unknown => (s ? { id: s.id, created: s.created, posts: s.posts, regs: s.regs, clock: s.clock } : null);
const POSTS = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(3, "0")}`);
const NAMES = ["World", "Local", "Arts", "Other"];

/** Devices work one after another on random subsets of what they have seen: each returns every version of its file along the way (stale copies included). */
function history(seed: number): { latest: EdState[]; all: EdState[] } {
  const r = rng(seed);
  const devs = ["devA", "devB", "devC"].slice(0, 2 + Math.floor(r() * 2));
  const own = new Map(devs.map((d) => [d, emptyState(100, d, d, 0)]));
  const all: EdState[] = [];
  const known = new Map<string, EdState[]>(devs.map((d) => [d, []]));
  for (let step = 0; step < 14 + Math.floor(r() * 12); step++) {
    const d = devs[Math.floor(r() * devs.length)] as string;
    const mine = own.get(d) as EdState;
    if (r() < 0.4) known.set(d, [...(known.get(d) ?? []), ...all.filter(() => r() < 0.5)]); // some files arrive
    const seen = joinStates([mine, ...(known.get(d) ?? [])]) as EdState;
    const counter = seen.clock + 1;
    const base = projectEdition(seen);
    if (!seen.created && r() < 0.8) {
      mine.created = { at: 1000 + Math.floor(r() * 5) * 10, d };
    }
    const next: EditionRec = base ? structuredClone(base) : { id: 100, createdAt: 1000, n: 1, stories: [], mixed: [], seen: {} };
    for (const p of POSTS) if (!(p in next.seen) && r() < 0.35) {
      next.seen[p] = 2000 + Math.floor(r() * 500);
      if (r() < 0.6) {
        const into = next.stories.length > 0 && r() < 0.5 ? next.stories[Math.floor(r() * next.stories.length)] : undefined;
        if (into) into.posts.push(p);
        else next.stories.push({ id: storyIdFor(p), posts: [p] });
      } else next.mixed.push(p);
    }
    for (const s of next.stories) if (r() < 0.25) s.section = NAMES[Math.floor(r() * NAMES.length)];
    if (r() < 0.3) next.sections = shuffle(NAMES, r);
    if (r() < 0.3) next.sectionAbout = { ...(next.sectionAbout ?? {}), [NAMES[Math.floor(r() * 3)] as string]: `about ${step}` };
    if (r() < 0.2) next.usage = { tokens: (next.usage?.tokens ?? 0) + 10, cost: 0.001 };
    const changed = applyChange(mine, base, next, counter);
    if (changed || r() < 0.3) all.push(structuredClone(mine));
  }
  return { latest: [...own.values()], all };
}

describe("the join of device states", () => {
  it("gives the same edition in any order, with duplicates, stale copies and conflict copies (200 random histories)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { latest, all } = history(seed);
      const target = joinStates(latest) as EdState;
      const want = canon([facts(target), projectEdition(target)]);
      const r = rng(seed * 7919);
      for (let k = 0; k < 6; k++) {
        const pool = [...latest, ...latest, ...all.filter(() => r() < 0.5)]; // twice the latest (a conflict copy), some older versions
        const got = joinStates(shuffle(pool, r)) as EdState;
        expect(canon([facts(got), projectEdition(got)])).toBe(want);
      }
    }
  });

  it("is idempotent and associative", () => {
    for (let seed = 300; seed < 360; seed++) {
      const { latest } = history(seed);
      const [a, b, c] = [latest[0] as EdState, latest[1] as EdState, (latest[2] ?? latest[0]) as EdState];
      const j = (...s: EdState[]): unknown => facts(joinStates(s));
      expect(j(a, a)).toEqual(j(a));
      expect(j(joinStates([a, b]) as EdState, c)).toEqual(j(a, joinStates([b, c]) as EdState));
      expect(j(joinStates([a, b]) as EdState, a)).toEqual(j(a, b));
    }
  });

  it("a device that has seen only part of the files shows less, and the missing file brings it to the same edition", () => {
    for (let seed = 400; seed < 440; seed++) {
      const { latest } = history(seed);
      const r = rng(seed);
      const some = latest.filter(() => r() < 0.6);
      const partial = joinStates(some);
      const full = joinStates([...some, ...latest]) as EdState;
      expect(facts(full)).toEqual(facts(joinStates(latest)));
      if (partial) for (const [k, p] of Object.entries(partial.posts)) expect(full.posts[k]).toBeLessThanOrEqual(p); // never later than a part says
    }
  });

  it("the creator is the lowest (time, device); a register is won by the higher counter, a tie by the larger device id", () => {
    const a = emptyState(5, "devA", "A", 0);
    const b = emptyState(5, "devB", "B", 0);
    a.created = { at: 50, d: "devA" };
    b.created = { at: 50, d: "devB" };
    setReg(a, "sec/x", "Old", 3);
    setReg(b, "sec/x", "New", 4);
    setReg(a, "order", ["A"], 7);
    setReg(b, "order", ["B"], 7);
    for (const order of [[a, b], [b, a]]) {
      const j = joinStates(order) as EdState;
      expect(j.created).toEqual({ at: 50, d: "devA" });
      expect(j.regs["sec/x"]?.v).toBe("New");
      expect(j.regs.order?.v).toEqual(["B"]);
    }
  });

  it("reads files defensively: partial, empty, foreign, wrong shapes and a hostile device name are ignored or cut, never thrown on", () => {
    const good = JSON.stringify(emptyState(5, "devA", "A", 0));
    expect(parseState(good)?.device).toBe("devA");
    for (const bad of ["", "{", good.slice(0, 20), "null", "[]", JSON.stringify({ v: 1, id: 5 }), JSON.stringify({ v: 2, id: "x", device: "devA" }), JSON.stringify({ v: 2, id: 5, device: "../evil" }), JSON.stringify({ v: 2, id: 5, device: "a b" })]) expect(parseState(bad)).toBeNull();
    const s = parseState(JSON.stringify({ v: 2, id: 5, device: "devA", posts: { a: 1, b: "x" }, regs: { k: { c: 1, d: "devA", v: 1 }, bad: { c: "x", d: "devA", v: 1 }, bad2: 5 }, clock: "no" }));
    expect(s?.posts).toEqual({ a: 1 });
    expect(Object.keys(s?.regs ?? {})).toEqual(["k"]);
    for (let cut = 0; cut < good.length; cut += 7) expect(() => parseState(good.slice(0, cut))).not.toThrow();
  });

  it("projects an edition that is robust to a register of the wrong kind", () => {
    const s = emptyState(5, "devA", "A", 0);
    s.created = { at: 1, d: "devA" };
    s.posts = { p1: 1, p2: 2, p3: 3 };
    s.regs = { "story/sx": { c: 1, d: "devA", v: 1 }, "place/p1": { c: 1, d: "devA", v: "sx" }, "place/p2": { c: 1, d: "devA", v: "sx" }, "place/p3": { c: 1, d: "devA", v: 42 }, "sec/sx": { c: 1, d: "devA", v: { no: 1 } }, "txt/sx": { c: 1, d: "devA", v: "nope" }, order: { c: 1, d: "devA", v: "x" }, "usage/devA": { c: 1, d: "devA", v: { tokens: "x" } } };
    const e = projectEdition(s) as EditionRec;
    expect(e.stories).toEqual([{ id: "sx", posts: ["p1", "p2"] }]);
    expect(e.mixed).toEqual(["p3"]);
    expect(e.sections).toBeUndefined();
    expect(e.usage).toBeUndefined();
  });

  it("a post placed in two stories by two devices ends in one of them, the same one everywhere; the other story is left with fewer posts, not duplicated", () => {
    const a = emptyState(5, "devA", "A", 0);
    const b = emptyState(5, "devB", "B", 0);
    a.created = { at: 1, d: "devA" };
    a.posts = { p1: 1, p2: 2, p3: 3 };
    b.posts = { p1: 1, p2: 2, p3: 3 };
    setReg(a, "story/X", 1, 1);
    for (const p of ["p1", "p2"]) setReg(a, `place/${p}`, "X", 1);
    setReg(b, "story/Y", 1, 2);
    for (const p of ["p2", "p3"]) setReg(b, `place/${p}`, "Y", 2);
    const e1 = projectEdition(joinStates([a, b]) as EdState) as EditionRec;
    const e2 = projectEdition(joinStates([b, a]) as EdState) as EditionRec;
    expect(e1).toEqual(e2);
    const all = e1.stories.flatMap((s) => s.posts);
    expect(new Set(all).size).toBe(all.length);
    expect(joinAll([a, b]).size).toBe(1);
  });

  it("story ids come from content: the same oldest post gives the same id, and they differ between posts", () => {
    expect(storyIdFor("p1")).toBe(storyIdFor("p1"));
    expect(new Set(POSTS.map(storyIdFor)).size).toBe(POSTS.length);
  });
});
