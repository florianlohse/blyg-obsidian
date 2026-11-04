import { describe, expect, it } from "vitest";
import { createDataWatch } from "../../src/app/dataWatch";

function setup(initial: number | null = 100) {
  const state = { mtime: initial, visible: true, redraws: 0, fail: false, stats: 0 };
  const watch = createDataWatch({
    modified: () => {
      state.stats += 1;
      return state.fail ? Promise.reject(new Error("no")) : Promise.resolve(state.mtime);
    },
    panelVisible: () => state.visible,
    redraw: () => void (state.redraws += 1),
  });
  return { state, watch };
}

describe("data.json watch", () => {
  it("the first look only notes the file; it redraws when the file changes afterwards, once per change", async () => {
    const { state, watch } = setup();
    await watch.look();
    expect(state.redraws).toBe(0);
    await watch.look();
    expect(state.redraws).toBe(0);
    state.mtime = 200; // Sync brought in a changed copy
    await watch.look();
    await watch.look();
    expect(state.redraws).toBe(1);
  });

  it("does not even look while the panel is not on screen, and catches up when it is", async () => {
    const { state, watch } = setup();
    await watch.look();
    state.visible = false;
    state.mtime = 300;
    await watch.look();
    expect(state.stats).toBe(1);
    expect(state.redraws).toBe(0);
    state.visible = true;
    await watch.look();
    expect(state.redraws).toBe(1);
  });

  it("a file that appears or disappears counts as a change; one that cannot be read does not", async () => {
    const { state, watch } = setup(null);
    await watch.look();
    state.mtime = 5;
    await watch.look();
    expect(state.redraws).toBe(1);
    state.fail = true;
    await watch.look();
    expect(state.redraws).toBe(1);
    state.fail = false;
    state.mtime = null;
    await watch.look();
    expect(state.redraws).toBe(2);
  });

  it("coming back to the foreground redraws whatever the file did", () => {
    const { state, watch } = setup();
    watch.returned();
    expect(state.redraws).toBe(1);
  });
});
