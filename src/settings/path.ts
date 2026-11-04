// Dotted-key access into the settings object, for the declarative settings tab ("github.owner", "routes.1.dest").

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

type Node = Record<string, unknown> | unknown[];

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;

function segments(key: string): string[] | null {
  const parts = key.split(".");
  return parts.some((p) => p === "" || FORBIDDEN.has(p)) ? null : parts;
}

/** The value at `key`, or undefined if any step is missing. */
export function getPath(root: unknown, key: string): unknown {
  const parts = segments(key);
  if (!parts) return undefined;
  let cur: unknown = root;
  for (const part of parts) {
    if (!isNode(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Set the value at `key`. Only walks objects and arrays that already exist and never touches the prototype chain.
 * Returns false (and changes nothing) if the path is invalid.
 */
export function setPath(root: unknown, key: string, value: unknown): boolean {
  const parts = segments(key);
  if (!parts) return false;
  const last = parts[parts.length - 1] as string;
  let cur: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (!isNode(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (!isNode(cur)) return false;
  (cur as Record<string, unknown>)[last] = value;
  return true;
}
