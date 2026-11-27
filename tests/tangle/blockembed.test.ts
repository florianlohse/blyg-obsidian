// A block embed (`![[Note#^id]]`) in a thread is an ordinary embed of something that is not a whole item: refused with the "embed form" words, with the
// feature `tangle` on or off. The plugin has no paragraph publishing; this pins that.
import { describe, expect, it } from "vitest";
import { prepareStudioText } from "../../src/studio/text";
import { makeStudioWorld } from "../studio/world";

const ctx = { vault: makeStudioWorld().deps.vault, routes: [], fromPath: "studio/T.md", origin: "https://studio.test/", fragmentCharCap: 1000 };

describe("a block embed in a thread", () => {
  for (const tangle of [false, true]) {
    it(`is refused as an embed that is not a whole note (tangle ${tangle ? "on" : "off"})`, () => {
      const draft = prepareStudioText("My view.\n\n![[Other note#^ab12]]\n\nMore.", "thread", { ...ctx, tangle });
      expect(draft.problems.length).toBeGreaterThan(0);
      expect(draft.tangle).toEqual([]);
      expect(draft.problems.map((p) => p.kind)).toContain("embeds");
      expect(draft.problems[0]).toEqual({ kind: "embeds", list: ["line 3: ![[Other note#^ab12]]"] }); // the same refusal the plugin gave before paragraph publishing existed
    });
  }
});
