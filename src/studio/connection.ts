// "Check connection" for the Studio: read-only. Is the address a Studio, is it a release this plugin was tested with, does the token
// work and for how long, and does it carry the permissions publishing needs. Makes GET requests only; the report never contains the token.
import type { CheckLine, ConnectionReport } from "../github/connection";
import { HttpError, type RawTransport } from "../platform/http";
import type { Clock, Keychain, Logger, Timers } from "../platform/ports";
import { readToken } from "../platform/token";
import { studioAddress, studioBaseProblem, studioMountProblem } from "./address";
import { createStudioClient, type ContractCache } from "./client";
import { createStudioHttp } from "./http";
import { expiryVerdict, tokenScopes } from "./jwt";
import { sameOrigin } from "./record";
import type { StudioFailure } from "./types";
import { contractVerdict, newerMinorNote, incompatibleMessage, studioVersionVerdict } from "./version";

/** What publishing needs: read (the item and the preview's reads), draft (create, edit, preview) and publish (publish, withdraw). */
export const NEEDED_SCOPES = ["owner:read", "owner:draft", "owner:publish"] as const;

function describe(f: StudioFailure): string {
  switch (f.kind) {
    case "unauthorized":
      return "The Studio rejected the token (wrong, expired or revoked). In the Studio: More → Client access → create a REST token, and paste it into the keychain entry.";
    case "forbidden":
      return "The token is not allowed to read items: it needs the permission owner:read.";
    case "not-found":
      return "The Studio has no such address (404). Check the address and the mount.";
    case "conflict":
      return "The Studio reported a revision conflict (unexpected for a read).";
    case "incompatible":
      return f.message;
    case "rejected":
    case "error":
      return `The Studio answered ${f.status}${f.message ? `: ${f.message}` : ""}.`;
  }
}

export async function checkStudioConnection(
  deps: { transport: RawTransport; timers: Timers; keychain: Keychain; clock: Clock; logger?: Logger; gate?: ContractCache },
  settings: { baseUrl: string; mount: string; tokenSecretName: string },
): Promise<ConnectionReport> {
  const fail = (text: string): ConnectionReport => ({ ok: false, lines: [{ level: "error", text }] });
  if (settings.baseUrl === "") return fail("Enter the Studio's address first.");
  const baseProblem = studioBaseProblem(settings.baseUrl);
  if (baseProblem) return fail(`Studio address: ${baseProblem}`);
  const mountProblem = studioMountProblem(settings.mount);
  if (mountProblem) return fail(`Studio mount: ${mountProblem}`);
  const address = studioAddress(settings);
  if (!address) return fail("The Studio address is not usable.");
  const tokenResult = readToken(deps.keychain, settings.tokenSecretName, "Studio");
  if (!tokenResult.ok) return fail(tokenResult.message);
  const { token } = tokenResult;

  const lines: CheckLine[] = [];
  try {
    const http = createStudioHttp({ transport: deps.transport, timers: deps.timers, address, ...(deps.logger ? { logger: deps.logger } : {}) });
    const client = createStudioClient({ http, token });

    const manifest = await client.manifest();
    if (manifest.kind !== "ok") return { ok: false, lines: [{ level: "error", text: `${address.origin}blyg.json: ${describe(manifest)}` }] };
    lines.push({ level: "ok", text: `Reachable: ${manifest.value.title || address.host} (protocol ${manifest.value.protocol}).` });

    const verdict = studioVersionVerdict(manifest.value.generator);
    if (verdict.kind === "unknown-client") {
      lines.push({ level: "warn", text: `The address does not announce a Blygger Studio (“${verdict.generator}”). The plugin only knows Studio's owner API.` });
    }

    // The gate (S16): the API contract the Studio announces decides whether the plugin writes to it at all.
    const caps = await client.capabilities();
    deps.gate?.set(undefined);
    const studioName = verdict.kind === "stock" ? `Studio ${verdict.version}` : "The Studio";
    if (caps.kind === "not-found") {
      lines.push({ level: "error", text: `${incompatibleMessage("studio-older")} (It does not announce an API contract.)` });
      return { ok: false, lines };
    }
    if (caps.kind !== "ok") {
      lines.push({ level: "error", text: describe(caps) });
      return { ok: false, lines };
    }
    const contract = contractVerdict(caps.value.contractVersion);
    deps.gate?.set(contract);
    if (contract.kind === "ok") {
      lines.push({ level: "ok", text: `${studioName}, contract ${contract.contract}: the API this plugin speaks.` });
      if (contract.newerMinor) lines.push({ level: "info", text: newerMinorNote(contract.contract) });
    } else {
      lines.push({ level: "error", text: `${studioName}${contract.contract ? `, contract ${contract.contract}` : ""}: ${incompatibleMessage(contract.kind)}` });
      return { ok: false, lines };
    }
    if (manifest.value.site !== "" && !sameOrigin(manifest.value.site, address.origin)) {
      lines.push({ level: "warn", text: `The Studio says it lives at ${manifest.value.site}, but the settings say ${address.origin}. Notes are stamped with the settings' address: make them agree.` });
    }

    const expiry = expiryVerdict(token, deps.clock.now());
    if (expiry.kind === "expired") lines.push({ level: "error", text: "The token has expired. Create a new one in the Studio (More → Client access)." });
    else if (expiry.kind === "soon") lines.push({ level: "warn", text: `The token expires in ${expiry.days} day${expiry.days === 1 ? "" : "s"}. Create a new one in the Studio and paste it into the keychain entry.` });
    else if (expiry.kind === "ok") lines.push({ level: "ok", text: `The token is valid for ${expiry.days} more days.` });

    const scopes = tokenScopes(token);
    if (scopes) {
      const missing = NEEDED_SCOPES.filter((s) => !scopes.includes(s));
      if (missing.length > 0) lines.push({ level: "error", text: `The token lacks ${missing.join(", ")}. Publishing needs ${NEEDED_SCOPES.join(", ")}.` });
      else lines.push({ level: "ok", text: "The token has the permissions publishing needs." });
      // Hoppers (S13) need owner:manage; without it everything else works, so this is a note, not a fault.
      if (scopes.includes("owner:manage")) lines.push({ level: "ok", text: "The token may change hoppers (owner:manage)." });
      else lines.push({ level: "warn", text: "The token cannot change hoppers: that needs owner:manage. Publishing works without it." });
    }

    const counted = await client.countItems();
    if (counted.kind !== "ok") lines.push({ level: "error", text: describe(counted) });
    else lines.push({ level: "ok", text: `The token works: the Studio holds ${counted.value} item${counted.value === 1 ? "" : "s"}.` });

    return { ok: lines.every((l) => l.level !== "error"), lines };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : "Unexpected error while contacting the Studio.";
    return { ok: false, lines: [...lines, { level: "error", text: message }] };
  }
}
