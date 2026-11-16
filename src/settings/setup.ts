// First-run setup, as the settings' Setup check and the connection-check rows use it. Pure.
import type { BlygSettings } from "./schema";
import type { SettingsIssue } from "./validate";

export interface SetupProgress {
  /** Nothing is connected yet: no Studio address, or no keychain entry for its token. Then the four steps are said in order. */
  connecting: boolean;
  /** Per step (address, create a token, keychain entry, check connection): done. Only the address is known here: a keychain entry's name has a default, and whether the entry holds a token is not known until Check connection. */
  done: boolean[];
  /** The errors that are not about connecting (routes, caps…), still listed as they were. */
  errors: SettingsIssue[];
}

const missing = (issues: SettingsIssue[], field: string): boolean => issues.some((i) => i.severity === "error" && i.field === field && i.message.startsWith("Required"));

export function setupProgress(issues: SettingsIssue[]): SetupProgress {
  const noAddress = missing(issues, "studio.baseUrl");
  const noEntry = missing(issues, "studio.tokenSecretName");
  const errors = issues.filter((i) => i.severity === "error");
  const connecting = noAddress || noEntry;
  return { connecting, done: [!noAddress, false, false, false], errors: connecting ? errors.filter((i) => i.field !== "studio.baseUrl" && i.field !== "studio.tokenSecretName") : errors };
}

/**
 * What a connection result belongs to: the check's name and the settings it tests (the Studio's address, mount and keychain entry; the GitHub owner,
 * repository and entry). A result is shown again only while this is unchanged. The token itself is never part of it (only the entry's name).
 */
export function connectionCheckKey(s: BlygSettings, name: string): string {
  return JSON.stringify([name, s.studio.baseUrl, s.studio.mount, s.studio.tokenSecretName, s.github.owner, s.github.repo, s.github.tokenSecretName]);
}
