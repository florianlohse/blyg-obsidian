// Which Studios get `tangle`: contract 5.12.0 (Studio 0.63.0, where tangling first shipped) and every contract 6. Older 5.x keeps the refusal.
import { describe, expect, it } from "vitest";
import { M } from "../../src/publish/messages";
import { studioAddress } from "../../src/studio/address";
import { createStudioClient } from "../../src/studio/client";
import { createStudioHttp } from "../../src/studio/http";
import { idleTimers } from "../helpers";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./fake-studio";
import { makeStudioWorld, tapStudio } from "./world";

async function supported(contract: string): Promise<boolean> {
  const studio = new FakeStudio();
  studio.contractVersion = contract;
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("address");
  const client = createStudioClient({ http: createStudioHttp({ transport: studio.transport, timers: idleTimers, address }), token: STUDIO_TOKEN });
  return client.tangleSupported();
}

describe("tangleSupported by the announced contract", () => {
  it.each([
    ["5.2.0", false],
    ["5.11.0", false],
    ["5.11.9", false],
    ["5.12.0", true],
    ["5.14.0", true],
    ["6.0.0", true],
    ["6.2.0", true],
  ])("%s → %s", async (contract, expected) => {
    expect(await supported(contract)).toBe(expected);
  });
});

describe("publishing a thread with a span", () => {
  const NOTE = "studio/Thread.md";
  const BODY = "---\nblyg_kind: thread\n---\nIntro.\n\n![[+ a passage that becomes its own item]]\n";
  it("a Studio of contract 5.12 makes the item (the fake takes the contract from its announcement)", async () => {
    const w = makeStudioWorld({ tangle: true, coldGate: true, vault: { [NOTE]: BODY } });
    w.studio.contractVersion = "5.12.0"; // a cold gate: the client asks the Studio which contract it speaks
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("published");
    expect(w.studio.tangledItems).toHaveLength(1);
  });
  it("a Studio of contract 5.11 is refused before anything is sent, with the contract named", async () => {
    const w = makeStudioWorld({ tangle: true, coldGate: true, vault: { [NOTE]: BODY } });
    w.studio.contractVersion = "5.11.0";
    const out = await tapStudio(w, NOTE);
    expect(out.status).toBe("refused");
    expect(out.notices.join(" ")).toBe(M.tangleUnsupported);
    expect(out.notices.join(" ")).toMatch(/5\.12/);
    expect(w.studio.seen.filter((s) => s.method !== "GET")).toEqual([]);
    expect(w.studio.seen.some((s) => s.path === "/api/capabilities")).toBe(true);
  });
});
