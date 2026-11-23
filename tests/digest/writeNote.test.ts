import { describe, expect, it } from "vitest";
import { nothingToWriteNote } from "../../src/digest/writeNote";
import type { Written } from "../../src/digest/llm";

const w = (fresh?: string[]): Written => ({ headline: "h", summary: "s", model: "m", posts: 2, ...(fresh ? { fresh } : {}) });

describe("the note after a Write that had nothing to send", () => {
  it("no stories with several posts: says so and counts the single posts", () => {
    expect(nothingToWriteNote({ status: "nothing-to-send" }, [], 0, 3)).toBe("Nothing to write. 3 single posts are in the Mixed bag; they get no AI text.");
    expect(nothingToWriteNote({ status: "nothing-to-send" }, [], 0, 0)).toBe("Nothing to write. There are no stories with several posts yet.");
  });
  it("everything cached: says it is written, and mentions singles added since", () => {
    expect(nothingToWriteNote({ status: "ok" }, [w(), w([])], 2, 0)).toBe("Everything is already written.");
    expect(nothingToWriteNote({ status: "ok" }, [w()], 1, 1)).toBe("Everything is already written. 1 single post is in the Mixed bag; it gets no AI text.");
  });
  it("says nothing when a run really wrote something, or has its own note", () => {
    expect(nothingToWriteNote({ status: "ok" }, [w(), null], 2, 0)).toBe("");
    expect(nothingToWriteNote({ status: "ok" }, [w(["x"])], 1, 0)).toBe(""); // an updated story was re-written
    expect(nothingToWriteNote({ status: "cancelled", note: "Nothing was sent." }, [], 1, 0)).toBe("");
  });
});
