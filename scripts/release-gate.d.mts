export const MAX_AGE_DAYS: number;
export const REQUIRED_JOBS: string[];
export const NEWEST_JOB: string;
export const PREVIEW_RE: RegExp;
export const ACCEPT_RE: RegExp;
export interface CheckRun { name: string; status: string; conclusion: string | null; id: number }
export interface GateComment { user?: { login?: string }; author_association?: string; body?: string | null; created_at: string }
export interface GateInput {
  mode: "release" | "dry-run"; version: string; headSha: string; headTree: string; expectedSha: string; owner: string; now: Date;
  pr: { number: number; title: string; merged_at?: string | null; merge_commit_sha?: string | null } | null;
  comments: GateComment[];
  commits: Record<string, { tree: string; checks: CheckRun[] }>;
}
export function releaseGate(i: GateInput): { ok: boolean; problems: string[]; notes: string[] };
