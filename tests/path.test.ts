import { describe, expect, it } from "vitest";
import { getPath, setPath } from "../src/settings/path";

describe("settings key paths", () => {
  const make = () => ({ a: { b: "x" }, list: [{ n: 1 }, { n: 2 }] });

  it("reads nested values and array elements", () => {
    expect(getPath(make(), "a.b")).toBe("x");
    expect(getPath(make(), "list.1.n")).toBe(2);
    expect(getPath(make(), "a.missing")).toBeUndefined();
    expect(getPath(make(), "nope.deeper")).toBeUndefined();
  });

  it("writes only where the parents already exist", () => {
    const o = make();
    expect(setPath(o, "a.b", "y")).toBe(true);
    expect(setPath(o, "list.0.n", 9)).toBe(true);
    expect(setPath(o, "a.newKey", "z")).toBe(true);
    expect(o).toEqual({ a: { b: "y", newKey: "z" }, list: [{ n: 9 }, { n: 2 }] });
    expect(setPath(o, "nope.deeper", 1)).toBe(false);
    expect(setPath(o, "a.b.c", 1)).toBe(false);
  });

  it("refuses prototype-polluting and malformed keys", () => {
    const o = make();
    for (const key of ["__proto__.polluted", "a.__proto__.polluted", "constructor.prototype.x", "a..b", "", ".a"]) {
      expect(setPath(o, key, "bad")).toBe(false);
      expect(getPath(o, key)).toBeUndefined();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not read inherited properties", () => {
    expect(getPath({}, "toString")).toBeUndefined();
  });
});
