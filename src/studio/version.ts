// Which Studio this plugin speaks to. Since S16 (docs/plans/S16-contract-5.md) the gate is the API contract the Studio announces in
// `GET /api/capabilities` (`contractVersion`), not the release number: one hard cutover, no support for older contracts.
// The manifest's `generator` is only used to tell a stock Studio from a fork or another program.

/** The contract this plugin was built and tested against (Studio 0.51.0 announces 5.2.0). Minors are additive; a higher minor is accepted. */
export const CONTRACT = { major: 5, minor: 2 } as const;
/** "5.2": for messages. */
export const CONTRACT_TEXT = `${CONTRACT.major}.${CONTRACT.minor}`;
/** The first Studio release that speaks it. */
export const MIN_STUDIO_VERSION = "0.51.0";

export type ContractVerdict =
  /** Supported. `newerMinor`: the Studio announces a higher minor than the plugin was built against (shown, not refused). */
  | { kind: "ok"; contract: string; newerMinor: boolean }
  /** An older contract, or no `/capabilities` at all (a Studio before 0.49.7): every Studio write is refused. */
  | { kind: "studio-older"; contract: string | null }
  /** A newer major: the plugin is the old one. */
  | { kind: "plugin-older"; contract: string };

/** `contractVersion` as the Studio announces it ("5.2.0"), or null when there is none or it is not major.minor.patch. */
export function contractVerdict(version: string | null): ContractVerdict {
  const match = version === null ? null : /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return { kind: "studio-older", contract: null };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const contract = `${match[1]}.${match[2]}.${match[3]}`;
  if (major < CONTRACT.major) return { kind: "studio-older", contract };
  if (major > CONTRACT.major) return { kind: "plugin-older", contract };
  return { kind: "ok", contract, newerMinor: minor > CONTRACT.minor };
}

/** The sentence for a refused Studio. */
export function incompatibleMessage(which: "studio-older" | "plugin-older"): string {
  return which === "studio-older"
    ? `This Studio speaks an older API. Update the Studio (it needs ${MIN_STUDIO_VERSION} or later). Nothing was sent.`
    : "This Studio speaks a newer API than this plugin. Update the plugin. Nothing was sent.";
}

export type VersionVerdict =
  /** The manifest names a Blygger Studio. */
  | { kind: "stock"; version: string }
  /** The manifest does not name a Blygger Studio (a fork, another program, or no `generator`). */
  | { kind: "unknown-client"; generator: string };

/** `generator` as the manifest announces it: "blygger-studio/0.51.0". */
export function studioVersionVerdict(generator: string): VersionVerdict {
  const match = /^blygger-studio\/(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(generator.trim());
  if (!match) return { kind: "unknown-client", generator: generator.slice(0, 60) };
  return { kind: "stock", version: `${match[1]}.${match[2]}.${match[3]}` };
}
