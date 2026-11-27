// The month's digest cost ("Digest billing this month" in the Daily's menu): each device keeps the estimated dollars of its AI writes per local day in a register inside its own synced key
// (`digestSync_<deviceId>`, the newest 62 days, numbers only), and the total is the sum of all devices' registers for the current calendar month. The hazards: a wrong figure (an unreadable
// register must give NO figure), a register that grows without bound, a device that drops another device's register, and anything but numbers in the key.
process.env.TZ = "Europe/Berlin";
import { describe, expect, it } from "vitest";
import { COST_DAYS, boundCost, buildPayload, keyOf, parseCost, readKeys } from "../../src/digest/sync/dataKey";
import { emptyState } from "../../src/digest/sync/state";
import { DataJson, T0, device, mkPost, provider, world } from "./sync-harness";

const DAY = 24 * 3600_000;
const pair = () => {
  const prov = provider();
  const da = new DataJson();
  const db = new DataJson();
  const a = device("devAaaa", "iPhone", prov, T0, { data: da });
  const b = device("devBbbb", "iPad", prov, T0 + 3600_000, { data: db });
  return { da, db, a, b };
};

describe("the cost register in a device's key", () => {
  it("is parsed defensively: older keys have none, bad shapes are unreadable, only the newest 62 days stay", () => {
    expect(parseCost(undefined)).toEqual({});
    expect(parseCost({ "2030-03-12": 0.25 })).toEqual({ "2030-03-12": 0.25 });
    for (const bad of [null, [], "x", { "2030-03-12": "0.2" }, { "2030-3-12": 0.2 }, { "2030-03-12": -1 }, { "2030-03-12": Number.NaN }]) expect(parseCost(bad), JSON.stringify(bad)).toBeNull();
    const many: Record<string, number> = {};
    for (let i = 0; i < 100; i++) many[new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10)] = 0.01;
    const kept = Object.keys(boundCost(many));
    expect(kept).toHaveLength(COST_DAYS);
    expect(kept).toContain("2030-04-10"); // the newest day is kept
    expect(kept).not.toContain("2030-01-01"); // the oldest is dropped
  });
  it("goes into the payload only when it is not empty, and stays a small object of numbers (about 1.5 KB for 62 days)", () => {
    const eds = [emptyState(1 * DAY, "devAaaa", "iPhone", 1)];
    expect(buildPayload(eds, "devAaaa")?.payload.cost).toBeUndefined();
    const reg: Record<string, number> = {};
    for (let i = 0; i < 62; i++) reg[new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10)] = 0.123456;
    const withCost = buildPayload(eds, "devAaaa", reg);
    const without = buildPayload(eds, "devAaaa");
    expect(Object.keys(withCost?.payload.cost ?? {})).toHaveLength(62);
    expect((withCost?.bytes ?? 0) - (without?.bytes ?? 0)).toBeLessThan(2000);
  });
});

describe("the month's total", () => {
  it("sums every device's register for the current calendar month, and nothing from other months", async () => {
    const { a, b, da, db } = pair();
    const w = world();
    await a.editions.open(w.items);
    await b.editions.open(w.items);
    await a.sync.addCost(T0, 0.1);
    await a.sync.addCost(T0, 0.05); // the same day adds up
    await a.sync.addCost(T0 - 20 * DAY, 9); // an earlier month: not counted
    await b.sync.addCost(T0 + 2 * DAY, 0.2);
    da.arrive(db, "devBbbb");
    db.arrive(da, "devAaaa");
    expect(await a.sync.monthCost(T0)).toBeCloseTo(0.35, 6);
    expect(await b.sync.monthCost(T0)).toBeCloseTo(0.35, 6); // every device sees the same total
    expect(await a.sync.monthCost(T0 - 20 * DAY)).toBeCloseTo(9, 6); // and the other month has its own
  });
  it("keeps the register in the device's OWN key, never touching another device's key, and holds only numbers", async () => {
    const { a, b, da, db } = pair();
    const w = world();
    await a.editions.open(w.items);
    await b.editions.open(w.items);
    await b.sync.addCost(T0, 0.4);
    da.arrive(db, "devBbbb");
    const before = JSON.stringify(da.json[keyOf("devBbbb")]);
    await a.sync.addCost(T0, 0.1);
    expect(JSON.stringify(da.json[keyOf("devBbbb")])).toBe(before); // B's key is as it arrived
    const own = da.json[keyOf("devAaaa")] as { cost?: Record<string, unknown> };
    expect(Object.values(own.cost ?? {}).every((n) => typeof n === "number")).toBe(true);
    expect(JSON.stringify(own.cost)).not.toMatch(/[A-Za-z]{3,}/); // no text of any kind in the register
    expect(readKeys(da.json).find((k) => k.device === "devAaaa")?.cost).toEqual({ "2030-03-12": 0.1 });
  });
  it("is not shown (null) when it cannot be read: a register that does not parse, no settings file, a damaged data.json", async () => {
    const { a, b, da, db } = pair();
    const w = world();
    await a.editions.open(w.items);
    await b.editions.open(w.items);
    await a.sync.addCost(T0, 0.1);
    await b.sync.addCost(T0, 0.1);
    da.arrive(db, "devBbbb");
    expect(await a.sync.monthCost(T0)).not.toBeNull();
    const k = keyOf("devBbbb");
    da.text = JSON.stringify({ ...da.json, [k]: { ...(da.json[k] as object), cost: { "2030-03-12": "free" } } });
    expect(await a.sync.monthCost(T0)).toBeNull(); // a wrong figure is worse than none
    da.text = "{ not json";
    expect(await a.sync.monthCost(T0)).toBeNull();
    const lone = device("devCccc", "x", provider(), T0); // no data.json transport
    await lone.sync.addCost(T0, 1);
    expect(await lone.sync.monthCost(T0)).toBeNull();
  });
  it("ignores a cost that is not a positive number, and never loses an addition to an older read", async () => {
    const { a, da } = pair();
    await a.editions.open(world().items);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) await a.sync.addCost(T0, bad);
    expect(await a.sync.monthCost(T0)).toBe(0);
    await a.sync.addCost(T0, 0.3);
    da.text = JSON.stringify({ ...da.json, [keyOf("devAaaa")]: { ...(da.json[keyOf("devAaaa")] as object), cost: {} } }); // a stale copy of the key arrives
    expect(await a.sync.monthCost(T0)).toBeCloseTo(0.3, 6); // what this device added is kept in memory
    expect(mkPost("x").remoteId).toBeTruthy();
  });
});
