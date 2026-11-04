import { describe, expect, it } from "vitest";
import { createDeployMemory } from "../../src/app/deployMemory";
import type { PanelDeploy } from "../../src/app/panelState";

const done = (path: string | undefined, version: number): PanelDeploy => ({
  phase: "done",
  branch: "preview",
  version,
  ...(path ? { path } : {}),
  kind: "deployed",
  text: "",
  attention: false,
  at: new Date(0),
});

describe("deploy memory", () => {
  it("keeps the result of each file, so a second quick publish does not erase the first note's verdict (T0 test 5)", () => {
    const memory = createDeployMemory();
    memory.set("a.md", done("a.md", 1));
    memory.set("b.md", { phase: "watching", branch: "preview", path: "b.md" });
    expect(memory.get("a.md")).toMatchObject({ phase: "done", version: 1 });
    expect(memory.get("b.md")).toMatchObject({ phase: "watching" });
  });

  it("a newer publish of the same file replaces that file's result, and only that one", () => {
    const memory = createDeployMemory();
    memory.set("a.md", done("a.md", 1));
    memory.set("b.md", done("b.md", 4));
    memory.set("a.md", done("a.md", 2));
    expect(memory.get("a.md")).toMatchObject({ version: 2 });
    expect(memory.get("b.md")).toMatchObject({ version: 4 });
  });

  it("knows nothing of a file that was never published, and forgets on request", () => {
    const memory = createDeployMemory();
    expect(memory.get("c.md")).toBeNull();
    memory.set("c.md", done("c.md", 1));
    memory.forget("c.md");
    expect(memory.get("c.md")).toBeNull();
    memory.forget("never.md");
  });

  it("a result that names no file belongs to every note, but a note's own result wins", () => {
    const memory = createDeployMemory();
    memory.set(undefined, done(undefined, 9));
    expect(memory.get("any.md")).toMatchObject({ version: 9 });
    memory.set("a.md", done("a.md", 1));
    expect(memory.get("a.md")).toMatchObject({ version: 1 });
  });

  it("is bounded: a long session forgets its oldest files first", () => {
    const memory = createDeployMemory();
    for (let i = 0; i < 40; i++) memory.set(`n${i}.md`, done(`n${i}.md`, i));
    expect(memory.get("n0.md")).toBeNull();
    expect(memory.get("n9.md")).toBeNull();
    expect(memory.get("n10.md")).toMatchObject({ version: 10 });
    expect(memory.get("n39.md")).toMatchObject({ version: 39 });
  });
});
