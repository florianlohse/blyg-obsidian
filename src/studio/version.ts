// Which Studio this plugin speaks to. Since S16 (docs/plans/S16-contract-5.md) the gate is the API contract the Studio announces in
// `GET /api/capabilities` (`contractVersion`), not the release number: one hard cutover, no support for older contracts.
// The manifest's `generator` is only used to tell a stock Studio from a fork or another program.

/**
 * The contracts this plugin speaks: the major versions 5 and 6 (E1). Contract 6.0.0 (Studio 0.67.0) is breaking only by removing `GET /changes`
 * (two syndication operations are new); 5.14 to 6.2 otherwise only adds. Whatever differs between the two is chosen from what the Studio's
 * `GET /capabilities` lists in `operations` (see capabilities.ts), never from the version string. The gate itself still reads the major: older than 5
 * and a major the plugin has not seen are refused, because nothing is known about them.
 */
export const SUPPORTED_MAJORS = { min: 5, max: 6 } as const;
/**
 * The newest minor of each supported major that the plugin was checked against, by the operation diff of every operation it calls (the vendored
 * 0.51.0 file against 0.69.0's, tests/studio/operations.test.ts) and, for 6.2, against a live Studio 0.69.0. 5.14 is the last 5.x (Studio 0.65.0).
 * The end-to-end run on contract 5 is against the pinned 0.51.0 (5.2.0).
 */
export const TESTED_MINOR: Readonly<Record<number, number>> = { 5: 14, 6: 2 };
/** "6.2": the newest contract the plugin was tested with, for messages. */
export const CONTRACT_TEXT = `${SUPPORTED_MAJORS.max}.${TESTED_MINOR[SUPPORTED_MAJORS.max]}`;
/** A newer minor of a supported major is accepted, so it is a muted note, not a warning. */
export const newerMinorNote = (announced: string): string => {
  const major = Number(announced.split(".")[0]);
  return `Studio API ${announced} is newer than the ${major}.${TESTED_MINOR[major] ?? 0} this plugin was tested with. Newer minor versions only add things and are accepted.`;
};
/** The first Studio release that speaks contract 5. */
export const MIN_STUDIO_VERSION = "0.51.0";

export type ContractVerdict =
  /**
   * Supported. `newerMinor`: the Studio announces a higher minor than the plugin was tested with for that major (shown, not refused).
   * `operations`: the operation ids the Studio listed in `GET /capabilities` (for this token), or null when it listed none the plugin could read.
   */
  | { kind: "ok"; contract: string; major: number; newerMinor: boolean; operations: ReadonlySet<string> | null }
  /** An older contract, or no `/capabilities` at all (a Studio before 0.49.7): every Studio write is refused. */
  | { kind: "studio-older"; contract: string | null }
  /** A major the plugin does not know: the plugin is the old one. */
  | { kind: "plugin-older"; contract: string };

/** `contractVersion` as the Studio announces it ("6.2.0"), or null when there is none or it is not major.minor.patch. `operations`: its `operations` list. */
export function contractVerdict(version: string | null, operations: readonly string[] | null = null): ContractVerdict {
  const match = version === null ? null : /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return { kind: "studio-older", contract: null };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const contract = `${match[1]}.${match[2]}.${match[3]}`;
  if (major < SUPPORTED_MAJORS.min) return { kind: "studio-older", contract };
  if (major > SUPPORTED_MAJORS.max) return { kind: "plugin-older", contract };
  return { kind: "ok", contract, major, newerMinor: minor > (TESTED_MINOR[major] ?? 0), operations: operations === null ? null : new Set(operations) };
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
