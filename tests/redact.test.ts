import { describe, expect, it } from "vitest";
import { redact, redactingLogger, REDACTED } from "../src/platform/redact";
import { TOKEN } from "./helpers";

describe("redact", () => {
  it("removes a known secret wherever it appears", () => {
    expect(redact(`failed with ${TOKEN} twice ${TOKEN}`, [TOKEN])).toBe(`failed with ${REDACTED} twice ${REDACTED}`);
  });

  it("removes token-shaped strings and Authorization values even when the secret is not given", () => {
    expect(redact("x ghp_abcdefghijklmnopqrstuvwxyz0123 y")).toBe(`x ${REDACTED} y`);
    expect(redact("github_pat_11ABCDEFG0abcdefghijklmnopqrstuv")).toBe(REDACTED);
    expect(redact("Authorization: Bearer abc123def456ghi")).toBe(`Authorization: ${REDACTED}`);
  });

  it("leaves ordinary text and very short 'secrets' alone", () => {
    expect(redact("Repository not found", ["ab"])).toBe("Repository not found");
  });

  it("is applied by the logger", () => {
    const lines: string[] = [];
    const log = redactingLogger((l) => lines.push(l), () => [TOKEN]);
    log.debug(`GET with ${TOKEN}`);
    log.warn(`oops ${TOKEN}`);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines).toHaveLength(2);
  });

  it("removes a Studio token (JWT shape) even when the secret is not given", () => {
    const jwt = ["eyJ0eXAiOiJhdCtqd3QiLCJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJvd25lciIsInNjb3BlIjoib3duZXI6cmVhZCJ9", "c2ln-nature_part"].join(".");
    expect(redact(`GET failed for ${jwt} at once`)).toBe(`GET failed for ${REDACTED} at once`);
    expect(redact(`header was Authorization: Bearer ${jwt}`)).not.toContain("eyJ");
  });
});
