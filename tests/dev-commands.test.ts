import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ FuzzySuggestModal: class { setPlaceholder() {} }, Modal: class {}, Notice: class {}, setIcon: () => {} }));

import { BENCH_SIZES, registerDevCommands, timingSentence } from "../src/dev/drawBench";

const plugin = (id: string) => {
  const commands: Array<{ id: string; name: string }> = [];
  return { commands, p: { manifest: { id }, app: {}, addCommand: (c: { id: string; name: string }) => commands.push(c) } as never };
};

describe("the development build's timing command", () => {
  it("is registered in the development build only", () => {
    const dev = plugin("blyg-dev");
    registerDevCommands(dev.p);
    expect(dev.commands.map((c) => c.id)).toEqual(["dev-draw-synthetic-posts"]);
    const release = plugin("blyg");
    registerDevCommands(release.p);
    expect(release.commands).toEqual([]);
  });
  it("offers the sizes asked for (1000 and 5000 among them)", () => {
    expect(BENCH_SIZES).toContain(1000);
    expect(BENCH_SIZES).toContain(5000);
  });
  it("says its numbers in one sentence", () => {
    expect(timingSentence({ count: 1000, generateMs: 12.4, buildMs: 300.2, layoutMs: 80.6, frameMs: 40, elements: 9000 })).toBe("1000 cards, 9000 elements: 421 ms in all (build 300, layout 81, first frame 40); making the posts 12 ms.");
  });
});
