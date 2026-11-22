import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSizeCaps, lineCount } from "../../scripts/size-caps.mjs";

const root = join(__dirname, "..", "..");

describe("size caps (scripts/size-caps.json)", () => {
  it("main.ts and ReaderView.ts are within their caps", () => {
    const caps = JSON.parse(readFileSync(join(root, "scripts", "size-caps.json"), "utf8")) as Record<string, number>;
    expect(Object.keys(caps).sort()).toEqual(["src/main.ts", "src/ui/ReaderView.ts"]);
    expect(checkSizeCaps(caps, (f) => readFileSync(join(root, f), "utf8"))).toEqual([]);
  });
  it("counts lines like wc -l", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
  });
  it("a file over its cap fails and says where the code goes; one under it passes", () => {
    expect(checkSizeCaps({ "a.ts": 2 }, () => "1\n2\n3\n")[0]).toMatch(/a\.ts has 3 lines, over its cap of 2.*own module/);
    expect(checkSizeCaps({ "a.ts": 5 }, () => "1\n2\n3\n")).toEqual([]);
    expect(checkSizeCaps({ "a.ts": 3 }, () => "1\n2\n3\n")).toEqual([]);
  });
});
