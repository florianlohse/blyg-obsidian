export const RELEASE_TITLE: RegExp;
export interface PlanInput { sha: string; prs: { number: number; title: string; body?: string | null; merged_at?: string | null; merge_commit_sha?: string | null }[]; manifestVersion: string; changelog: string }
export type Plan = { release: false; reason: string } | { release: true; version: string; pr: number } | { release: false; problems: string[] };
export function releasePlan(i: PlanInput): Plan;
