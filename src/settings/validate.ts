import { CONTRACT_ITEMS_DIR, CONTRACT_MAX_FRAGMENT_CAP } from "../contract";
import { checkWebAddress } from "../core/webAddress";
import { studioBaseProblem, studioMountProblem } from "../studio/address";
import type { BlygSettings } from "./schema";
import { githubInUse } from "./studioOnly";

export interface SettingsIssue {
  /** Dotted path of the offending field, e.g. "routes[1].vaultPrefix". */
  field: string;
  message: string;
  /** "error": publishing is not safe until fixed. "warning": allowed, but probably not what you want. */
  severity: "error" | "warning";
}

const OWNER_REPO = /^[A-Za-z0-9._-]+$/;
const SECRET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Problems the settings tab shows next to the fields. An empty list means the settings are usable for publishing. */
export function validateSettings(s: BlygSettings): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message, severity: "error" });
  const warn = (field: string, message: string) => issues.push({ field, message, severity: "warning" });

  // GitHub is only needed when something commits to a site repository (a Blyg or Plain route) or the user has started to set it up:
  // a Studio-only setup is complete without any of it (studioOnly.ts).
  if (githubInUse(s)) {
    if (!s.github.owner) add("github.owner", "Required.");
    else if (!OWNER_REPO.test(s.github.owner)) add("github.owner", "Use the account name only, e.g. “octocat”.");
    if (!s.github.repo) add("github.repo", "Required.");
    else if (!OWNER_REPO.test(s.github.repo)) add("github.repo", "Use the repository name only, without the owner.");
    if (!s.github.branch) add("github.branch", "Required.");
    if (!s.github.previewBranch) add("github.previewBranch", "Required.");
    if (s.github.branch && s.github.branch === s.github.previewBranch) {
      add("github.previewBranch", "Must differ from the production branch.");
    }
  }
  if (s.github.tokenSecretName && !SECRET_NAME.test(s.github.tokenSecretName)) {
    add("github.tokenSecretName", "Keychain names use lowercase letters, digits and dashes.");
  }

  for (const key of ["origin", "previewOrigin"] as const) {
    const v = s.blyg[key];
    if (v === "") continue;
    if (!isHttpsUrl(v)) add(`blyg.${key}`, "Must be an https:// address.");
    else if (!v.endsWith("/")) add(`blyg.${key}`, "Must end with “/”.");
  }
  if (!s.blyg.itemsDir || s.blyg.itemsDir.startsWith("/") || s.blyg.itemsDir.endsWith("/")) {
    add("blyg.itemsDir", "A repo folder without leading or trailing “/”.");
  }
  if (s.blyg.fragmentCharCap < 1) add("blyg.fragmentCharCap", "Must be at least 1.");
  else if (s.blyg.fragmentCharCap > CONTRACT_MAX_FRAGMENT_CAP) {
    add(
      "blyg.fragmentCharCap",
      `Above the ${CONTRACT_MAX_FRAGMENT_CAP} characters the site accepts: a longer fragment would be committed and then fail the site's build. The plugin enforces ${CONTRACT_MAX_FRAGMENT_CAP} regardless.`,
    );
  }
  if (s.blyg.itemsDir !== CONTRACT_ITEMS_DIR && s.blyg.itemsDir !== "") {
    warn("blyg.itemsDir", `The site contract expects Blyg items in “${CONTRACT_ITEMS_DIR}”. Change this only if your site differs.`);
  }

  if (s.routes.length === 0) add("routes", "Add at least one route, otherwise nothing can be published.");
  s.routes.forEach((r, i) => {
    const at = `routes[${i}]`;
    if (!r.vaultPrefix) add(`${at}.vaultPrefix`, "Required.");
    else if (!r.vaultPrefix.endsWith("/")) add(`${at}.vaultPrefix`, "Must end with “/”.");
    else if (r.vaultPrefix.startsWith("/")) add(`${at}.vaultPrefix`, "Vault-relative: no leading “/”.");
    if (!r.label.trim()) add(`${at}.label`, "Required.");
    if (r.mode === "plain") {
      if (!r.dest) add(`${at}.dest`, "A plain route needs a repo destination folder.");
      else if (!r.dest.endsWith("/") || r.dest.startsWith("/")) {
        add(`${at}.dest`, "Repo folder ending with “/”, no leading “/”.");
      } else if (`${r.dest}`.startsWith(`${s.blyg.itemsDir}/`) || `${r.dest}` === `${s.blyg.itemsDir}/`) {
        add(`${at}.dest`, "A plain route may never write into the Blyg items folder.");
      }
    }
  });

  // A Studio route needs a Studio to publish to. Only checked when a route uses it: the Studio block is optional otherwise.
  const usesStudio = s.routes.some((r) => r.mode === "studio");
  if (s.studio.baseUrl !== "" || usesStudio) {
    if (s.studio.baseUrl === "") add("studio.baseUrl", "Required: a route publishes to a Studio.");
    else {
      const problem = studioBaseProblem(s.studio.baseUrl);
      if (problem) add("studio.baseUrl", problem);
    }
    const mountProblem = studioMountProblem(s.studio.mount);
    if (mountProblem) add("studio.mount", mountProblem);
    if (s.studio.tokenSecretName && !SECRET_NAME.test(s.studio.tokenSecretName)) {
      add("studio.tokenSecretName", "Keychain names use lowercase letters, digits and dashes.");
    } else if (usesStudio && !s.studio.tokenSecretName) add("studio.tokenSecretName", "Required: pick or create the keychain entry that holds the Studio token.");
    if (usesStudio && s.studio.tokenSecretName && s.studio.tokenSecretName === s.github.tokenSecretName) {
      add("studio.tokenSecretName", "Must differ from the GitHub token's entry: they are two different secrets.");
    }
  }

  s.routes.forEach((r, i) => {
    if (r.mode !== "plain" || !r.webUrl) return;
    const problem = checkWebAddress(r.webUrl);
    // Only the button depends on it, so this is a warning: publishing stays possible.
    if (problem) warn(`routes[${i}].webUrl`, problem);
  });

  // A template inside a publish folder is itself a note the plugin would offer to publish.
  for (const key of ["fragment", "thread"] as const) {
    const path = s.templates[key].trim().replace(/^\/+/, "");
    if (path === "") continue;
    const inside = s.routes.find((r) => r.vaultPrefix !== "" && path.startsWith(r.vaultPrefix));
    if (inside) warn(`templates.${key}`, `This note is inside the publish folder “${inside.vaultPrefix}”. Keep templates outside it, or the template itself can be published.`);
  }

  // Overlapping prefixes would make route matching ambiguous.
  for (let i = 0; i < s.routes.length; i++) {
    for (let j = i + 1; j < s.routes.length; j++) {
      const a = s.routes[i]?.vaultPrefix;
      const b = s.routes[j]?.vaultPrefix;
      if (!a || !b) continue;
      if (a.startsWith(b) || b.startsWith(a)) {
        add(`routes[${j}].vaultPrefix`, `Overlaps route ${i + 1} (“${a}”). Routes must not contain each other.`);
      }
    }
  }

  return issues;
}

