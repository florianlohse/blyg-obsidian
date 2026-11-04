import { describe, expect, it } from "vitest";
import { readToken } from "../src/platform/token";
import { fakeKeychain, TOKEN } from "./helpers";

describe("readToken", () => {
  it("returns the token from the keychain", () => {
    expect(readToken(fakeKeychain({ "my-entry": TOKEN }), "my-entry")).toEqual({ ok: true, token: TOKEN });
  });

  it("has no plaintext fallback when the keychain is unavailable", () => {
    const r = readToken(fakeKeychain({ "my-entry": TOKEN }, false), "my-entry");
    expect(r).toMatchObject({ ok: false, reason: "keychain-unavailable" });
  });

  it("says so when no entry was chosen or the entry is empty on this device", () => {
    expect(readToken(fakeKeychain({}), "")).toMatchObject({ ok: false, reason: "no-secret-name" });
    expect(readToken(fakeKeychain({}), "gone")).toMatchObject({ ok: false, reason: "secret-missing" });
    expect(readToken(fakeKeychain({ blank: "  " }), "blank")).toMatchObject({ ok: false, reason: "secret-missing" });
  });

  it("never puts a token into a failure message", () => {
    const r = readToken(fakeKeychain({ other: TOKEN }), "missing");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
