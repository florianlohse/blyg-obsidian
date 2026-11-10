export const STABLE_RE: RegExp;
export function checkRelease(dir: string, opts: { mode: "dry-run" | "release"; latest?: string }): { errors: string[]; warnings: string[] };
