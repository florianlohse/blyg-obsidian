import { describe, expect, it } from "vitest";
import { redactJson, redactText } from "../e2e/obsidian/artifacts.mjs";
import { escapeAnnotation, failedChecks, failedChecksBlock, flakyNotes, summaryMarkdown, type Row } from "../e2e/obsidian/report.mjs";

describe("failure artifacts never carry a secret", () => {
  const token = "abcdef1234567890SECRETVALUE";
  const jwt = ["eyJ0eXAiOiJhdCtqd3QifQ", "eyJzdWIiOiJvd25lciJ9", "c2lnbmF0dXJlYWJj"].join("."); // built at run time: a literal one trips the leak scan
  it("redacts the run's token, JWTs, bearer values and authorization headers in text", () => {
    const out = redactText(`GET /x with ${token}; Authorization: Bearer ${jwt}\ncookie=session123456 api_key: "k-123456789"`, [token]);
    expect(out).not.toContain(token);
    expect(out).not.toContain("eyJ0eXAi");
    expect(out).not.toContain("session123456");
    expect(out).not.toContain("k-123456789");
  });
  it("redacts the value of secret-named keys in JSON and keeps the rest", () => {
    const out = JSON.stringify(redactJson({ studio: { url: "http://localhost:8787", tokenName: "smoke-studio", apiKey: "zzz", nested: [{ password: "p" }] }, note: `x ${token}` }, [token]));
    expect(out).toContain("http://localhost:8787");
    expect(out).not.toContain("smoke-studio");
    expect(out).not.toContain("zzz");
    expect(out).not.toContain(token);
  });
});

describe("the end-of-run report", () => {
  const rows: Row[] = [
    { name: "a", attempts: [{ attempt: 1, code: 0, failures: [], seconds: 10 }] },
    { name: "b", attempts: [{ attempt: 1, code: 1, failures: ["first thing | pipe", "second thing"], seconds: 20 }, { attempt: 2, code: 0, failures: [], seconds: 21 }] },
    { name: "c", attempts: [{ attempt: 1, code: 1, failures: ["bad"], seconds: 5 }, { attempt: 2, code: 1, failures: [], seconds: 6 }] },
  ];
  it("lists every failing check with scenario and attempt, and says when an attempt reported none", () => {
    const list = failedChecks(rows);
    expect(list.map((f) => `${f.scenario}/${f.attempt}`)).toEqual(["b/1", "b/1", "c/1", "c/2"]);
    expect(failedChecksBlock(list)).toContain("[b, attempt 1] first thing | pipe");
    expect(failedChecksBlock(list)).toContain("exited with code 1");
    expect(failedChecksBlock([])).toBe("");
  });
  it("says plainly that a scenario passed only on the retry", () => {
    expect(flakyNotes(rows)).toEqual([{ scenario: "b", text: "FLAKY: passed on retry; first attempt failed with: first thing | pipe" }]);
    expect(summaryMarkdown(rows)).toContain("FLAKY: passed on retry; first attempt failed with: first thing \\| pipe".replace("\\|", "|"));
  });
  it("escapes annotation text", () => {
    expect(escapeAnnotation("a%b\nc")).toBe("a%25b%0Ac");
  });
});