const FIELD_LABELS: Record<string, string> = {
  "github.owner": "Owner",
  "github.repo": "Repository",
  "github.branch": "Production branch",
  "github.previewBranch": "Preview branch",
  "github.tokenSecretName": "GitHub token",
  "blyg.origin": "Blyg address",
  "blyg.previewOrigin": "Preview blyg address",
  "blyg.itemsDir": "Items folder",
  "blyg.fragmentCharCap": "Fragment character cap",
  "studio.baseUrl": "Studio address",
  "studio.mount": "Studio mount",
  "studio.tokenSecretName": "Studio token",
  "templates.fragment": "Fragment template",
  "templates.thread": "Thread template",
  routes: "Routes",
};

const ROUTE_FIELD_LABELS: Record<string, string> = {
  vaultPrefix: "Vault folder",
  label: "Label",
  dest: "Repository folder",
  webUrl: "Web address",
};

/** The name a field has on the settings screen, for messages: "routes[1].vaultPrefix" → "Route 2 · Vault folder". */
export function describeField(field: string): string {
  const route = /^routes\[(\d+)\]\.(\w+)$/.exec(field);
  if (route) {
    const name = ROUTE_FIELD_LABELS[route[2] as string] ?? route[2];
    return `Route ${Number(route[1]) + 1} · ${name}`;
  }
  return FIELD_LABELS[field] ?? field;
}
