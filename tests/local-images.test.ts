import { describe, expect, it } from "vitest";
import { showLocalImages } from "../src/ui/localImages";

const img = (src: string | null) => {
  const attrs = new Map<string, string>(src === null ? [] : [["src", src]]);
  return { getAttribute: (n: string) => attrs.get(n) ?? null, setAttribute: (n: string, v: string) => void attrs.set(n, v), attrs };
};
const rootOf = (...imgs: ReturnType<typeof img>[]) => ({ querySelectorAll: (sel: string) => (sel === "img" ? imgs : []) });

const STAND_IN = "https://studio.test/media/pending/abc.png";

describe("showLocalImages", () => {
  it("puts the vault's file in place of a stand-in the plugin made", () => {
    const a = img(STAND_IN);
    expect(showLocalImages(rootOf(a), [{ src: STAND_IN, path: "studio/door.png" }], (p) => `app://local/${p}`)).toBe(1);
    expect(a.attrs.get("src")).toBe("app://local/studio/door.png");
  });

  it("leaves every other address alone, a look-alike included", () => {
    const foreign = img("https://elsewhere.test/media/pending/abc.png");
    const near = img(`${STAND_IN}?x=1`);
    const none = img(null);
    expect(showLocalImages(rootOf(foreign, near, none), [{ src: STAND_IN, path: "studio/door.png" }], () => "app://x")).toBe(0);
    expect(foreign.attrs.get("src")).toBe("https://elsewhere.test/media/pending/abc.png");
    expect(near.attrs.get("src")).toBe(`${STAND_IN}?x=1`);
    expect(none.attrs.has("src")).toBe(false);
  });

  it("keeps the stand-in when the file is gone", () => {
    const a = img(STAND_IN);
    expect(showLocalImages(rootOf(a), [{ src: STAND_IN, path: "gone.png" }], () => null)).toBe(0);
    expect(a.attrs.get("src")).toBe(STAND_IN);
  });

  it("handles the same picture twice and several pictures", () => {
    const other = "https://studio.test/media/pending/def.jpg";
    const a = img(STAND_IN), b = img(STAND_IN), c = img(other);
    const n = showLocalImages(rootOf(a, b, c), [{ src: STAND_IN, path: "one.png" }, { src: other, path: "two.jpg" }], (p) => `app://${p}`);
    expect(n).toBe(3);
    expect([a, b, c].map((x) => x.attrs.get("src"))).toEqual(["app://one.png", "app://one.png", "app://two.jpg"]);
  });
});
